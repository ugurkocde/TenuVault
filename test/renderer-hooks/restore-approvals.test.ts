import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { RestoreApprovals } from "../../src/portal/components/backup/restore-approvals"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const tenant = { name: "Contoso", credentials: { tenantId: "tenant", appId: "app", clientSecret: "placeholder" }, storageAccountName: "local" }
const record = { id: "request", label: "Example policy", operation: "assign", status: "approved", approverNote: "Reviewed", expiresAt: "2026-11-13T12:00:00Z", stepNumber: 2, totalSteps: 2, canComplete: true, requesterId: "requester", requesterName: "Taylor Example" }
afterEach(() => { if (root) act(() => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(entry => entry.textContent === text)!
async function render(canComplete = true) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    return Response.json(body.approvalAction === "list" ? { records: [{ ...record, canComplete }] } : { outcome: { error: "Intune refused to complete this request. Check it in the Intune admin center." } })
  })
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(RestoreApprovals, { tenant })))
  return fetcher
}
it("loads only when opened, refreshes explicitly, and shows approved chained items", async () => {
  const fetcher = await render()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).refresh).toBe(false)
  await act(async () => button("Waiting for approval").click())
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).toContain("Assignments, Step 2 of 2: Approved, ready to complete")
  expect(document.body.textContent).toContain("Approver note: Reviewed")
  expect(button("Complete")).toBeDefined()
  await act(async () => button("Refresh").click())
  expect(fetcher).toHaveBeenCalledTimes(3)
})
it("only offers completion and withdrawal to the requester", async () => {
  await render(false)
  await act(async () => button("Waiting for approval").click())
  expect(button("Complete")).toBeUndefined()
  expect(button("Withdraw")).toBeUndefined()
  expect(document.body.textContent).toContain("original requester (Taylor Example)")
})
it("polls once per minute while open and stops when closed", async () => {
  vi.useFakeTimers()
  const fetcher = await render()
  await act(async () => button("Waiting for approval").click())
  await act(async () => vi.advanceTimersByTime(59_999))
  expect(fetcher).toHaveBeenCalledTimes(2)
  await act(async () => vi.advanceTimersByTime(1))
  expect(fetcher).toHaveBeenCalledTimes(3)
  await act(async () => button("Waiting for approval").click())
  await act(async () => vi.advanceTimersByTime(120_000))
  expect(fetcher).toHaveBeenCalledTimes(3)
})
it("surfaces refused completion instead of hiding the result", async () => {
  await render()
  await act(async () => button("Waiting for approval").click())
  await act(async () => button("Complete").click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Intune refused to complete")
})

it("renders no approval section for a tenant without MAA or saved records", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ records: [] }))
  vi.stubGlobal("fetch", fetcher)
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(RestoreApprovals, { tenant })))
  expect(document.querySelector("section")).toBeNull()
  expect(document.body.textContent).toBe("")
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).refresh).toBe(false)
})

it.each(["completed", "rejected", "cancelled", "expired", "stale", "justification-required", "needsApproval", "approved"])("shows time left only for actionable status %s", async (status) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ records: [{ ...record, status }] })))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root.render(createElement(RestoreApprovals, { tenant, openRevision: 1 })))
  expect(document.body.textContent?.includes("hours left")).toBe(["needsApproval", "approved"].includes(status))
})

it("reloads locally when the revision changes while open", async () => {
  const fetcher = await render()
  await act(async () => button("Waiting for approval").click())
  fetcher.mockClear()
  await act(async () => root.render(createElement(RestoreApprovals, { tenant, revision: 1 })))
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ approvalAction: "list", refresh: false })
})
