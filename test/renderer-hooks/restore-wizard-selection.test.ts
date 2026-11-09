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
})

// Two configuration profiles in one backup, so selecting several is possible on Pro.
const contents = { content: { groups: [{ folder: "DeviceConfigurations", label: "configuration profile", area: "Devices", policies: [{ path: "DeviceConfigurations/a.json", displayName: "Profile A" }, { path: "DeviceConfigurations/b.json", displayName: "Profile B" }] }] } }
const preview = { items: [{ path: "DeviceConfigurations/a.json", name: "Profile A" }, { path: "DeviceConfigurations/b.json", name: "Profile B" }] }

async function renderItems(community: boolean): Promise<HTMLDivElement> {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).endsWith("/api/list-backup-contents") ? contents : String(input).endsWith("/api/restore-preview") ? preview : {})))
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(RestoreWizard, {
    tenant: { name: "Contoso", credentials: { tenantId: "tenant", appId: "app", clientSecret: "" }, storageAccountName: "tvlocal-tenant" },
    backups: [{ id: "backup-1", timestamp: "2026-10-16T02:00:00Z", type: "manual", status: "Completed", totalPolicies: 2, scope: null, size: 1, duration: 4, changes: null, comparedWith: null }],
    initialBackupId: "backup-1", community, canCopyToTenants: false, copyCandidates: [],
  }))))
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
  const requests = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/restore-backup")
  expect(requests()).toHaveLength(0)
  await act(async () => buttonNamed(container, "Select all")!.click())
  await act(async () => buttonNamed(container, "Next")!.click())
  expect(requests()).toHaveLength(0)
  await act(async () => buttonNamed(container, "Review")!.click())
  expect(requests()).toHaveLength(1)
  expect(JSON.parse(String(requests()[0]![1]?.body))).toMatchObject({ approvalAction: "detect" })
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
