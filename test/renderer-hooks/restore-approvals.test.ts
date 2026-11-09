import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { RestoreApprovals } from "../../src/portal/components/backup/restore-approvals"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const tenant = { name: "Contoso", credentials: { tenantId: "tenant", appId: "app", clientSecret: "placeholder" }, storageAccountName: "local" }
const record = { id: "request", label: "Example policy", operation: "assign", status: "approved", approverNote: "Reviewed", expiresAt: "2026-11-13T12:00:00Z", stepNumber: 2, totalSteps: 2, canComplete: true, requesterId: "requester" }
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
  expect(fetcher).not.toHaveBeenCalled()
  await act(async () => button("Waiting for approval").click())
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).toContain("assign, step 2 of 2: approved")
  expect(document.body.textContent).toContain("Approver note: Reviewed")
  expect(button("Complete")).toBeDefined()
  await act(async () => button("Refresh").click())
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it("only offers completion and withdrawal to the requester", async () => {
  await render(false)
  await act(async () => button("Waiting for approval").click())
  expect(button("Complete")).toBeUndefined()
  expect(button("Withdraw")).toBeUndefined()
  expect(document.body.textContent).toContain("original requester (requester)")
})
it("polls once per minute while open and stops when closed", async () => {
  vi.useFakeTimers()
  const fetcher = await render()
  await act(async () => button("Waiting for approval").click())
  await act(async () => vi.advanceTimersByTime(59_999))
  expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTime(1))
  expect(fetcher).toHaveBeenCalledTimes(2)
  await act(async () => button("Waiting for approval").click())
  await act(async () => vi.advanceTimersByTime(120_000))
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it("surfaces refused completion instead of hiding the result", async () => {
  await render()
  await act(async () => button("Waiting for approval").click())
  await act(async () => button("Complete").click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Intune refused to complete")
})
