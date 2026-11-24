import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { DirectoryRestore } from "../../src/portal/components/backup/directory-restore"
const accounts = vi.hoisted(() => ({ discover: vi.fn<() => Promise<{ owner: string; pages: Array<{ runId: string; path: string }> }> | undefined>(), changed: null as null | ((tenantId: string) => void) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { auth: { savedDirectoryRestores: () => accounts.discover(), onAccountsChanged: (listener: (tenantId: string) => void) => { accounts.changed = listener; return () => { accounts.changed = null } } } } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const tenant = { name: "Contoso", credentials: { tenantId: "tenant", appId: "app", clientSecret: "placeholder" }, storageAccountName: "local" }
const button = (name: string) => [...document.querySelectorAll("button")].find(item => item.textContent === name)!
const props = { tenant, backupId: "backup", path: "backup/Groups/group.json" }
const page = { runId: "run", fingerprint: "bound", more: true, rows: [{ key: "member", review: { principal: { id: "p", name: "Member", type: "user" }, resource: { id: "g", name: "Team", type: "group" }, privilege: "member", scope: "tenant/group/g", approvals: ["directory-item", "security-response"], notices: ["The current state looks deliberate."], changes: [{ property: "present", before: false, after: true }], roleAssignable: false } }] }
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; accounts.discover.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const click = async (name: string) => act(async () => button(name).click())
it("shows who gets what and requires each approval before sending its saved page", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "preview" ? page : { status: "complete", replacedReferences: [{ path: "DeviceConfigurations/p", property: "groupId", mapping: { kind: "objectId", folder: "Groups", source: "old", target: "new" } }] }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(document.body.textContent).toContain("Member (user): member on Team (group)")
  expect(document.body.textContent).toContain("Current: Not assigned now")
  expect(document.body.textContent).toContain("Restore: Assigned after restore")
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

it.each([
  ["RoleAssignmentSchedules", "Active role schedule", "Assigned", "2026-12-30T18:00:00Z", "assigned", "Assigned"],
  ["RoleEligibilitySchedules", "Role eligibility", "Eligible", "2026-12-30T18:00:00Z", "eligible", "Eligible"],
  ["PimGroupEligibilitySchedules", "Eligible group member", "Eligible", "No expiration", "eligible", "Eligible"],
] as const)("shows readable schedule and relationship values for %s", async (folder, privilege, status, end, absent, restore) => {
  vi.stubEnv("TZ", "Europe/Berlin")
  const start = "2026-11-22T10:00:00Z"
  const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }) + " (UTC+01:00)"
  const review = { ...page.rows[0]!.review, privilege, changes: [
    { property: "Schedule", before: null, after: { start, end } },
    { property: "Relationship", before: "Absent", after: "Present" },
  ] }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page, rows: [{ key: "schedule", review }] })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { ...props, path: `backup/${folder}/schedule.json` })))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(document.body.textContent).toContain("Current: None")
  expect(document.body.textContent).toContain(`Current: Not ${absent} now`)
  expect(document.body.textContent).toContain(`Restore: ${restore} after restore`)
  expect(document.body.textContent).toContain(`Saved in backup: ${status} from ${date(start)}${end === "No expiration" ? ". No end date" : ` to ${date(end)}`}`)
})

it("distinguishes current and saved instants in the repeated daylight-saving hour", async () => {
  vi.stubEnv("TZ", "Europe/Berlin")
  const current = "2026-10-25T00:30:00Z", saved = "2026-10-25T01:30:00Z"
  const local = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" })
  const review = { ...page.rows[0]!.review, changes: [
    { property: "Schedule", before: [{ start: current, end: "No expiration" }], after: { start: saved, end: "No expiration" } },
    { property: "Relationship", before: "Present", after: "Present" },
  ] }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page, rows: [{ key: "schedule", review }] })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { ...props, path: "backup/RoleAssignmentSchedules/schedule.json" })))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(local(current)).toBe(local(saved))
  expect(document.body.textContent).toContain(`Current: Assigned from ${local(current)} (UTC+02:00). No end date`)
  expect(document.body.textContent).toContain(`Saved in backup: Assigned from ${local(saved)} (UTC+01:00). No end date`)
})

