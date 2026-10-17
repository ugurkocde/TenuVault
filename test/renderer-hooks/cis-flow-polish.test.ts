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

import FrameworksPage from "../../src/renderer/pages/FrameworksPage"
import { CisRemediationHistory } from "../../src/renderer/features/cis-remediation/CisRemediationHistory"
import { DiffList } from "../../src/renderer/features/shared/DiffList"
import { ChangeSetFlow } from "../../src/renderer/features/shared/ChangeSetFlow"
import { diffConfigurations } from "../../src/main/features/change-sets/model"
import { typeForFolder, type Item } from "../../src/shared/intune/registry"
import { MAX_SETTING_LEAVES } from "../../src/shared/frameworks/setting-summary"
import { refreshInternalCisBenchmarks, resetInternalCisBenchmarks } from "../../src/renderer/lib/internal-cis"
import { cachedCisCatalog, clearCisCatalogs, rememberCisCatalog } from "../../src/renderer/lib/cis-catalog-cache"
import { clearCisSettingNames } from "../../src/renderer/lib/cis-setting-names"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

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

describe("CIS flow on the page", () => {
  it("loads the catalog on open, before any click, and shows ids only as secondary text", async () => {
    const actions = stubService()
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => actions.some(action => action.action === "cis-catalog"))
    await waitFor(() => !!cachedCisCatalog(tenantId))
    await click(buttonNamed(container, "New assessment"))
    const card = container.querySelector('[aria-label="Available benchmarks"] > div')!
    expect(card.querySelector("p")!.textContent).toBe("Microsoft Intune for Windows 11")
    expect(card.textContent).toContain("Version 5.0.0")
    expect(card.querySelector(".font-mono")!.textContent).toBe("intune-windows11")
    expect(buttonNamed(container, "Load available benchmarks")).toBeUndefined()
  })

  it("keeps cached benchmarks when a refresh fails and offers Retry next to them", async () => {
    rememberCisCatalog(tenantId, catalog as never)
    let failing = true
    const actions = stubService({ "cis-catalog": () => failing ? Response.json({ error: "Error: The delivery service is unavailable." }, { status: 502 }) : Response.json({ benchmarks: catalog }) })
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => !!buttonNamed(container, "New assessment"))
    await click(buttonNamed(container, "New assessment"))
    await waitFor(() => container.textContent!.includes("The delivery service is unavailable."))
    const alert = [...container.querySelectorAll('[role="alert"]')].find(item => item.textContent!.includes("delivery service"))!
    expect(alert.textContent).toContain("The benchmarks listed below were loaded earlier.")
    expect(container.querySelector('[aria-label="Available benchmarks"]')).not.toBeNull()
    expect(cachedCisCatalog(tenantId)).toHaveLength(1)
    failing = false
    await click([...alert.querySelectorAll("button")].find(item => item.textContent === "Retry"))
    await waitFor(() => !container.textContent!.includes("The delivery service is unavailable."))
    expect(actions.filter(action => action.action === "cis-catalog").length).toBeGreaterThanOrEqual(2)
  })

  it("drops a catalog answer, entries and error alike, once a run started after it was sent", async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    const actions = stubService({
      "cis-catalog": () => pending,
      "assess-start": () => Response.json({ jobId: "job-1" }),
      "assess-status": () => Response.json({ jobId: "job-1", phase: "reading", status: "running", state: "running", tenantId, frameworkId: "cis-benchmarks", read: 1, total: 4, currentPolicy: "", comparedPolicies: 0, packPolicies: 1, currentPackPolicy: "", findings: [], nextSince: 0, error: null, assessment: null }),
    })
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => actions.some(action => action.action === "cis-catalog") && !!buttonNamed(container, "Run again"))
    await click(buttonNamed(container, "Run again"))
    await waitFor(() => actions.some(action => action.action === "assess-start"))
    await act(async () => { release(Response.json({ benchmarks: catalog })); await new Promise(resolve => setTimeout(resolve, 30)) })
    // The late answer neither fills the catalog nor its cache.
    expect(cachedCisCatalog(tenantId)).toBeNull()
    expect(container.querySelector('[aria-label="Available benchmarks"]')).toBeNull()
  })

  it("shows finding detail by setting name and option label, with the raw id as secondary text", async () => {
    stubService()
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => container.textContent!.includes("Require Encryption"))
    const row = container.querySelector(`input[aria-label="Select finding Require Encryption from Synthetic policy"]`)!.closest("div")!
    const summary = row.querySelector("summary")!
    expect(summary.querySelector(".font-mono")!.textContent).toBe(ENCRYPTION)
    expect([...summary.querySelectorAll("span")].some(span => span.textContent === "Require Encryption")).toBe(true)
    const lists = [...row.querySelectorAll("ul li")].map(item => item.textContent)
    expect(lists).toContain("Require Encryption: Selected option: Enabled")
    expect(lists).toContain("Require Encryption: Selected option: Disabled")
    expect(lists.some(text => /lanmanworkstation|_[01]\b/.test(text ?? ""))).toBe(false)
    // The tenant name is in the results header.
    expect(container.querySelector('[aria-label="Results header"]')!.textContent).toContain("Synthetic tenant")
  })

  it("names a nested macOS finding without the generic group collection name", async () => {
    const group = "com.apple.systempolicy.control_com.apple.systempolicy.control"
    const child = "com.apple.systempolicy.control_enableassessment"
    const gatekeeper = (value: string) => ({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance", settingDefinitionId: group, groupSettingCollectionValue: [{ children: [{ "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: child, choiceSettingValue: { value: `${child}_${value}`, children: [] } }] }] })
    const macPolicy = { ...policy, name: "macOS policy", platforms: "macOS", settings: [{ settingInstance: gatekeeper("true") }] }
    const finding = { ...saved.findings[0]!, policyName: "macOS policy", settingId: group, recommended: gatekeeper("true"), observed: [{ ...saved.findings[0]!.observed[0]!, value: gatekeeper("false") }] }
    const macWorkspace = { ...workspace, policies: [macPolicy], history: [{ assessment: { ...saved, findings: [finding] }, policies: [macPolicy] }] }
    // Names cached before the generic name was left out still hold it.
    const stale = { settings: { [group]: "Top Level Setting Group Collection", [child]: "Enable Assessment" }, options: { [`${child}_true`]: "True", [`${child}_false`]: "False" } }
    stubService({ "workspace-open": () => Response.json({ workspace: macWorkspace, activeJob: null }), "cis-setting-names": () => Response.json(stale) })
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => container.textContent!.includes("Enable Assessment"))
    const row = container.querySelector('input[aria-label="Select finding Com.apple.systempolicy.control from macOS policy"]')!.closest("div")!
    expect(row.querySelector("summary .font-mono")!.textContent).toBe(group)
    const lists = [...row.querySelectorAll("ul li")].map(item => item.textContent)
    expect(lists).toContain("com.apple.systempolicy.control: Enable Assessment: Selected option: True")
    expect(container.textContent).not.toContain("Top Level Setting Group Collection")
  })

  it("streams partial results grouped by policy and setting name, with nothing to select", async () => {
    stubService({
      "assess-start": () => Response.json({ jobId: "job-1" }),
      "assess-status": () => Response.json({ jobId: "job-1", phase: "comparing", status: "running", state: "running", tenantId, frameworkId: "cis-benchmarks", read: 4, total: 4, currentPolicy: "", comparedPolicies: 1, packPolicies: 1, currentPackPolicy: "Synthetic policy", findings: saved.findings, nextSince: 1, error: null, assessment: null }),
      "workspace-open": () => Response.json({ workspace: { ...workspace, history: [] }, activeJob: null }),
    })
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => !!buttonNamed(container, "Start Assessment") && !buttonNamed(container, "Start Assessment")!.disabled)
    await click(buttonNamed(container, "Start Assessment"))
    await waitFor(() => !!container.querySelector('[aria-label="Partial results"]') && container.textContent!.includes("Require Encryption"))
    const partial = container.querySelector('[aria-label="Partial results"]')!
    expect(partial.querySelector('section[aria-label="Synthetic policy"] h4')!.textContent).toContain("1 different")
    expect(partial.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect([...partial.querySelectorAll("summary span")].some(span => span.textContent === "Require Encryption")).toBe(true)
  })

  it("brings saved assessments and a read-only view into view", async () => {
    stubService()
    await refreshInternalCisBenchmarks()
    const container = renderPage()
    await waitFor(() => !!buttonNamed(container, "Saved assessments (1)"))
    await click(buttonNamed(container, "Saved assessments (1)"))
    const panel = container.querySelector('details[aria-label="Saved assessment history"]') as HTMLDetailsElement
    expect(panel.open).toBe(true)
    expect(scrolled).toContain(panel)
    await click(buttonNamed(container, "View read-only"))
    await waitFor(() => scrolled.includes(container.querySelector('[aria-label="Results header"]')!))
  })
})

