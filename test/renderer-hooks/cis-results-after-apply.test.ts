import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appInfo = vi.hoisted(() => vi.fn())
const tenantId = "11111111-1111-1111-1111-111111111111"
const appId = "22222222-2222-2222-2222-222222222222"

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { app: { info: appInfo, openExternal: async () => undefined }, license: { open: async () => undefined }, reports: { saveFile: async () => ({ saved: false }) } },
}))
vi.mock("../../src/renderer/lib/framework-jobs", () => ({ useFrameworkJobs: () => [] }))
vi.mock("../../src/portal/contexts/TenantContext", () => ({
  useSelectedTenant: () => ({ selectedTenant: { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId } }, selectedTenantId: "local", setSelectedTenantId: () => undefined }),
  useTenants: () => [],
}))
vi.mock("../../src/renderer/lib/license", () => ({
  useTenantPlan: () => "pro",
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
  tenantLicense: () => undefined,
  tenantPlan: () => null,
}))
vi.mock("../../src/portal/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
// The history reports an apply through onApplied; this stand-in applies on a click.
vi.mock("../../src/renderer/features/cis-remediation/CisRemediationHistory", async importActual => {
  const actual = await importActual<typeof import("../../src/renderer/features/cis-remediation/CisRemediationHistory")>()
  const { createElement } = await import("react")
  return { ...actual, CisRemediationHistory: ({ onApplied }: { onApplied?: (at: string) => void }) => createElement("button", { type: "button", onClick: () => onApplied?.(new Date(Date.now() + 1000).toISOString()) }, "Simulate apply") }
})

import FrameworksPage from "../../src/renderer/pages/FrameworksPage"
import { refreshInternalCisBenchmarks, resetInternalCisBenchmarks } from "../../src/renderer/lib/internal-cis"
import { clearCisCatalogs } from "../../src/renderer/lib/cis-catalog-cache"
import { clearCisSettingNames } from "../../src/renderer/lib/cis-setting-names"

const ENCRYPTION = "device_vendor_msft_policy_config_lanmanworkstation_requireencryption"
const names = { settings: { [ENCRYPTION]: "Require Encryption" }, options: { [`${ENCRYPTION}_0`]: "Disabled", [`${ENCRYPTION}_1`]: "Enabled" } }
const instance = (value: string) => ({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: ENCRYPTION, choiceSettingValue: { value: `${ENCRYPTION}_${value}`, children: [] } })
const reference = "intune-windows11 5.0.0 Level 1"
const policy = { name: "Synthetic policy", platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark: "intune-windows11", version: "5.0.0", level: "Level 1", sourceFile: "s.json" }, settings: [{ settingInstance: instance("1") }] }
const saved = { runId: "run-saved", tenantId, frameworkId: "cis-benchmarks", reference, assessedAt: "2026-10-15T10:00:00Z", policyCount: 1,
  findings: [{ key: "0:0", policyIndex: 0, settingIndex: 0, policyName: "Synthetic policy", settingId: ENCRYPTION, status: "Different", recommended: instance("1"), observed: [{ policyId: "33333333-3333-3333-3333-333333333333", policyName: "Tenant policy", value: instance("0"), targeting: { state: "configured", targets: [], limitations: [] } }] }] }
const workspace = { version: 1, tenantId, frameworkId: "cis-benchmarks", policies: [policy], reference, updatedAt: "2026-10-15T10:00:00Z", history: [{ assessment: saved, policies: [policy] }], capacity: { count: 1, limit: 50, full: false, reason: null } }
const catalog = [{ id: "intune-windows11", name: "Microsoft Intune for Windows 11", version: "5.0.0", levels: [1, 2] }]

type Handler = (body: Record<string, unknown>) => Promise<Response> | Response
function stubService(handlers: Record<string, Handler> = {}) {
  const actions: Record<string, unknown>[] = []
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (path === "/api/cis-remediation") return Response.json({ deployments: [] })
    actions.push(body)
    const handler = handlers[String(body.action)]
    if (handler) return handler(body)
    if (body.action === "workspace-open") return Response.json({ workspace, activeJob: null })
    if (String(body.action).startsWith("workspace-")) return Response.json(workspace)
    if (body.action === "cis-catalog") return Response.json({ benchmarks: catalog })
    if (body.action === "cis-setting-names") return Response.json(names)
    return Response.json({ error: "unexpected" }, { status: 500 })
  }))
  return actions
}

const roots: Root[] = []
const containers: HTMLDivElement[] = []
function mount(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return container
}
const renderPage = () => mount(createElement(MemoryRouter, { initialEntries: ["/portal/frameworks/cis-benchmarks"] }, createElement(Routes, null, createElement(Route, { path: "/portal/frameworks/:frameworkId", element: createElement(FrameworksPage) }))))
async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error("Condition not met in time.")
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }
}
const buttonNamed = (container: HTMLElement, name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name)
const click = async (element: Element | undefined | null) => { await act(async () => { (element as HTMLElement).click() }) }

let scrolled: Element[]
beforeEach(() => {
  scrolled = []
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
  appInfo.mockResolvedValue({ internalCisBenchmarks: true })
})
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  resetInternalCisBenchmarks()
  clearCisCatalogs()
  clearCisSettingNames()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// A run that finishes at once; its results are assessed after anything applied before it.