it.each([[["Not read"]], [null]])("shows unread schedule dates for an existing relationship (%j)", async before => {
  const review = { ...page.rows[0]!.review, changes: [
    { property: "Schedule", before, after: { end: "No expiration" } },
    { property: "Relationship", before: "Present", after: "Present" },
  ] }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page, rows: [{ key: "schedule", review }] })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { ...props, path: "backup/PimGroupEligibilitySchedules/schedule.json" })))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(document.body.textContent).toContain("Current: Not read")
  expect(document.body.textContent).toContain("Current: Eligible now")
  expect(document.body.textContent).not.toContain("Current: None")
})

it("explains the roles and PIM restriction on an existing saved review", async () => {
  const review = { ...page.rows[0]!.review, blocker: "This relationship is available for review. A live restore and cleanup round trip is required before execution." }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page, rows: [{ key: "schedule", review }] })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { ...props, path: "backup/RoleAssignmentSchedules/schedule.json" })))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(document.body.textContent).toContain("Blocked: Restoring roles and PIM is not available yet. You can review what would change.")
  expect(document.body.textContent).not.toContain("round trip")
  expect(button("Execute approved changes or resume page")).toBeUndefined()
})

it("shows directory text properties without quotes and keeps structured property differences", async () => {
  const review = { ...page.rows[0]!.review, changes: [
    { property: "description", before: null, after: "Recovery app" },
    { property: "metadata", before: { value: "old" }, after: { value: "new" } },
  ] }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page, rows: [{ key: "app", review }] })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { ...props, path: "backup/Applications/app.json" })))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(document.body.textContent).toContain("descriptionCurrent: NoneRestore: Recovery app")
  expect(document.body.textContent).toContain('metadataCurrent: {"value":"old"}Restore: {"value":"new"}')
})

it("explains when Microsoft asks for temporary permissions and how to coordinate the restore", async () => {
  const temporaryAccess = { pack: { scopes: ["Application.ReadWrite.All", "DelegatedPermissionGrant.ReadWrite.All"] }, cleanup: { checked: true } }
  const review = { ...page.rows[0]!.review, principal: null, privilege: "update", approvals: ["directory-item"], changes: [{ property: "displayName", before: "Edited app", after: "Recovery app" }] }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page, rows: [{ key: "app", review }], more: false, temporaryAccess })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { ...props, path: "backup/Applications/app.json" })))
  await click("Review directory restore"); await click("Preview directory changes")
  const approval = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  await act(async () => approval.click())
  expect(document.body.textContent).toContain("Microsoft asks for Application.ReadWrite.All and DelegatedPermissionGrant.ReadWrite.All only if the required permissions are missing")
  expect(document.body.textContent).toContain("Run only one app metadata restore per tenant at a time, including across devices. Avoid granting permissions to the TenuVault app while the restore runs.")
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
it("shows the admitted application updates and blocks every other operation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page, more: false, rows: [{ ...page.rows[0], review: { ...page.rows[0]!.review, blocker: "Phase 2 evidence is required." } }] })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { ...props, path: "backup/Applications/app.json" })))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(document.body.textContent).toContain("Only nonempty app registration name and description updates run. Everything else is blocked")
  expect(document.body.textContent).not.toContain("Each owner, consent grant and app role assignment needs its own approval")
  expect(document.body.textContent).not.toContain("Set up single sign-on")
  expect(document.body.textContent).not.toContain("Recreated objects get a new ID")
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
    return Response.json(action === "preview" ? { ...page, canDiscard: true } : { ...page, status: "partial", canDiscard: action !== "restore", outcomes: [{ key: "member", state: action === "restore" ? "uncertain" : "deferred", deferralCause: "throttle", retryAt }] })
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
  await click("Discard entered page")
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
  expect(document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value).toBe("run")
  expect((button("Resume saved page") as HTMLButtonElement).disabled).toBe(false)
  expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toMatchObject({ action: "resume", runId: "run" })
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

it("keeps the cancelled execution page ID while backup loading so it can be resumed, confirmed or discarded", async () => {
  let resolve!: (response: Response) => void
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body)).action
    return action === "restore" ? new Promise<Response>(done => { resolve = done }) : Response.json(action === "cancel" ? { cancelled: true } : action === "discard" ? { discarded: true } : { ...page, canDiscard: action === "reconcile", selection: ["member"] })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
  await click("Execute approved changes or resume page")
  expect(button("Cancel directory restore")).toBeDefined()
  await click("Cancel directory restore")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "cancel", runId: "run" })
  await act(async () => resolve(Response.json({ cancelled: true })))
  expect(document.body.textContent).toContain("Directory restore cancelled.")
  expect(document.body.textContent).not.toContain("Directory restore is partial")
  expect(document.body.textContent).toContain("Saved page: run")
  expect(document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value).toBe("run")
  expect(button("Execute approved changes or resume page")).toBeUndefined()
  expect(button("Cancel directory restore")).toBeUndefined()
  expect((button("Preview directory changes") as HTMLButtonElement).disabled).toBe(false)
  await click("Resume saved page")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "resume", runId: "run" })
  await click("Confirm this page's results")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "reconcile", runId: "run" })
  await click("Discard saved restore")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "discard", runId: "run" })
  expect(document.body.textContent).toContain("This page can never send again.")
})

