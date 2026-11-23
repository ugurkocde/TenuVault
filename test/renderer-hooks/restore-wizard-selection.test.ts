import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const licenseOpen = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { license: { open: licenseOpen } } }))
vi.mock("@desktop/lib/plan-dialog", () => ({ showFeaturePlanError: vi.fn() }))

import { RestoreWizard } from "../../src/portal/components/backup/restore-wizard"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Two configuration profiles in one backup, so selecting several is possible on Pro.
const contents = { content: { groups: [{ folder: "DeviceConfigurations", label: "configuration profile", area: "Devices", policies: [{ path: "DeviceConfigurations/a.json", displayName: "Profile A" }, { path: "DeviceConfigurations/b.json", displayName: "Profile B" }] }] } }
const preview = { items: [{ path: "DeviceConfigurations/a.json", name: "Profile A" }, { path: "DeviceConfigurations/b.json", name: "Profile B" }] }

async function renderItems(community: boolean, crossTenant = false): Promise<HTMLDivElement> {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).endsWith("/api/list-backup-contents") ? contents : String(input).endsWith("/api/restore-preview") ? preview : String(input).endsWith("/api/restore-validate") ? { ok: true, total: 2, passed: 2, failed: 0, manifest: { ok: true }, byType: [], items: [] } : {})))
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  const client = new QueryClient()
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(RestoreWizard, {
    tenant: { name: "Contoso", credentials: { tenantId: "tenant", appId: "app", clientSecret: "" }, storageAccountName: "tvlocal-tenant" },
    backups: [{ id: "backup-1", timestamp: "2026-10-16T02:00:00Z", type: "manual", status: "Completed", totalPolicies: 2, scope: null, size: 1, duration: 4, changes: null, comparedWith: null }],
    initialBackupId: "backup-1", community, canCopyToTenants: crossTenant, copyCandidates: crossTenant ? [{ tenantId: "destination", appId: "app", name: "Fabrikam" }] : [],
  })))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  // Open the group so each item's checkbox shows.
  const group = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) => button.textContent?.includes("Configuration profile"))!
  await act(async () => group.click())
  return container
}

const buttonNamed = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith(text))
const itemBoxes = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('ul [role="checkbox"]')]
const selectedCount = (container: HTMLElement) => container.textContent?.match(/(\d+) of 2 selected/)?.[1]

it("reads access policies only at the review step", async () => {
  const container = await renderItems(false)
  const requests = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === "/api/restore-backup" && JSON.parse(String(init?.body)).approvalAction === "detect")
  expect(requests()).toHaveLength(0)
  await act(async () => buttonNamed(container, "Select all")!.click())
  await act(async () => buttonNamed(container, "Next")!.click())
  expect(requests()).toHaveLength(0)
  await act(async () => buttonNamed(container, "Review")!.click())
  expect(requests()).toHaveLength(1)
  expect(JSON.parse(String(requests()[0]![1]?.body))).toMatchObject({ approvalAction: "detect" })
})

it.each([false, true])("validates with assignments off (copy to another tenant: %s)", async (crossTenant) => {
  const container = await renderItems(false, crossTenant)
  await act(async () => buttonNamed(container, "Select all")!.click())
  await act(async () => buttonNamed(container, "Next")!.click())
  if (crossTenant) {
    const destination = Array.from(container.querySelectorAll("label")).find((entry) => entry.textContent?.includes("Fabrikam"))!
    await act(async () => destination.querySelector<HTMLInputElement>("input")!.click())
  }
  await act(async () => buttonNamed(container, "Review")!.click())
  const validate = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Validate backup (no changes)"))!
  await act(async () => validate.click())
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/restore-validate")
  expect(request).toBeDefined()
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({
    tenantId: "tenant", appId: "app", clientSecret: "", storageAccountName: "tvlocal-tenant", backupId: "backup-1",
  })
})

it.each(["mapping", "skip"])("discards an in-flight validation after a %s edit", async (edit) => {
  const container = await renderItems(false)
  const path = "DeviceConfigurations/a.json"
  const report = { ok: true, total: 2, passed: 2, failed: 0, manifest: { ok: true }, byType: [], items: [] }
  let releaseValidation!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { releaseValidation = resolve })
  const validate = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(Response.json(report))
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/restore-validate") return validate()
    if (JSON.parse(String(init?.body)).action === "assignment-review") {
      return Response.json({ targets: [{ tenantId: "tenant", objects: {}, items: [{
        path, errors: [], warnings: [], allAssignmentsSkipped: false,
        references: [{ kind: "scopeTag", sourceId: "3", sourceName: "IT", state: "rejected", targetId: "3", suggestion: null }],
        assignments: [{ key: "0", index: 0, label: "Included target", references: [] }],
      }] }] })
    }
    return Response.json({})
  }))
  await act(async () => buttonNamed(container, "Select all")!.click())
  await act(async () => buttonNamed(container, "Next")!.click())
  const assignmentOption = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("Restore assignments"))!
  await act(async () => assignmentOption.querySelector<HTMLInputElement>("input")!.click())
  await act(async () => buttonNamed(container, "Review")!.click())
  const button = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Validate backup (no changes)"))!
  await act(async () => button.click())
  expect(validate).toHaveBeenCalledTimes(1)
  await act(async () => {
    if (edit === "mapping") {
      const mapping = container.querySelector<HTMLSelectElement>('[aria-label="Target for IT"]')!
      mapping.value = "0"
      mapping.dispatchEvent(new Event("change", { bubbles: true }))
    } else {
      const skip = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("Skip assignment 1"))!
      skip.querySelector<HTMLInputElement>("input")!.click()
    }
  })
  await act(async () => releaseValidation(Response.json(report)))
  expect(container.textContent).not.toContain("2 of 2 items passed")
  await act(async () => button.click())
  expect(container.textContent).toContain("2 of 2 items passed")
})

