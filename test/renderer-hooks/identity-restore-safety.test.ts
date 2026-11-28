import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { IdentityRestoreSafety } from "../../src/renderer/components/IdentityRestoreSafety"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
beforeEach(() => { container = document.body.appendChild(document.createElement("div")); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const response = (accountIds: string[] = [], runs: object[] = []) => Response.json({ accountIds, runs })
it("shows tenant recovery accounts, saves the explicit choice and exposes only read-back for guarded history", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    return response(body.action === "save-recovery" ? body.accountIds : ["account"], [{ id: "run", origin: "restore", entries: [{ key: "one", folder: "Users", state: "uncertain", reason: "Unanswered write" }], replacedReferences: [{ path: "ConditionalAccessPolicies/policy", property: "conditions.users", mapping: { kind: "objectId", source: "old", target: "new" } }] }])
  })
  vi.stubGlobal("fetch", fetcher)
  await act(async () => root.render(createElement(IdentityRestoreSafety, { tenantId: "tenant" })))
  expect(container.textContent).toContain("account")
  expect(container.textContent).toContain("ConditionalAccessPolicies/policy")
  const textarea = container.querySelector("textarea")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "recovery-one\nrecovery-two")
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const button = (text: string) => [...container.querySelectorAll("button")].find(entry => entry.textContent === text)!
  await act(async () => button("Save recovery accounts").click())
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body))).toMatchObject({ tenantId: "tenant", action: "save-recovery", accountIds: ["recovery-one", "recovery-two"] })
  await act(async () => button("Read back saved outcome").click())
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body))).toMatchObject({ action: "reconcile", runId: "run" })
  expect(container.textContent).not.toContain("Confirm not applied")
})
it("discards late reads from an earlier tenant and keeps a failed save visible", async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => JSON.parse(String(init?.body)).tenantId === "old" ? new Promise<Response>(resolve => { finish = resolve }) : response(["new-recovery"])))
  await act(async () => root.render(createElement(IdentityRestoreSafety, { tenantId: "old" })))
  await act(async () => root.render(createElement(IdentityRestoreSafety, { tenantId: "new" })))
  await act(async () => finish(response(["stale-recovery"])))
  expect(container.textContent).toContain("new-recovery")
  expect(container.textContent).not.toContain("stale-recovery")
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Account verification failed" }, { status: 409 })))
  await act(async () => [...container.querySelectorAll("button")].find(entry => entry.textContent === "Save recovery accounts")!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Account verification failed")
  expect(container.textContent).toContain("new-recovery")
})