it.each(["preview", "resume", "reconcile", "next", "discard"])("hides Cancel for the unregistered %s action", async action => {
  let resolve!: (response: Response) => void, pending = false
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, _init?: RequestInit) => pending ? new Promise<Response>(done => { resolve = done }) : Response.json({ ...page, canDiscard: true })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "another-page")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  pending = true
  await click(action === "preview" ? "Preview directory changes" : action === "resume" ? "Resume saved page" : action === "reconcile" ? "Confirm this page's results" : action === "next" ? "Preview next page" : "Discard saved restore")
  expect(button("Cancel directory restore")).toBeUndefined()
  await act(async () => resolve(Response.json({ ...page, canDiscard: true })))
})

it.each([false, true])("offers discard after confirming a cancelled page with no journal and a deleted backup, saved-only=%s", async savedOnly => {
  let resolve!: (response: Response) => void
  const empty = { runId: "run", rows: [], status: "nothing-sent", outcomes: [], canDiscard: true }
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body)).action
    return action === "restore" ? new Promise<Response>(done => { resolve = done }) : Response.json(action === "preview" ? page : action === "cancel" ? { cancelled: true } : action === "discard" ? { discarded: true } : empty)
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, savedOnly ? { tenant } : props)))
  if (savedOnly) {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>("input")!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "run")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  } else {
    await click("Review directory restore"); await click("Preview directory changes")
    await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
    await click("Execute approved changes or resume page"); await click("Cancel directory restore")
    await act(async () => resolve(Response.json({ cancelled: true })))
  }
  await click(savedOnly ? "Confirm saved page results" : "Confirm this page's results")
  expect(button(savedOnly ? "Discard entered page" : "Discard saved restore")).toBeDefined()
  expect(document.body.textContent).toContain("No directory changes were sent for this page.")
  expect(document.body.textContent).not.toContain("Directory page completed")
  await click(savedOnly ? "Discard entered page" : "Discard saved restore")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "discard", runId: "run" })
  expect(document.body.textContent).toContain("This page can never send again.")
})


it.each(["deferred", "uncertain"])("keeps the unresolved %s page visible and disables next-page preview until settled", async state => {
  let settled = false
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body)).action
    return Response.json(action === "preview" ? page : { ...page, unresolved: !settled, status: settled ? "complete" : "partial", outcomes: [{ key: "member", state: settled ? "applied" : state }] })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(button("Preview next page").disabled).toBe(false)
  await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
  await click("Execute approved changes or resume page")
  expect(button("Preview next page").disabled).toBe(true)
  expect(document.body.textContent).toContain("Resolve or discard this saved page before previewing the next page")
  expect(document.body.textContent).toContain("Saved page: run")
  const calls = fetcher.mock.calls.length
  await click("Preview next page")
  expect(fetcher.mock.calls).toHaveLength(calls)
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "run")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click("Resume saved page")
  expect(button("Preview next page").disabled).toBe(true)
  expect(document.body.textContent).toContain("Saved page: run")
  settled = true
  await click("Confirm this page's results")
  expect(button("Preview next page").disabled).toBe(false)
  await click("Preview next page")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "preview", previousRunId: "run" })
})


