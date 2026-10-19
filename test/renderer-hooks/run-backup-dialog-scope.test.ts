import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackupScope } from "../../src/shared/intune/scope"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({ scope: vi.fn() }))

vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { backups: { scope: state.scope } } }))
vi.mock("~/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children)
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? createElement("div", null, children) : null),
    DialogContent: pass, DialogDescription: pass, DialogHeader: pass, DialogTitle: pass,
  }
})
vi.mock("../../src/renderer/components/BackupScopePicker", () => ({
  BackupScopePicker: ({ value }: { value: BackupScope }) => createElement("p", { "data-scope": "" }, value.excluded.join(",")),
}))

import { RunBackupDialog, type BackupTarget } from "../../src/renderer/components/RunBackupDialog"

const target = (tenantId: string): BackupTarget => ({ name: tenantId, credentials: { tenantId, appId: "app" }, storageAccountName: "tvlocal" })

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  state.scope.mockReset()
})

function mount() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const render = (open: boolean, tenant: BackupTarget) =>
    act(() => root.render(createElement(RunBackupDialog, { open, onOpenChange: () => undefined, tenant, onStarted: () => undefined })))
  return { container, render }
}

describe("Run backup dialog scope read", () => {
  it("shows the failure with a retry instead of loading forever", async () => {
    state.scope.mockRejectedValueOnce(new Error("IPC failed"))
    const { container, render } = mount()
    render(true, target("tenant-a"))
    await act(async () => undefined)
    expect(container.querySelector("[role=alert]")?.textContent).toContain("IPC failed")
    expect(container.textContent).not.toContain("Loading this tenant's backup settings")

    state.scope.mockResolvedValueOnce({ scope: { excluded: ["apps"] } })
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")
    await act(async () => { retry!.click() })
    expect(container.querySelector("[data-scope]")?.textContent).toBe("apps")
  })

  it("ignores a late scope read for the tenant the dialog was opened for before", async () => {
    let resolveA: (value: { scope: BackupScope }) => void = () => undefined
    state.scope.mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve }))
    state.scope.mockImplementationOnce(() => new Promise(() => undefined))
    const { container, render } = mount()
    render(true, target("tenant-a"))
    render(false, target("tenant-a"))
    render(true, target("tenant-b"))
    await act(async () => resolveA({ scope: { excluded: ["scope-of-a"] } }))
    expect(container.querySelector("[data-scope]")).toBeNull()
    expect(container.textContent).toContain("Loading this tenant's backup settings")
  })
})