describe("CIS remediation history", () => {
  const tenant = { id: "local", name: "Synthetic tenant", credentials: { tenantId, appId } } as unknown as Tenant
  const ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const deployment = { id: ID, title: "Remediate Microsoft Intune for Windows 11 5.0.0 Level 1 findings", createdAt: "2026-10-15T11:00:00Z", updatedAt: "2026-10-15T11:00:00Z", status: "approved", summary: "", tenantId, reference, runId: "run-1", benchmarkName: null,
    items: [{ policyIndex: 0, policyName: "Synthetic policy", action: "update", targetId: "t1", targetName: "Tenant policy", findingKeys: ["0:0"], assignedExposure: true, assignmentCount: 2 }], changeSetId: "cs", rollbackChangeSetId: null }
  const diff = [{ path: `settings.${ENCRYPTION}.settingInstance.choiceSettingValue.value`, change: "changed", before: `${ENCRYPTION}_0`, after: `${ENCRYPTION}_1` }]
  const changeSet = { id: "cs", tenantId, createdAt: "2026-10-15T11:00:00Z", updatedAt: "2026-10-15T11:00:00Z", title: deployment.title, kind: "change", ticket: null, status: "approved", sourceVersion: reference,
    origin: { workflow: "cis-remediation", recordId: ID }, contentHash: "0".repeat(64), lastError: null, review: null, results: {},
    operations: [{ key: "op-1", folder: "ConfigurationPolicies", action: "update", targetId: "t1", name: "Tenant policy", setsAssignments: false, diff, diffTruncated: false, source: { label: "Synthetic" } }],
    preChange: null, history: [{ at: "2026-10-15T11:00:00Z", actor: "Ada Admin", reason: "Created" }] }
  const preview = { id: "cs", status: "approved", contentHash: "0".repeat(64), targetFingerprint: "1".repeat(64), observedAt: "2026-10-15T11:05:00Z", operations: [], affectedObjects: [], blockers: [], irreversible: [], unsupportedRecovery: [], approval: { valid: true, reason: null }, notice: "Preview." }

  function stubRemediation(applied: () => void) {
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (path === "/api/frameworks") return Response.json(body.action === "cis-setting-names" ? names : { error: "unexpected" }, { status: body.action === "cis-setting-names" ? 200 : 500 })
      if (body.action === "list") return Response.json({ deployments: [deployment] })
      if (body.action === "get") return Response.json({ deployment, changeSet, rollbackChangeSet: null })
      if (body.action === "preview") return Response.json({ changeSet: preview })
      if (body.action === "apply") { applied(); return Response.json({ deployment, changeSet: { ...changeSet, status: "applied" } }) }
      return Response.json({ error: "unexpected" }, { status: 500 })
    }))
  }

  it("scrolls a planned deployment into view and shows it once, by admin, in plain words, then reports the apply", async () => {
    let applies = 0
    stubRemediation(() => { applies += 1 })
    const onApplied = vi.fn()
    const container = mount(createElement(CisRemediationHistory, { tenant, focus: { id: ID, at: 1 }, onApplied }))
    await waitFor(() => container.textContent!.includes("Operations (1)"))
    const row = container.querySelector("li")!
    expect(scrolled).toContain(row)
    // The list row names the deployment and its status; the opened plan does not repeat them.
    expect(container.textContent!.split(deployment.title)).toHaveLength(2)
    expect(container.textContent!.match(/approved/g)).toHaveLength(1)
    expect(container.textContent).not.toContain("cis-remediation")
    expect(container.textContent).toContain("Created")
    expect(container.textContent).toContain("by Ada Admin")
    expect(container.textContent).toContain("Source version Microsoft Intune for Windows 11 5.0.0 Level 1.")
    expect(container.textContent).not.toContain("intune-windows11")
    expect(container.textContent).toContain("Updates 1 existing tenant policy in place for the Different findings. 1 of them is assigned and keeps its assignments")
    // The planned difference reads by setting and option name.
    await click([...container.querySelectorAll("button")].find(item => item.textContent?.includes("Tenant policy")))
    await waitFor(() => container.textContent!.includes("Require Encryption: Disabled to Enabled"))
    expect(container.querySelector("li li .font-mono")!.textContent).toBe(diff[0]!.path)
    await click(buttonNamed(container, "Apply to tenant"))
    await waitFor(() => !!document.body.querySelector('[role="dialog"] input[type="checkbox"]'))
    await click(document.body.querySelector('[role="dialog"] input[type="checkbox"]'))
    await click([...document.body.querySelectorAll('[role="dialog"] button')].find(item => item.textContent?.includes("Back up and apply")))
    await waitFor(() => onApplied.mock.calls.length === 1)
    expect(applies).toBe(1)
    expect(typeof onApplied.mock.calls[0]![0]).toBe("string")
  })

  it("lists a raw difference unchanged without names", () => {
    const container = mount(createElement(DiffList, { entries: diff as never }))
    expect(container.textContent).toContain(`changed ${diff[0]!.path}: ${ENCRYPTION}_0 to ${ENCRYPTION}_1`)
  })
})