it("keeps next-page preview disabled after a restore persistence error until saved confirmation", async () => {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body)).action
    return action === "restore" ? Response.json({ error: "Restore storage unavailable" }, { status: 500 }) : Response.json(action === "reconcile" ? { ...page, unresolved: false, outcomes: [{ key: "member", state: "failed" }] } : page)
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
  await click("Execute approved changes or resume page")
  expect(document.body.textContent).toContain("Restore storage unavailable")
  expect(document.body.textContent).toContain("Saved page: run")
  expect(button("Preview next page").disabled).toBe(true)
  await click("Confirm this page's results")
  expect(button("Preview next page").disabled).toBe(false)
})

it("keeps next-page preview disabled for unstarted approved batches after confirmation and resume", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ ...page.rows[0]!, key: `member-${index}` }))
  const selection = rows.map(row => row.key), outcomes = selection.slice(0, 20).map(key => ({ key, state: "applied" }))
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body)).action
    return Response.json(action === "preview" ? { ...page, rows, unresolved: false } : action === "resume" ? { ...page, rows, selection, unresolved: true } : { status: "partial", unresolved: true, outcomes })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
  await click("Execute approved changes or resume page")
  expect(button("Preview next page").disabled).toBe(true)
  expect(document.body.textContent).toContain("applied.")
  await click("Confirm this page's results")
  expect(button("Preview next page").disabled).toBe(true)
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "run")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click("Resume saved page")
  expect(button("Preview next page").disabled).toBe(true)
  expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => input.checked)).toBe(true)
  const calls = fetcher.mock.calls.length
  await click("Preview next page")
  expect(fetcher.mock.calls).toHaveLength(calls)
})

it.each(["discard", "resume"])("keeps discarded inventory continuation with execution disabled after %s", async action => {
  const discarded = { ...page, discarded: true, unresolved: false, canDiscard: false, selection: ["member"] }
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    return Response.json(body.previousRunId ? { ...page, runId: "next-run", more: false, discarded: false } : body.action === "discard" || body.action === "resume" ? discarded : { ...page, canDiscard: true })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
  if (action === "resume") {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "run")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click("Resume saved page")
  } else await click("Discard saved restore")
  expect(document.body.textContent).toContain("Saved page: run")
  expect(document.body.textContent).toContain("This page can never send again.")
  expect(button("Discard saved restore")).toBeUndefined()
  expect(button("Execute approved changes or resume page").disabled).toBe(true)
  expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => input.disabled)).toBe(true)
  expect(button("Preview next page").disabled).toBe(false)
  const calls = fetcher.mock.calls.length
  await click("Execute approved changes or resume page")
  expect(fetcher.mock.calls).toHaveLength(calls)
  await click("Preview next page")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "preview", previousRunId: "run" })
  expect(document.body.textContent).toContain("Saved page: next-run")
  expect(document.body.textContent).not.toContain("This page can never send again.")
})

it("uses an explicit settled server flag instead of stale unresolved outcomes", async () => {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "preview" ? page : { unresolved: false, status: "complete", outcomes: [{ key: "member", state: "pending" }] }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
  await click("Execute approved changes or resume page")
  expect(button("Preview next page").disabled).toBe(false)
  await click("Confirm this page's results")
  expect(button("Preview next page").disabled).toBe(false)
})

it.each(["reconcile", "discard", "resume"])("hydrates saved relationship choices after %s and continues from the displayed page options", async action => {
  const savedOptions = { stage: "relationships", exactMembers: true, exactOwners: true, previousRunId: "older-page" }
  const saved = { ...page, runId: "saved-run", options: savedOptions, unresolved: false, discarded: action === "discard", status: "complete", outcomes: [] }
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.previousRunId) {
      const valid = body.stage === "relationships" && body.exactMembers === true && body.exactOwners === true && body.previousRunId === "saved-run"
      return Response.json(valid ? { ...saved, runId: "next-run", more: false, discarded: false } : { error: "Continue the original group's relationship preview and exact choices." }, { status: valid ? 200 : 409 })
    }
    return Response.json(body.action === "preview" ? { ...page, canDiscard: true, options: { stage: "object", exactMembers: false, exactOwners: false } } : saved)
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore")
  if (action === "discard") await click("Preview directory changes")
  else await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "saved-run")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click(action === "reconcile" ? "Confirm this page's results" : action === "discard" ? "Discard saved restore" : "Resume saved page")
  expect(document.body.textContent).toContain("Saved page: saved-run")
  expect(document.querySelector("select")!.value).toBe("relationships")
  for (const label of ["Exact membership", "Exact ownership"]) {
    const input = [...document.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))!.querySelector("input")!
    expect(input.checked).toBe(true)
  }
  expect(button("Preview next page").disabled).toBe(false)
  await click("Preview next page")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "preview", stage: "relationships", exactMembers: true, exactOwners: true, previousRunId: "saved-run" })
  expect(document.body.textContent).toContain("Saved page: next-run")
  expect(document.body.textContent).not.toContain("Continue the original group's relationship preview")
})

