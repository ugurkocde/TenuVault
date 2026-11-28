import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { ConfigurationRestore } from "../../src/portal/components/backup/configuration-restore"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const tenant = { name: "Contoso", credentials: { tenantId: "tenant", appId: "app", clientSecret: "placeholder" }, storageAccountName: "local" }
const button = (name: string) => [...document.querySelectorAll("button")].find(item => item.textContent === name)!
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals() })
it("shows the exact difference and sends a separate confirmation bound to the preview", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "preview" ? { runId: "run", fingerprint: "fingerprint", kind: "authentication", changes: [{ property: "selfServiceSignUp", before: { isEnabled: true }, after: { isEnabled: false } }] } : { success: true }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(ConfigurationRestore, { tenant, backupId: "backup", path: "backup/AuthenticationFlowsPolicy/Flows.json", singleton: true })))
  await act(async () => button("Review this configuration").click())
  expect(document.querySelector("select")).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
  await act(async () => button("Preview exact changes").click())
  expect(document.body.textContent).toContain('Current: {"isEnabled":true}')
  expect(document.body.textContent).toContain('Restore: {"isEnabled":false}')
  await act(async () => button("Confirm and restore this policy").click())
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ action: "restore", runId: "run", fingerprint: "fingerprint", operation: "update", allowRemoval: false })
  expect(document.body.textContent).toContain("Restore completed")
})
it("drops a late preview after unmount and reports a refused request inline", async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(ConfigurationRestore, { tenant, backupId: "backup", path: "backup/AuthenticationFlowsPolicy/Flows.json", singleton: true })))
  await act(async () => button("Review this configuration").click())
  await act(async () => button("Preview exact changes").click())
  await act(async () => root.unmount())
  await act(async () => resolve(Response.json({ error: "Tenant changed" }, { status: 409 })))
  expect(document.body.textContent).toBe("")
})

it("names the username-hint scope before previewing a company branding backup", async () => {
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(ConfigurationRestore, { tenant, backupId: "backup", path: "backup/EntraCompanyBranding/Branding.json", singleton: true })))
  await act(async () => button("Review this configuration").click())
  expect(document.body.textContent).toContain("Only the default username hint is restored")
  expect(document.body.textContent).toContain("Other branding properties and localizations stay as configured")
})
