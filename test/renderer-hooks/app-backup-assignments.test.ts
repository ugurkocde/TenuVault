import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { AppAssignmentCheck } from "../../src/shared/app-sources/types"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const api = vi.hoisted(() => ({ assignments: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { appSources: api } }))
import { AssignmentCheckPanel } from "../../src/renderer/features/app-backup/AssignmentCheckPanel"

let root: Root, node: HTMLDivElement
const check = (appId = "app", patch: Partial<AppAssignmentCheck> = {}): AppAssignmentCheck => ({ appId, status: "device-targeted", summary: "A device assignment includes this PC.", checkedAt: new Date().toISOString(), assignments: [], steps: ["No targeting change is indicated."], warnings: [], ...patch })
beforeEach(() => { api.assignments.mockReset(); node = document.createElement("div"); document.body.append(node); root = createRoot(node) })
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks() })
const button = (label: string) => [...node.querySelectorAll("button")].find(b => b.textContent === label)!
async function mount(onCapture = vi.fn(async () => true)) {
  await act(async () => root.render(createElement(AssignmentCheckPanel, { tenant: "tenant", appId: "app", busy: false, onCapture })))
  return onCapture
}

it("checks automatically and waits for the result before enabling capture", async () => {
  let resolve!: (value: AppAssignmentCheck) => void
  api.assignments.mockImplementation(() => new Promise(done => { resolve = done }))
  const capture = await mount()
  expect(api.assignments).toHaveBeenCalledExactlyOnceWith("tenant", "app")
  expect(node.textContent).toContain("Checking Intune assignments")
  expect(button("Start backup").disabled).toBe(true)
  await act(async () => resolve(check()))
  expect(button("Start backup").disabled).toBe(false)
  expect(node.textContent).toContain("No assignments are changed here")
  await act(async () => button("Start backup").click())
  expect(capture).toHaveBeenCalledExactlyOnceWith("app")
})

it("shows exact group and filter guidance and keeps content authorization distinct", async () => {
  api.assignments.mockResolvedValue(check("app", { status: "review", summary: "This PC matches an app exclusion.", steps: ["Review the Required exclusion for “Pilot PCs”."], warnings: ["Intune evaluates filters."], assignments: [{ id: "row", intent: "Required", target: "Pilot PCs", match: "unknown", detail: "Review this include filter.", filter: { name: "Pilot filter", mode: "include", rule: '(device.deviceName -eq "Pilot")' } }] }))
  await mount()
  expect(node.textContent).toContain("Required exclusion for “Pilot PCs”")
  expect(node.textContent).toContain('(device.deviceName -eq "Pilot")')
  expect(node.textContent).toContain("Needs review")
  expect(node.textContent).toContain("Intune confirms installer access")
  expect(node.textContent).not.toContain("Ready to recover")
})

it("does not treat a failed check as an empty assignment list or block a manual access attempt", async () => {
  api.assignments.mockRejectedValue(new Error("Microsoft denied membership reads."))
  const capture = await mount()
  expect(node.textContent).toContain("Microsoft denied membership reads")
  expect(node.textContent).not.toContain("No assignments were found")
  expect(button("Start backup").disabled).toBe(false)
  await act(async () => button("Start backup").click())
  expect(capture).toHaveBeenCalledOnce()
})

it("clears old guidance during recheck and shows the new result", async () => {
  api.assignments.mockResolvedValueOnce(check())
  await mount()
  let resolve!: (value: AppAssignmentCheck) => void
  api.assignments.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => button("Recheck assignments").click())
  expect(node.textContent).not.toContain("A device assignment includes")
  expect(button("Start backup").disabled).toBe(true)
  await act(async () => resolve(check("app", { status: "review", summary: "No assignments were found for this app." })))
  expect(node.textContent).toContain("No assignments were found")
})

it("ignores an old app or tenant result after switching selection", async () => {
  let resolve!: (value: AppAssignmentCheck) => void
  api.assignments.mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValueOnce(check("other", { summary: "Other tenant result" }))
  await mount()
  await act(async () => root.render(createElement(AssignmentCheckPanel, { key: "other", tenant: "other-tenant", appId: "other", busy: false })))
  await act(async () => resolve(check("app", { summary: "STALE" })))
  expect(node.textContent).toContain("Other tenant result")
  expect(node.textContent).not.toContain("STALE")
})

it("refreshes a stale check without unexpectedly launching the helper", async () => {
  api.assignments.mockResolvedValueOnce(check("app", { checkedAt: new Date(Date.now() - 120_000).toISOString() })).mockResolvedValueOnce(check())
  const capture = await mount()
  await act(async () => button("Start backup").click())
  expect(api.assignments).toHaveBeenCalledTimes(2)
  expect(capture).not.toHaveBeenCalled()
  expect(node.textContent).toContain("Review the result, then start backup")
  await act(async () => button("Start backup").click())
  expect(capture).toHaveBeenCalledOnce()
})

it("refuses a result for another app", async () => {
  api.assignments.mockResolvedValue(check("wrong", { summary: "Wrong app is targeted" }))
  await mount()
  expect(node.textContent).toContain("did not match this app")
  expect(node.textContent).not.toContain("Wrong app is targeted")
})