it("keeps all approved keys unresolved when fallback outcomes omit unstarted rows", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ ...page.rows[0]!, key: `member-${index}` }))
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "preview" ? { ...page, rows } : { status: "partial", outcomes: rows.slice(0, 20).map(row => ({ key: row.key, state: "applied" })) }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
  await click("Execute approved changes or resume page")
  expect(Object.keys(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body)).approvals)).toHaveLength(50)
  expect(button("Preview next page").disabled).toBe(true)
  await click("Confirm this page's results")
  expect(button("Preview next page").disabled).toBe(true)
  const calls = fetcher.mock.calls.length
  await click("Preview next page")
  expect(fetcher.mock.calls).toHaveLength(calls)
})

it("retains review rows and enables Resume for the displayed page after confirmation without a first journal", async () => {
  const savedOptions = { stage: "relationships", exactMembers: true, exactOwners: true }
  const saved = { ...page, options: savedOptions, selection: ["member"], unresolved: true }
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body)).action
    return action === "restore" ? Response.json({ error: "First cursor save unavailable" }, { status: 500 }) : Response.json(action === "reconcile" ? { ...saved, status: "nothing-sent", outcomes: [{ key: "member", state: "pending" }], canDiscard: true } : saved)
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => [...document.querySelectorAll("label")].filter(label => label.textContent?.startsWith("Approve ")).forEach(label => label.querySelector<HTMLInputElement>("input")!.click()))
  await click("Execute approved changes or resume page")
  expect(document.body.textContent).toContain("First cursor save unavailable")
  const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "stale-input")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click("Confirm this page's results")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "reconcile", runId: "run" })
  expect(document.body.textContent).toContain("Member (user): member on Team (group)")
  expect(document.body.textContent).toContain("No directory changes were sent for this page.")
  expect(input.value).toBe("run")
  expect(document.querySelector<HTMLSelectElement>("select")!.value).toBe("relationships")
  expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(input => input.checked)).toEqual([true, true, true, true])
  expect((button("Preview next page") as HTMLButtonElement).disabled).toBe(true)
  expect((button("Resume saved page") as HTMLButtonElement).disabled).toBe(false)
  await click("Resume saved page")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "resume", runId: "run", ...savedOptions })
  expect((button("Execute approved changes or resume page") as HTMLButtonElement).disabled).toBe(false)
})