describe("restore wizard item selection", () => {
  it("shows Select all on Community as a marked plan option that explains the plan instead of selecting", async () => {
    const container = await renderItems(true)
    const selectAll = buttonNamed(container, "Select all")!
    expect(selectAll).toBeDefined()
    expect(selectAll.textContent).toBe("Select allPro")
    expect(selectAll.getAttribute("aria-disabled")).toBe("true")
    expect(selectAll.title).toBe("Restoring several items at once: included in TenuVault Pro and MSP. Upgrade on the License page.")
    await act(async () => selectAll.click())
    expect(selectedCount(container)).toBe("0")
    expect(document.body.textContent).toContain("Included in TenuVault Pro and MSP")
    // Per group selection stays a Pro control.
    expect(container.querySelector('[aria-label="Select all configuration profile"]')).toBeNull()
  })

  it("keeps single item restore on Community exactly as before: one item at a time, Next enabled", async () => {
    const container = await renderItems(true)
    expect(container.textContent).toContain("Community restores one item at a time.")
    const [first, second] = itemBoxes(container)
    expect(first!.disabled).toBe(false)
    expect(second!.disabled).toBe(false)
    await act(async () => first!.click())
    expect(selectedCount(container)).toBe("1")
    await act(async () => second!.click())
    // Selecting a second item replaces the first.
    expect(selectedCount(container)).toBe("1")
    expect(second!.getAttribute("aria-checked")).toBe("true")
    expect(first!.getAttribute("aria-checked")).toBe("false")
    expect(buttonNamed(container, "Next")!.disabled).toBe(false)
  })

  it("leaves Pro unchanged: Select all selects every item, with Clear and per group selection", async () => {
    const container = await renderItems(false)
    const selectAll = buttonNamed(container, "Select all")!
    expect(selectAll.textContent).toBe("Select all")
    expect(selectAll.getAttribute("aria-disabled")).toBeNull()
    expect(container.querySelector('[aria-label="Select all configuration profile"]')).not.toBeNull()
    await act(async () => selectAll.click())
    expect(selectedCount(container)).toBe("2")
    await act(async () => buttonNamed(container, "Clear")!.click())
    expect(selectedCount(container)).toBe("0")
  })
})

it("reloads the open approval list after consecutive restores with the same result count", async () => {
  const container = await renderItems(false)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  let runs = 0
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (url.endsWith("/api/list-backup-contents")) return Response.json(contents)
    if (url.endsWith("/api/restore-preview")) return Response.json(preview)
    if (body.approvalAction === "detect") return Response.json({ enabled: true })
    if (body.approvalAction === "list") return Response.json({ records: Array.from({ length: runs }, (_, index) => ({ id: String(index), label: `Request ${index + 1}`, operation: "create", status: "needsApproval", stepNumber: 1, totalSteps: 1, canComplete: true })) })
    if (url.endsWith("/api/restore-backup")) {
      runs++
      return Response.json({ success: true, details: { results: body.selectedPolicies.map((item: { path: string }) => ({ path: item.path, success: false, approval: { kind: "pending", code: String(runs) }, approvalState: "submitted", error: "Submitted for approval" })) } })
    }
    return Response.json({})
  })
  vi.stubGlobal("fetch", fetcher)
  for (let run = 1; run <= 2; run++) {
    await act(async () => buttonNamed(container, "Select all")!.click())
    await act(async () => buttonNamed(container, "Next")!.click())
    await act(async () => buttonNamed(container, "Review")!.click())
    if (run === 1) await act(async () => buttonNamed(container, "Waiting for approval")!.click())
    fetcher.mockClear()
    await act(async () => buttonNamed(container, " Restore 2 items")!.click())
    expect(runs).toBe(run)
    expect(container.textContent).toContain(`Request ${run}`)
    const lists = fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init?.body ?? "{}")).approvalAction === "list")
    expect(lists).toHaveLength(1)
    expect(JSON.parse(String(lists[0]![1]?.body)).refresh).toBe(false)
    if (run === 1) await act(async () => buttonNamed(container, "Restore more items")!.click())
  }
})
