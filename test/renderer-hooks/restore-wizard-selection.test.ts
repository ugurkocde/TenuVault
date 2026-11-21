import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
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

async function renderItems(community: boolean, copyCandidates: Array<{ tenantId: string; appId: string; name: string }> = [], exposeRender?: (update: (targets: typeof copyCandidates) => void) => void): Promise<HTMLDivElement> {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).endsWith("/api/list-backup-contents") ? contents : String(input).endsWith("/api/restore-preview") ? preview : {})))
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  const render = (targets: typeof copyCandidates) => root.render(createElement(MemoryRouter, null, createElement(RestoreWizard, {
    tenant: { name: "Contoso", credentials: { tenantId: "tenant", appId: "app", clientSecret: "" }, storageAccountName: "tvlocal-tenant" },
    backups: [{ id: "backup-1", timestamp: "2026-10-16T02:00:00Z", type: "manual", status: "Completed", totalPolicies: 2, scope: null, size: 1, duration: 4, changes: null, comparedWith: null }],
    initialBackupId: "backup-1", community, canCopyToTenants: targets.length > 0, copyCandidates: targets,
  })))
  exposeRender?.(render)
  await act(async () => render(copyCandidates))
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

it.each([false, true])("retries legacy copies per destination when a later peer loses its license (%s)", async unlicensed => {
  const targets = ["First tenant", "Second tenant"].map((name, index) => ({ tenantId: `tenant-${index}`, appId: "app", name }))
  const container = await renderItems(false, targets)
  const path = "DeviceConfigurations/a.json"
  const calls: Array<Array<{ tenantId: string; selectedPolicies?: unknown }>> = []
  const probes: string[][] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/restore-preview")) return Response.json(preview)
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (body.approvalAction === "check-destinations") {
      probes.push(body.destinationIds)
      return Response.json({ grouped: false })
    }
    if (!body.targetTenants) return Response.json({ records: [] })
    calls.push(body.targetTenants)
    const destination = body.targetTenants[0].tenantId
    if (calls.length === 1) return Response.json({ details: { results: targets.map(target => ({
      path, targetTenantId: target.tenantId, success: false, retryable: true, error: "Retry the copy",
    })) } })
    if (body.targetTenants.length > 1 || unlicensed && destination === "tenant-1") {
      return Response.json({ error: "The later destination requires MSP.", upgrade: "bulkActions" }, { status: 402 })
    }
    if (unlicensed) return Response.json({ details: { results: [{ path, targetTenantId: destination, success: true }] } })
    return Response.json({ details: { results: [{ path, targetTenantId: destination, success: false, retryable: false,
      ...(calls.length === 2 ? { writeNotSent: true, error: "Write not sent: sign in again" } : { writeMayHaveCompleted: true, error: "Graph response lost" }),
    }] } })
  }))
  await act(async () => itemBoxes(container)[0]!.click())
  await act(async () => buttonNamed(container, "Next")!.click())
  for (const target of container.querySelectorAll<HTMLInputElement>('[aria-label="Tenants to copy to"] input')) await act(async () => target.click())
  await act(async () => buttonNamed(container, "Review")!.click())
  await act(async () => buttonNamed(container, " Restore 1 item")!.click())
  await act(async () => buttonNamed(container, " Retry failed items")!.click())
  expect(probes).toEqual([["tenant-0", "tenant-1"]])
  expect(calls.map(batch => batch.map(target => target.tenantId))).toEqual([["tenant-0", "tenant-1"], ["tenant-0"], ["tenant-1"]])
  expect(calls[1]?.some(target => target.selectedPolicies)).toBe(false)
  if (unlicensed) {
    expect(container.textContent).toContain("The later destination requires MSP.")
    expect(container.textContent).toContain("Copied")
    return
  }
  expect(container.textContent).toContain("Write not sent: sign in again")
  expect(container.textContent?.match(/a write may already have completed/g)).toHaveLength(1)
  expect([...container.querySelectorAll("li")].find(row => row.textContent?.includes("Write not sent"))?.textContent).not.toContain("a write may already have completed")
})

it("checks retry enrollment before requiring a disconnected destination's profile", async () => {
  const targets = ["Disconnected", "Healthy"].map((name, index) => ({ tenantId: `tenant-${index}`, appId: "app", name }))
  let render!: (next: typeof targets) => void
  const container = await renderItems(false, targets, update => { render = update })
  const path = "DeviceConfigurations/a.json"
  const calls: Array<Array<{ tenantId: string; appId?: string; selectedPolicies?: unknown }>> = []
  const probes: string[][] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/restore-preview")) return Response.json(preview)
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (body.approvalAction === "check-destinations") {
      probes.push(body.destinationIds)
      return Response.json({ grouped: false })
    }
    if (!body.targetTenants) return Response.json({ records: [] })
    calls.push(body.targetTenants)
    if (calls.length === 1) return Response.json({ details: { results: targets.map(target => ({
      path, targetTenantId: target.tenantId, success: false, retryable: true, error: "Retry the copy",
    })) } })
    return Response.json({ details: { results: [{ path, targetTenantId: "tenant-1", success: true }] } })
  }))
  await act(async () => itemBoxes(container)[0]!.click())
  await act(async () => buttonNamed(container, "Next")!.click())
  for (const target of container.querySelectorAll<HTMLInputElement>('[aria-label="Tenants to copy to"] input')) await act(async () => target.click())
  await act(async () => buttonNamed(container, "Review")!.click())
  await act(async () => buttonNamed(container, " Restore 1 item")!.click())
  await act(async () => render([targets[1]!]))
  await act(async () => buttonNamed(container, " Retry failed items")!.click())
  expect(probes).toEqual([["tenant-0", "tenant-1"]])
  expect(calls.slice(1)).toEqual([[{ tenantId: "tenant-1", appId: "app" }]])
  expect(container.textContent).toContain("Write not sent: the original target tenant is no longer connected.")
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
