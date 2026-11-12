import { act, createElement, Fragment } from "react"
import { createRoot } from "react-dom/client"
import { Link, MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import type { LicenseStatus } from "../../src/shared/ipc"
import { CommunityChoiceBanner, CommunityTenantPicker } from "../../src/renderer/components/CommunityTenantPicker"
import LicensePage from "../../src/renderer/pages/LicensePage"

const state = vi.hoisted(() => ({ choices: ["contoso", "fabrikam"], pending: ["contoso", "fabrikam"], choose: vi.fn(async (_id: string) => undefined), retry: vi.fn(async (_id: string) => undefined), refresh: vi.fn(async () => undefined), open: vi.fn(async () => undefined) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { license: { chooseCommunity: state.choose, retry: state.retry, refresh: async () => undefined, open: state.open } } }))
vi.mock("../../src/renderer/lib/license", async (original) => ({ ...await original<typeof import("../../src/renderer/lib/license")>(), useLicense: () => ({ status: { hasKey: true, keyState: "failed", persisted: true, tenants: [], communityChoiceTenantIds: state.choices, communityChoicePendingTenantIds: state.pending } as unknown as LicenseStatus, refresh: state.refresh }) }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ selectedTenantId: null, selectedTenant: undefined, setSelectedTenantId: () => {} }), useTenants: () => [{ name: "Contoso", credentials: { tenantId: "contoso" } }, { name: "Fabrikam", credentials: { tenantId: "fabrikam" } }] }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
vi.mock("@desktop/components/LicenseAgreementDialog", () => ({ LicenseAgreementLink: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let cleanup = () => {}
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.clearAllMocks(); state.retry.mockReset(); state.retry.mockResolvedValue(undefined); state.choices = ["contoso", "fabrikam"]; state.pending = ["contoso", "fabrikam"] })

function render() {
  const root = createRoot(document.body.appendChild(document.createElement("div")))
  cleanup = () => act(() => root.unmount())
  const rerender = () => act(() => root.render(createElement(MemoryRouter, { initialEntries: ["/portal/overview"] }, createElement(Fragment, null,
    createElement(CommunityChoiceBanner),
    createElement(Routes, null, createElement(Route, { path: "/license", element: createElement(LicensePage) }), createElement(Route, { path: "/portal/overview", element: createElement(Link, { to: "/license" }, "License page") })),
    createElement(CommunityTenantPicker),
  ))))
  rerender()
  return { rerender }
}
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll("button")].find(button => button.textContent === text)!
const dialog = () => document.querySelector('[role="dialog"]')!

it("explains the final choice and persists only the selected tenant", async () => {
  render()
  expect(dialog().textContent).toContain("This choice is final")
  expect(dialog().textContent).toContain("Backups of the other tenants are kept")
  await act(async () => button("Fabrikam").click())
  expect(state.choose).toHaveBeenCalledExactlyOnceWith("fabrikam")
  expect(state.refresh).toHaveBeenCalledTimes(1)
})

it.each(["Decide later", "Close", "Escape", "outside"])("dismisses with %s without choosing and reopens only when asked", async (method) => {
  const { rerender } = render()
  await act(async () => {
    if (method === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    else if (method === "outside") {
      await new Promise(resolve => setTimeout(resolve, 0))
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }))
      document.body.click()
    } else button(method, dialog()).click()
  })
  expect(dialog()).toBeNull()
  expect(state.choose).not.toHaveBeenCalled()
  expect(state.pending).toEqual(["contoso", "fabrikam"])
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Choose which tenant continues on Community. Backups are paused until you choose.")
  state.pending = [...state.pending]
  rerender()
  expect(dialog()).toBeNull()
  await act(async () => document.querySelector<HTMLAnchorElement>("a")!.click())
  expect(dialog()).toBeNull()
  expect(button("Choose tenant")).toBeDefined()
  await act(async () => button("Choose tenant").click())
  expect(dialog()).not.toBeNull()
})

it("opens the License page without a modal so buying and entering a key work", async () => {
  render()
  await act(async () => button("Add a license instead").click())
  expect(dialog()).toBeNull()
  expect(button("Buy Pro").disabled).toBe(false)
  await act(async () => button("Buy Pro").click())
  expect(state.open).toHaveBeenCalled()
  await act(async () => button("Enter a new key").click())
  const input = document.querySelector<HTMLInputElement>("#replacement-key")!
  expect(input.disabled).toBe(false)
  act(() => input.focus())
  expect(document.activeElement).toBe(input)
  const pageButton = [...document.querySelectorAll("button")].filter(button => button.textContent === "Choose tenant").at(-1)!
  await act(async () => pageButton.click())
  expect(dialog()).not.toBeNull()
})

it.each(["uncovered", "paid"])("retries unchecked coverage in place when the result is %s", async (result) => {
  state.choices = ["contoso"]
  const { rerender } = render()
  expect(dialog().textContent).toContain("Coverage could not be checked")
  expect(button("Fabrikam", dialog())).toBeUndefined()
  state.retry.mockImplementation(async () => {
    if (result === "paid") state.pending = ["contoso"]
    else state.choices = ["contoso", "fabrikam"]
  })
  await act(async () => button("Retry", dialog()).click())
  rerender()
  expect(state.retry).toHaveBeenCalledExactlyOnceWith("fabrikam")
  expect(state.choose).not.toHaveBeenCalled()
  expect(state.refresh).toHaveBeenCalledTimes(1)
  if (result === "paid") expect(dialog()).toBeNull()
  else { expect(button("Fabrikam", dialog())).toBeDefined(); expect(dialog().textContent).not.toContain("Coverage could not be checked") }
})

it("closes after the pending tenants are removed", () => {
  const { rerender } = render()
  state.pending = []
  rerender()
  expect(dialog()).toBeNull()
  expect(document.querySelector('[role="status"]')).toBeNull()
})


it("opens once again when the app starts a new session", async () => {
  render()
  await act(async () => button("Decide later").click())
  expect(dialog()).toBeNull()
  cleanup()
  render()
  expect(dialog()).not.toBeNull()
  expect(state.choose).not.toHaveBeenCalled()
})
