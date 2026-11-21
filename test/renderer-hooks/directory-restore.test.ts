import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { DirectoryRestore } from "../../src/portal/components/backup/directory-restore"
const accounts = vi.hoisted(() => ({ changed: null as null | ((tenantId: string) => void) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { auth: { onAccountsChanged: (listener: (tenantId: string) => void) => { accounts.changed = listener; return () => { accounts.changed = null } } } } }))
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
it("shows staged application risks without offering execution or exact-owner removals", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page, more: false, rows: [{ ...page.rows[0], review: { ...page.rows[0]!.review, blocker: "Phase 2 evidence is required." } }] })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { ...props, path: "backup/Applications/app.json" })))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(document.body.textContent).toContain("breaks every client")
  expect(document.body.textContent).toContain("SAML signing keys")
  expect(document.body.textContent).toContain("Phase 2 evidence is required")
  expect(document.body.textContent).not.toContain("Exact ownership")
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  expect((button("Execute approved changes or resume page") as HTMLButtonElement).disabled).toBe(true)
})

it("shows Graph throttle deadlines, confirms uncertain results and offers discard only when allowed", async () => {
  const retryAt = Date.UTC(2026, 10, 20, 18)
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body)).action
    return Response.json(action === "preview" ? { ...page, canDiscard: true } : { ...page, status: "partial", canDiscard: action !== "restore", outcomes: [{ key: "member", state: action === "restore" ? "uncertain" : "deferred", retryAt }] })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(button("Discard saved restore")).toBeDefined()
  await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
  await click("Execute approved changes or resume page")
  expect(document.body.textContent).toContain(`The result is being confirmed. Earliest retry: ${new Date(retryAt).toLocaleString()}.`)
  expect(button("Discard saved restore")).toBeUndefined()
  await click("Confirm this page's results")
  expect(document.body.textContent).toContain("Throttled by Microsoft Graph. Earliest retry:")
  expect(document.body.textContent).toContain(new Date(retryAt).toLocaleString())
  expect(button("Discard saved restore")).toBeDefined()
})

it("offers journal confirmation and discard with no backup props or mutation controls", async () => {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "discard" ? { discarded: true, canDiscard: false } : { ...page, canDiscard: true, outcomes: [{ key: "member", state: "applied" }], status: "complete" }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { tenant })))
  expect(document.body.textContent).toContain("Saved directory restores")
  expect(button("Preview directory changes")).toBeUndefined()
  expect(button("Execute approved changes or resume page")).toBeUndefined()
  await act(async () => {
    const input = document.querySelector("input")!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "saved-page")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click("Confirm saved page results")
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ action: "reconcile", runId: "saved-page", backupId: "", path: "" })
  await click("Discard saved restore")
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ action: "discard", runId: "run" })
  expect(document.body.textContent).toContain("This page can never send again.")
})

it("confirms the displayed page even when the saved page input names a different page", async () => {
  const fetcher = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json(page))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "different-page")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(document.body.textContent).toContain("Saved page: run")
  await click("Confirm this page's results")
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ action: "reconcile", runId: "run" })
  await click("Resume saved page")
  expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toMatchObject({ action: "resume", runId: "different-page" })
})

it("restores only the saved selection as checked approvals when resuming a page", async () => {
  const rows = [page.rows[0]!, { ...page.rows[0]!, key: "unselected" }]
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "resume" ? { ...page, rows, selection: ["member"] } : { status: "complete" }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore")
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "run")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click("Resume saved page")
  expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(input => input.checked)).toEqual([true, true, false, false])
  expect((button("Execute approved changes or resume page") as HTMLButtonElement).disabled).toBe(false)
  await click("Execute approved changes or resume page")
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ action: "restore", runId: "run", approvals: { member: ["directory-item", "security-response"] } })
})

it.each(["preview", "restore", "reconcile"])("clears account data and ignores an old account's in-flight %s response", async action => {
  let resolve!: (response: Response) => void
  let pending = false
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)).action
    if (pending && sent === action) return new Promise<Response>(done => { resolve = done })
    return Response.json(sent === "preview" ? { ...page, canDiscard: true } : { ...page, canDiscard: true, status: "complete", outcomes: [{ key: "member", state: "applied", targetId: "old-account-target" }], replacedReferences: [{ path: "old-policy", property: "groupId", mapping: { source: "old", target: "new" } }] })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => { for (const input of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) input.click() })
  await click("Execute approved changes or resume page")
  expect(document.body.textContent).toContain("old-account-target")
  expect(button("Discard saved restore")).toBeDefined()
  await act(async () => accounts.changed!("another-tenant"))
  expect(document.body.textContent).toContain("old-account-target")
  pending = true
  await click(action === "preview" ? "Preview directory changes" : action === "restore" ? "Execute approved changes or resume page" : "Confirm this page's results")
  await act(async () => accounts.changed!("TENANT"))
  expect(document.body.textContent).not.toContain("Member (user)")
  expect(document.body.textContent).not.toContain("old-account-target")
  expect(document.body.textContent).not.toContain("old-policy")
  expect(button("Discard saved restore")).toBeUndefined()
  expect(button("Execute approved changes or resume page")).toBeUndefined()
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  expect((button("Preview directory changes") as HTMLButtonElement).disabled).toBe(false)
  await act(async () => resolve(Response.json({ ...page, canDiscard: true, status: "complete", outcomes: [{ key: "member", state: "applied", targetId: "late-target" }] })))
  expect(document.body.textContent).not.toContain("Saved page: run")
  expect(document.body.textContent).not.toContain("late-target")
  pending = false
  await click("Preview directory changes")
  expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => !input.checked)).toBe(true)
  expect((button("Execute approved changes or resume page") as HTMLButtonElement).disabled).toBe(true)
})

it("handles a cancelled response while the backup is loading", async () => {
  let resolve!: (response: Response) => void
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => JSON.parse(String(init?.body)).action === "resume" ? new Promise<Response>(done => { resolve = done }) : Response.json(JSON.parse(String(init?.body)).action === "cancel" ? { cancelled: true } : { ...page, selection: ["member"] }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "run")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click("Resume saved page")
  await click("Cancel directory restore")
  await act(async () => resolve(Response.json({ cancelled: true })))
  expect(document.body.textContent).toContain("Directory restore cancelled.")
  expect(document.body.textContent).not.toContain("Directory restore is partial")
  expect(document.body.textContent).not.toContain("Saved page: run")
  expect(button("Execute approved changes or resume page")).toBeUndefined()
  expect((button("Preview directory changes") as HTMLButtonElement).disabled).toBe(false)
})
