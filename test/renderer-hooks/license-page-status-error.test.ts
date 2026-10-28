import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  error: null as string | null,
  refreshStatus: vi.fn(async () => undefined as void),
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { license: { refresh: async () => { throw new Error("offline") } } },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: null, error: state.error, refresh: state.refreshStatus }),
}))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [] }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
vi.mock("@desktop/components/LicenseAgreementDialog", () => ({ LicenseAgreementLink: () => null }))

import LicensePage from "../../src/renderer/pages/LicensePage"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  state.error = null
})

async function renderPage(): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, null, createElement(LicensePage))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

describe("License page status read failure", () => {
  it("shows the error with a retry instead of loading forever", async () => {
    state.error = "The license check did not respond. Try again."
    state.refreshStatus = vi.fn(async () => { throw new Error(state.error!) })
    const container = await renderPage()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The license check did not respond")
    const calls = state.refreshStatus.mock.calls.length
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")
    await act(async () => { retry!.click() })
    expect(state.refreshStatus.mock.calls.length).toBe(calls + 1)
  })

  it("keeps the spinner while the first read is still running", async () => {
    state.refreshStatus = vi.fn(async () => undefined)
    const container = await renderPage()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector(".animate-spin")).not.toBeNull()
  })
})