const done = () => ({ jobId: "job-1", phase: "done", status: "done", state: "done", tenantId, frameworkId: "cis-benchmarks", read: 1, total: 1, currentPolicy: "", comparedPolicies: 1, packPolicies: 1, currentPackPolicy: "", findings: [], nextSince: 1, error: null,
  assessment: { ...saved, runId: "run-fresh", assessedAt: new Date(Date.now() + 5000).toISOString() } })
const freshRun = { "assess-start": () => Response.json({ jobId: "job-1" }), "assess-status": () => Response.json(done()) }

describe("CIS results after changes and exclusions", () => {
  it("says in visible text why Exclude from score is unavailable for findings already excluded", async () => {
    const excepted = { ...workspace, exceptions: [{ id: "ex-1", benchmark: "intune-windows11", version: "5.0.0", level: 1, policyName: "Synthetic policy", settingId: ENCRYPTION, owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", createdAt: "2026-10-01T12:00:00.000Z" }] }
    stubService({ ...freshRun, "workspace-open": () => Response.json({ workspace: excepted, activeJob: null }), "workspace-load": () => Response.json(excepted), "workspace-save": () => Response.json(excepted) })
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => !!buttonNamed(container, "Run again"))
    await click(buttonNamed(container, "Run again"))
    await waitFor(() => !container.textContent!.includes("Showing a saved assessment"))
    const box = () => container.querySelector(`input[aria-label="Select finding Require Encryption from Synthetic policy"]`)
    await waitFor(() => !!box())
    await click(box())
    const bar = container.querySelector('[aria-label="Selected findings"]')!
    expect([...bar.querySelectorAll("button")].find(item => item.textContent?.startsWith("Exclude from score"))!.disabled).toBe(true)
    expect(bar.textContent).toContain("Exclude from score is unavailable: the selected findings are already excluded.")
  })

  it("shows an export failure from the full history alert next to that alert, also during setup", async () => {
    const full = { ...workspace, capacity: { count: 50, limit: 50, full: true, reason: "count" } }
    stubService({ "workspace-open": () => Response.json({ workspace: full, activeJob: null }), "workspace-load": () => Response.json(full), "workspace-json": () => Response.json({ error: "Error: The export could not be built." }, { status: 500 }) })
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => !!buttonNamed(container, "New assessment"))
    await click(buttonNamed(container, "New assessment"))
    const alert = () => container.querySelector('[aria-label="Saved assessment history is full"]')!
    await waitFor(() => !!alert())
    await click([...alert().querySelectorAll("button")].find(item => item.textContent === "Export saved assessments JSON"))
    await waitFor(() => alert().textContent!.includes("The export could not be built."))
    expect(alert().textContent).not.toContain("Error: ")
  })

  it("marks results out of date after an apply and offers Run again", async () => {
    const actions = stubService()
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => !!buttonNamed(container, "Simulate apply"))
    expect(container.querySelector('[aria-label="Results out of date"]')).toBeNull()
    await click(buttonNamed(container, "Simulate apply"))
    const notice = container.querySelector('[aria-label="Results out of date"]')!
    expect(notice.textContent).toMatch(/^Out of date: changes were applied at .+\. Run again to verify\./)
    stubService(freshRun)
    await click([...notice.querySelectorAll("button")].find(item => item.textContent === "Run again"))
    await waitFor(() => !container.querySelector('[aria-label="Results out of date"]'))
    expect(actions.length).toBeGreaterThan(0)
  })

  it("excludes the selected findings in one request, keeps refused ones selected and brings the exclusions into view", async () => {
    const batches: Record<string, unknown>[] = []
    let refuse = true
    stubService({ ...freshRun, "workspace-cis-exception-add-batch": body => {
      batches.push(body)
      return Response.json({ workspace, results: refuse ? [{ ok: false, error: "An active exception already exists for this finding." }] : [{ ok: true, exceptionId: "ex-1" }] })
    } })
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => !!buttonNamed(container, "Run again"))
    await click(buttonNamed(container, "Run again"))
    await waitFor(() => !container.textContent!.includes("Showing a saved assessment"))
    const box = () => container.querySelector(`input[aria-label="Select finding Require Encryption from Synthetic policy"]`)
    await waitFor(() => !!box())
    await click(box())
    await click(buttonNamed(container, "Exclude from score (1)"))
    const dialog = () => document.body.querySelector('[role="dialog"]')!
    const fill = async (label: string, value: string) => {
      const input = [...dialog().querySelectorAll("label")].find(item => item.textContent?.startsWith(label))!.querySelector("input")!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
    }
    await fill("Owner", "Owner")
    await fill("Expiry date", "2099-01-01")
    await fill("Reason", "Accepted")
    await act(async () => { (dialog().querySelector("form") as HTMLFormElement).requestSubmit() })
    await waitFor(() => dialog()?.textContent?.includes("Excluded 0 of 1 findings. Not excluded: Require Encryption in Synthetic policy: An active exception already exists for this finding.") ?? false)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ owner: "Owner", reason: "Accepted", expiresOn: "2099-01-01", items: [{ benchmark: "intune-windows11", version: "5.0.0", level: 1, policyName: "Synthetic policy", settingId: ENCRYPTION }] })
    refuse = false
    await act(async () => { (dialog().querySelector("form") as HTMLFormElement).requestSubmit() })
    await waitFor(() => !document.body.querySelector('[role="dialog"]'))
    expect(batches).toHaveLength(2)
    await waitFor(() => scrolled.includes(container.querySelector("details summary#cis-exclusions")!.parentElement!))
  })
})
