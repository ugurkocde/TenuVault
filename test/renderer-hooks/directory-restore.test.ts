import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { DirectoryRestore } from "../../src/portal/components/backup/directory-restore"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const tenant = { name: "Contoso", credentials: { tenantId: "tenant", appId: "app", clientSecret: "placeholder" }, storageAccountName: "local" }
const button = (name: string) => [...document.querySelectorAll("button")].find(item => item.textContent === name)!
const props = { tenant, backupId: "backup", path: "backup/Groups/group.json" }
const page = { runId: "run", fingerprint: "bound", more: true, rows: [{ key: "member", review: { principal: { id: "p", name: "Member", type: "user" }, resource: { id: "g", name: "Team", type: "group" }, privilege: "member", scope: "tenant/group/g", approvals: ["directory-item", "security-response"], notices: ["The current state looks deliberate."], changes: [{ property: "present", before: false, after: true }], roleAssignable: false } }] }
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals() })
const click = async (name: string) => act(async () => button(name).click())
it("shows who gets what and requires each approval before sending its saved page", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "preview" ? page : { status: "complete", replacedReferences: [{ path: "DeviceConfigurations/p", property: "groupId", mapping: { kind: "objectId", folder: "Groups", source: "old", target: "new" } }] }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(document.body.textContent).toContain("Member (user): member on Team (group)")
  expect(document.body.textContent).toContain("Current: false")
  expect(document.body.textContent).toContain("More changes remain")
  expect((button("Execute approved changes or resume page") as HTMLButtonElement).disabled).toBe(true)
  const checks = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  await act(async () => checks[0]!.click())
  expect((button("Execute approved changes or resume page") as HTMLButtonElement).disabled).toBe(true)
  await act(async () => checks[1]!.click())
  await click("Execute approved changes or resume page")
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ action: "restore", runId: "run", fingerprint: "bound", approvals: { member: ["directory-item", "security-response"] }, exactMembers: false, exactOwners: false })
  expect(document.body.textContent).toContain("Directory page completed")
  expect(document.body.textContent).toContain("DeviceConfigurations/p, groupId. Old ID: old. New ID: new.")
})
it("invalidates the preview when the per-group exact choice changes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(page)))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore")
  await act(async () => { const select = document.querySelector("select")!; select.value = "relationships"; select.dispatchEvent(new Event("change", { bubbles: true })) })
  await click("Preview directory changes")
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  expect(button("Execute approved changes or resume page")).toBeUndefined()
})
it("drops a late preview after unmount", async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => root.unmount())
  await act(async () => resolve(Response.json(page)))
  expect(document.body.textContent).toBe("")
})
