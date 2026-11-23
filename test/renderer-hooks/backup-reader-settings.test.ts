import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import type { BackupReaderState } from "../../src/shared/ipc"

vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [
    { id: 1, name: "Contoso", credentials: { tenantId: "contoso" } },
    { id: 2, name: "Fabrikam", credentials: { tenantId: "fabrikam" } },
  ],
}))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmDialog: null }) }))
const status = vi.hoisted(() => vi.fn())
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { app: {}, backupReader: { status } } }))

import { BackupReaderSettings } from "../../src/renderer/components/BackupReaderSettings"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it("names the configured services for the selected tenant, including Conditional Access by itself", async () => {
  const state = (services: BackupReaderState["services"]): BackupReaderState => ({ supported: true, available: true, reader: null, setupArguments: "", services })
  let finish!: (value: BackupReaderState) => void
  status.mockImplementation((tenant: string) => tenant === "contoso"
    ? Promise.resolve(state(["conditionalAccess", "defender"]))
    : new Promise<BackupReaderState>(resolve => { finish = resolve }))
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(BackupReaderSettings)))
    expect(container.textContent).toContain("This tenant backs up Defender and Entra ID (Conditional Access only).")
    const select = container.querySelector("select")!
    await act(async () => {
      select.value = "fabrikam"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(container.textContent).not.toContain("This tenant backs up")
    await act(async () => finish(state(["intune", "entra", "defender"])))
    expect(container.textContent).toContain("This tenant backs up Defender, Entra ID, and Intune.")
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