it.each([false, true])("discards an entered saved page locally without confirmation when token refresh is unavailable, saved-only=%s", async savedOnly => {
  const { DirectoryRestoreService } = await import("../../src/main/restore/directory-service")
  const { RecoveryAccounts } = await import("../../src/main/restore/safety-resolvers")
  const { GuardedRunJournal } = await import("../../src/main/restore/guarded-run")
  const runId = "00000000-0000-4000-8000-000000000025", sourceId = "00000000-0000-4000-8000-000000000010"
  const owner = { tenantId: tenant.credentials.tenantId, userId: "cached-admin", clientId: tenant.credentials.appId }
  const data = new Map<string, string>(), store = { partitioned: true as const, get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const saved: import("../../src/main/restore/directory-service").DirectoryPage = {
    run: { version: 1, id: runId, tenant: owner.tenantId, actor: { ...owner, recoveryAccountIds: [] }, origin: "restore", source: { path: props.path, fingerprint: "saved-source" }, mappings: [], entries: [{ state: "deferred", step: { key: "member", folder: "Groups", sourceId, operation: "update", properties: ["description"], desired: { description: "Saved" }, preview: "saved-preview", requires: [] } }] },
    rows: page.rows, more: false, selection: ["member"], options: { stage: "object", exactMembers: false, exactOwners: false },
  }
  store.set(`restore.directory.review.${owner.tenantId}.${runId}`, JSON.stringify(saved))
  const prefix = `restore.directory.${owner.tenantId}.${runId}.batch.0.`
  new GuardedRunJournal({ get: key => store.get(prefix + key), set: (key, value) => store.set(prefix + key, value), delete: key => store.delete(prefix + key) }).save(saved.run)
  const coordinator = `restore.directory.coordinator.${owner.tenantId}`
  store.set(coordinator, JSON.stringify({ locks: { [sourceId]: { owner: runId, journal: prefix } }, deadlines: {}, discarded: {} }))
  const connection = vi.fn(async () => { throw new Error("Token refresh unavailable") }), localOwner = vi.fn(async () => owner), graph = vi.fn(async () => { throw new Error("Graph unavailable") })
  const service = new DirectoryRestoreService(store, new RecoveryAccounts(store), connection, localOwner, graph)
  await expect(connection()).rejects.toThrow("Token refresh unavailable")
  connection.mockClear()
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    expect(body.action).toBe("discard")
    return Response.json(await service.saved(body.tenantId, body.runId, body.action))
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, savedOnly ? { tenant } : props)))
  if (!savedOnly) await click("Review directory restore")
  expect(button("Discard entered page")).toBeUndefined()
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, runId)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect((button("Discard entered page") as HTMLButtonElement).disabled).toBe(false)
  await click("Discard entered page")
  expect(fetcher).toHaveBeenCalledOnce(); expect(localOwner).toHaveBeenCalledOnce()
  expect(connection).not.toHaveBeenCalled(); expect(graph).not.toHaveBeenCalled()
  expect(JSON.parse(data.get(coordinator)!)).toEqual({ locks: {}, deadlines: {}, discarded: { [runId]: true } })
  expect(document.body.textContent).toContain("This page can never send again.")
  expect(button("Discard entered page")).toBeUndefined()
})

it.each([true, false])("discards only the entered page B while review A remains displayed with canDiscard=%s", async canDiscard => {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    return Response.json(body.action === "discard" ? { ...page, runId: body.runId, discarded: true, canDiscard: false } : { ...page, canDiscard })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(!!button("Discard saved restore")).toBe(canDiscard)
  const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
  const enter = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await enter("page-B")
  expect(button("Discard entered page").disabled).toBe(false)
  await click("Discard entered page")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "discard", runId: "page-B" })
  expect(document.body.textContent).toContain("Saved page: run")
  expect(input.value).toBe("page-B")
  expect(button("Discard entered page")).toBeUndefined()
  expect(!!button("Discard saved restore")).toBe(canDiscard)
  expect(document.querySelectorAll('input[type="checkbox"]:disabled')).toHaveLength(0)
  await enter("page-C")
  expect(button("Discard entered page").disabled).toBe(false)
  await enter("")
  expect(button("Discard entered page")).toBeUndefined()
  if (canDiscard) {
    await enter("page-B")
    await click("Discard saved restore")
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "discard", runId: "run" })
    expect(input.value).toBe("page-B")
    expect(button("Discard entered page").disabled).toBe(false)
    expect(button("Discard saved restore")).toBeUndefined()
  }
  expect(fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).action === "discard")).toHaveLength(canDiscard ? 2 : 1)
})

it("resets a saved-only input's discard refusal when its page ID changes", async () => {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => Response.json({ ...page, runId: JSON.parse(String(init?.body)).runId, canDiscard: false, outcomes: [{ key: "member", state: "uncertain" }] }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { tenant })))
  const enter = async (value: string) => act(async () => {
    const input = document.querySelector<HTMLInputElement>("input")!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await enter("page-A"); await click("Confirm saved page results")
  expect(button("Discard entered page")).toBeUndefined()
  await enter("page-B")
  expect(button("Discard entered page").disabled).toBe(false)
  await click("Discard entered page")
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))).toMatchObject({ action: "discard", runId: "page-B" })
})


