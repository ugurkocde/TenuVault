import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AddPermissions } from "../../src/renderer/components/AddPermissions"
import type { PermissionAdditionPreview, PermissionAdditionResult } from "../../src/shared/registration-additions"
const mock = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn(), cancel: vi.fn(async () => {}) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { services: { previewAddition: mock.preview, confirmAddition: mock.confirm, cancelAddition: mock.cancel } } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const preview: PermissionAdditionPreview = { id: "receipt", tenantId: "tenant", clientId: "client", displayName: "Contoso Backup", declare: ["Policy.Read.All"], consent: ["Policy.Read.All"], declared: ["graph/Scope/held"], consented: ["User.Read"] }
const result: PermissionAdditionResult = { state: "complete", preview, declared: ["Policy.Read.All"], consented: ["Policy.Read.All"], missingDeclarations: [], missingConsent: [], message: "The approved permissions are declared and consented." }
let root: Root
let container: HTMLDivElement
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(b => b.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
beforeEach(() => { vi.clearAllMocks(); mock.preview.mockResolvedValue(preview); mock.confirm.mockResolvedValue(result); container = document.body.appendChild(document.createElement("div")); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
async function render() { await act(async () => root.render(createElement(AddPermissions, { tenantId: "tenant", clientId: "client", missing: ["Policy.Read.All"] }))); await click("Add in the app") }
it("names roles and privileged sign-in before showing the identity and exact difference for approval", async () => {
  await render()
  expect(document.body.textContent).toContain("Cloud Application Administrator")
  expect(document.body.textContent).toContain("Application.ReadWrite.All and DelegatedPermissionGrant.ReadWrite.All")
  expect(mock.preview).not.toHaveBeenCalled()
  await click("Sign in to preview")
  expect(mock.preview).toHaveBeenCalledExactlyOnceWith("tenant", ["Policy.Read.All"])
  expect(document.body.textContent).toContain("Contoso Backup")
  expect(document.body.textContent).toContain("Permissions to declare")
  expect(mock.confirm).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain("offers no documented conditional update")
  expect(document.body.textContent).toContain("A change by someone else in the same second can be lost")
  expect(document.body.textContent).toContain("reads again right before writing")
  await click("Add approved permissions")
  expect(mock.confirm).toHaveBeenCalledExactlyOnceWith("tenant", "receipt")
  expect(document.body.textContent).toContain("Verified consent additions")
})
it.each(["partial", "changed"] as const)("reports %s accurately and offers the other routes", async state => {
  mock.confirm.mockResolvedValue({ ...result, state, missingConsent: ["Policy.Read.All"] })
  await render(); await click("Sign in to preview"); await click("Add approved permissions")
  expect(document.body.textContent).toContain(state === "partial" ? "Permissions partly added" : "Changed since the preview")
  expect(document.body.textContent).toContain("Azure CLI commands")
  if (state === "changed") { expect(document.body.textContent).toContain("Current tenant-wide Graph consent"); expect(document.body.textContent).toContain("graph/Scope/held") }
  else expect(document.body.textContent).toContain("Consent still missing or unverified")
  expect([...document.querySelectorAll("button")].some(b => b.textContent === "Add approved permissions")).toBe(false)
})
it("shows a refusal without an approval button and keeps other routes available", async () => {
  mock.preview.mockRejectedValue(new Error("This registration has credentials."))
  await render(); await click("Sign in to preview")
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("credentials")
  expect(document.body.textContent).toContain("copy the text for your administrator")
  await click("Close")
  expect(mock.cancel).toHaveBeenCalledWith("tenant")
})
it("discards a late preview after Cancel and allows a fresh start", async () => {
  let finish!: (value: PermissionAdditionPreview) => void
  mock.preview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await render(); await click("Sign in to preview"); await click("Cancel")
  await act(async () => finish(preview))
  await click("Add in the app")
  expect(document.body.textContent).not.toContain("Contoso Backup")
  await click("Sign in to preview")
  expect(document.body.textContent).toContain("Contoso Backup")
})
it("keeps a write result on screen until verification finishes", async () => {
  let finish!: (value: PermissionAdditionResult) => void
  mock.confirm.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await render(); await click("Sign in to preview"); await click("Add approved permissions")
  expect([...document.querySelectorAll("button")].find(b => b.textContent === "Close")?.disabled).toBe(true)
  expect(document.body.textContent).toContain("verifying access")
  await act(async () => finish(result))
  expect(document.body.textContent).toContain("Permission result")
})
