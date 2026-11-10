import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import { TRIAL_USED_MESSAGE } from "../../src/shared/constants"

const state = vi.hoisted(() => ({ setKey: vi.fn(), open: vi.fn(async () => undefined), external: vi.fn(async () => undefined) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { license: { setKey: state.setKey, open: state.open, clipboardKey: async () => null }, app: { openExternal: state.external } } }))
vi.mock("../../src/renderer/lib/license", async original => ({ ...(await original<typeof import("../../src/renderer/lib/license")>()), useLicense: () => ({ status: null, refresh: async () => undefined }) }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [], useTenantOperations: () => ({}) }))
import { LicenseKeyEntry } from "../../src/renderer/components/PlanChoice"
import { Toaster, toast } from "../../src/renderer/lib/toast"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
async function render(element: ReturnType<typeof createElement>) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(createElement(MemoryRouter, null, element)))
}
afterEach(() => {
  act(() => { for (const button of container.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss"]')) button.click() })
  act(() => root.unmount()); container.remove(); vi.clearAllMocks()
})
const buy = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Buy Pro")!

it("offers purchasing help in a key entry error without submitting the key again", async () => {
  state.setKey.mockRejectedValue(new Error(TRIAL_USED_MESSAGE))
  await render(createElement(LicenseKeyEntry))
  const input = container.querySelector("input")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "TENU-TRIAL-KEY-0001")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(TRIAL_USED_MESSAGE)
  expect(buy()).toBeTruthy()
  expect(container.querySelector('a[href^="mailto:support@tenuvault.com"]')).toBeTruthy()
  await act(async () => buy().click())
  expect(state.open).toHaveBeenCalledWith("checkout", { source: "key-entry-trial-key-refused" })
  expect(state.setKey).toHaveBeenCalledOnce()
})

it("shows the same actions in a copied-key error toast with surrounding context", async () => {
  await render(createElement(Toaster))
  await act(async () => toast(`${TRIAL_USED_MESSAGE} Enter the key on the License page.`, "error"))
  expect(buy()).toBeTruthy()
  const mailto = container.querySelector<HTMLAnchorElement>('a[href^="mailto:support@tenuvault.com"]')!
  expect(mailto.href).toBe("mailto:support@tenuvault.com?subject=TenuVault%20Pro%3A%20quote%20or%20invoice")
  expect(container.textContent).not.toContain("Extend your trial")
  await act(async () => { buy().click(); mailto.click() })
  expect(state.external).toHaveBeenCalledWith(mailto.href)
})