describe("long setting lists in a deployment", () => {
  const type = typeForFolder("ConfigurationPolicies")!
  const simple = (index: number) => ({ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: `synthetic_value_${index}`, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value: index } } })
  const created = (count: number) => diffConfigurations(type, null, { name: "Large", description: "", platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings: Array.from({ length: count }, (_, index) => simple(index)) } as unknown as Item).entries

  it("shows 40 of 41 settings inline and every one behind an expand", () => {
    const container = mount(createElement(DiffList, { entries: created(41), names: { settings: {}, options: {} } }))
    expect(container.textContent).toContain("Showing 40 of 41 settings.")
    const expand = container.querySelector("details")!
    expect(expand.querySelector("summary")!.textContent).toBe("Show all 41 listed settings")
    expect(expand.querySelectorAll("li")).toHaveLength(41)
    expect(container.textContent).not.toContain("not listed here")
  })

  it("says before approval when a policy holds more values than were recorded", async () => {
    const diff = created(MAX_SETTING_LEAVES + 2)
    const changeSet = { id: "cs", tenantId, createdAt: "2026-10-15T11:00:00Z", updatedAt: "2026-10-15T11:00:00Z", title: "Deploy", kind: "change", ticket: null, status: "in-review", sourceVersion: reference,
      origin: { workflow: "cis-remediation", recordId: "r" }, contentHash: "0".repeat(64), lastError: null, review: null, results: {},
      operations: [{ key: "op-1", folder: "ConfigurationPolicies", action: "create", targetId: null, name: "Large", setsAssignments: false, diff, diffTruncated: false, source: { label: "Synthetic" } }], preChange: null, history: [] }
    const preview = { id: "cs", status: "in-review", contentHash: "0".repeat(64), targetFingerprint: "1".repeat(64), observedAt: "2026-10-15T11:05:00Z", operations: [{ key: "op-1", diff, diffTruncated: false, blockers: [], warnings: [] }], affectedObjects: [], blockers: [], irreversible: [], unsupportedRecovery: [], approval: { valid: false, reason: "Not approved yet." }, notice: "Preview." }
    const fail = async () => { throw new Error("unused") }
    const actions = { preview: async () => preview, approve: fail, reject: fail, apply: fail, retry: fail, rollbackPreview: fail, rollbackCreate: fail }
    const container = mount(createElement(ChangeSetFlow, { changeSet: changeSet as never, actions: actions as never, tenantName: "Synthetic tenant", onChanged: () => undefined, settingNames: { settings: {}, options: {} } }))
    await click(buttonNamed(container, "Review against the live tenant"))
    await waitFor(() => !!container.querySelector('section[aria-label="Review"]'))
    expect(container.querySelector('section[aria-label="Review"] [role="alert"]')!.textContent).toBe("2 setting values are not listed in the differences above. Approving covers them too: inspect the policy content before you approve.")
    expect(buttonNamed(container, "Approve this content and target state")).toBeDefined()
    await click([...container.querySelectorAll("section[aria-label=Operations] li > button")][0])
    expect(container.textContent).toContain(`Showing 40 of ${MAX_SETTING_LEAVES + 2} settings.`)
    expect(container.textContent).toContain("2 more settings are not listed here. Inspect the policy content before you approve.")
  })
})