it("shows saved applied, failed, deferred and uncertain outcomes with retry times immediately on Resume", async () => {
  const retryAt = Date.now() + 120_000
  const outcomes = [
    { key: "applied", state: "applied", targetId: "saved-target" },
    { key: "failed", state: "failed", reason: "Saved refusal" },
    { key: "deferred", state: "deferred", retryAt, deferralCause: "throttle", reason: "Saved throttle" },
    { key: "uncertain", state: "uncertain", retryAt, reason: "Saved unanswered write" },
  ]
  const rows = outcomes.map(outcome => ({ ...page.rows[0]!, key: outcome.key }))
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "resume" ? { ...page, rows, selection: outcomes.map(row => row.key), unresolved: true, outcomes } : page))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await click("Resume saved page")
  const results = document.querySelector('[aria-label="Directory page results"]')!
  expect(results.textContent).toContain("applied. Target ID: saved-target.")
  expect(results.textContent).toContain("failed. Saved refusal")
  expect(results.textContent).toContain(`Throttled by Microsoft Graph. Earliest retry: ${new Date(retryAt).toLocaleString()}. Saved throttle`)
  expect(results.textContent).toContain(`The result is being confirmed. Earliest retry: ${new Date(retryAt).toLocaleString()}. Saved unanswered write`)
  expect(button("Preview next page").disabled).toBe(true)
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual(["preview", "resume"])
  await click("Preview directory changes")
  expect(document.querySelector('[aria-label="Directory page results"]')).toBeNull()
})

it("shows proxy authentication guidance with its saved timestamp while Graph throttling keeps its label", async () => {
  const retryAt = Date.now() - 120_000
  const outcomes = [{ key: "proxy", state: "deferred", retryAt, deferralCause: "proxy" }, { key: "graph", state: "deferred", retryAt, deferralCause: "throttle" }]
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "resume" ? { ...page, rows: outcomes.map(outcome => ({ ...page.rows[0]!, key: outcome.key })), outcomes } : page))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes"); await click("Resume saved page")
  const results = document.querySelector('[aria-label="Directory page results"]')!
  expect(results.children[0]!.textContent).toContain(`Proxy authentication required. Sign in to the proxy and resume. Earliest retry: ${new Date(retryAt).toLocaleString()}.`)
  expect(results.children[0]!.textContent).not.toContain("Throttled by Microsoft Graph")
  expect(results.children[1]!.textContent).toContain(`Throttled by Microsoft Graph. Earliest retry: ${new Date(retryAt).toLocaleString()}.`)
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual(["preview", "resume"])
})

it("keeps the previous page ID and exact options when the next preview must retry a read", async () => {
  const options = { stage: "relationships", exactMembers: true, exactOwners: false }
  let next = 0
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    return body.previousRunId && ++next === 1 ? Response.json({ error: "A temporary read failure. Retry this preview." }, { status: 409 }) : Response.json({ ...page, options, ...(body.previousRunId ? { runId: "next", more: false } : {}) })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes"); await click("Preview next page")
  expect(document.body.textContent).toContain("Retry this preview")
  expect(document.body.textContent).toContain("Saved page: run.")
  expect(button("Preview next page").disabled).toBe(false)
  await click("Preview next page")
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ previousRunId: "run", ...options })
  expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toEqual(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)))
  expect(document.body.textContent).toContain("Saved page: next.")
})


it("shows Discard after Resume recovers a coordinator-only rejection without confirmation or execution", async () => {
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const action = JSON.parse(String(init?.body)).action
    return Response.json(action === "preview" ? { ...page, canDiscard: false } : action === "resume" ? { ...page, canDiscard: true, unresolved: true, outcomes: [{ key: "member", state: "uncertain" }] } : { ...page, discarded: true, canDiscard: false })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  expect(button("Discard saved restore")).toBeUndefined()
  await click("Resume saved page")
  expect(button("Discard saved restore").disabled).toBe(false)
  expect(document.querySelector('[aria-label="Directory page results"]')!.textContent).toContain("The result is being confirmed")
  await click("Discard saved restore")
  expect(document.body.textContent).toContain("Saved restore discarded")
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual(["preview", "resume", "discard"])
})

it("shows the role authorization reason instead of a throttle label after resume", async () => {
  const reason = "Your Entra role does not allow this change. Activate the role, then resume."
  const outcome = { key: "member", state: "deferred", retryAt: Date.now() - 1000, deferralCause: "role", reason }
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "resume" ? { ...page, outcomes: [outcome] } : page)))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes"); await click("Resume saved page")
  const results = document.querySelector('[aria-label="Directory page results"]')!
  expect(results.textContent).toContain(reason)
  expect(results.textContent).not.toContain("Throttled by Microsoft Graph")
  expect(results.textContent).not.toContain("Deferred before dispatch")
})

it.each(["role", "authentication"])("renders the stored %s deferral cause without inferring throttle from its deadline", async deferralCause => {
  const reason = deferralCause === "authentication" ? "Microsoft Graph rejected the connection's authentication. Resume with a fresh connection to repeat permission and approval checks." : "Security-group creation requires a current tenant-wide Groups Administrator or Global Administrator assignment."
  const outcomes = [{ key: "member", state: "deferred", retryAt: Date.now() + 120000, deferralCause, reason }]
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "resume" ? { ...page, outcomes } : page)))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes"); await click("Resume saved page")
  const results = document.querySelector('[aria-label="Directory page results"]')!
  expect(results.textContent).toContain(reason)
  expect(results.textContent).not.toContain("Throttled by Microsoft Graph")
  expect(results.textContent).not.toContain("Deferred before dispatch")
})

it("keeps the saved page ID after same-owner reauthentication while clearing the displayed review", async () => {
  accounts.discover.mockResolvedValue({ owner: "tenant/user/app", pages: [] })
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(page)))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => accounts.changed!("TENANT"))
  expect(document.body.textContent).not.toContain("Member (user)")
  expect(document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value).toBe("run")
  expect(button("Resume saved page").disabled).toBe(false)
  expect(button("Execute approved changes or resume page")).toBeUndefined()
})

it("recovers only the new owner's unfinished IDs after an account switch and ignores a stale listing", async () => {
  accounts.discover.mockResolvedValue({ owner: "tenant/first/app", pages: [] })
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(page)))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  let resolve!: (value: { owner: string; pages: Array<{ runId: string; path: string }> }) => void
  accounts.discover.mockReturnValueOnce(new Promise(done => { resolve = done }))
  await act(async () => accounts.changed!("tenant"))
  accounts.discover.mockResolvedValue({ owner: "tenant/second/app", pages: [{ runId: "second-page", path: props.path }] })
  await act(async () => accounts.changed!("tenant"))
  await act(async () => resolve({ owner: "tenant/first/app", pages: [{ runId: "private-page", path: "private-path" }] }))
  expect(document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value).toBe("")
  expect(document.body.textContent).toContain("Your unfinished saved restores")
  expect(document.body.textContent).not.toContain("private-page")
  await click(`${props.path}: second-page`)
  expect(document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value).toBe("second-page")
  expect(button("Resume saved page").disabled).toBe(false)
})
it("lists saved pages only once a row's review is open and refreshes them after a saved-page action", async () => {
  accounts.discover.mockResolvedValue({ owner: "tenant/user/app", pages: [{ runId: "saved", path: props.path }] })
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ discarded: true, canDiscard: false })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement("div", null, createElement(DirectoryRestore, props), createElement(DirectoryRestore, { ...props, path: "backup/Groups/other.json" }))))
  expect(accounts.discover).not.toHaveBeenCalled()
  await act(async () => document.querySelector("button")!.click())
  expect(accounts.discover).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).toContain(`${props.path}: saved`)
  accounts.discover.mockResolvedValue({ owner: "tenant/user/app", pages: [] })
  await click(`${props.path}: saved`); await click("Discard entered page")
  expect(accounts.discover).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).not.toContain(`${props.path}: saved`)
})
it("keeps an action's result when the saved-page refresh after it fails", async () => {
  accounts.discover.mockResolvedValue({ owner: "tenant/user/app", pages: [] })
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).action === "preview" ? { ...page, more: false } : { status: "complete", outcomes: [] })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, props)))
  await click("Review directory restore"); await click("Preview directory changes")
  await act(async () => document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => input.click()))
  accounts.discover.mockRejectedValue(new Error("Sign in"))
  await click("Execute approved changes or resume page")
  expect(document.body.textContent).toContain("Directory page completed")
  expect(document.body.textContent).not.toContain("could not be listed")
})
it("lists saved pages on the saved-only panel only while its tab is shown", async () => {
  accounts.discover.mockResolvedValue({ owner: "tenant/user/app", pages: [] })
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(DirectoryRestore, { tenant, active: false })))
  expect(accounts.discover).not.toHaveBeenCalled()
  await act(async () => root.render(createElement(DirectoryRestore, { tenant, active: true })))
  expect(accounts.discover).toHaveBeenCalledTimes(1)
})
