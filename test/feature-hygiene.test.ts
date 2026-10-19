import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { detectHygiene, overlap, RULES, type GroupState, type InventoryItem } from "../src/main/features/hygiene/rules"
import { routes, signals } from "../src/main/features/hygiene"
import type { Item } from "../src/shared/intune/registry"
import type { GraphCall } from "../src/portal/lib/policies/graph-restore"
import { call, fakeDeps, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"

/** fakeDeps assigns `graph` directly, so the fake returns the caller itself. */
const graphOf = (fn: GraphCall) => (() => fn) as never

const G1 = "aaaaaaaa-0000-0000-0000-000000000001"
const G2 = "aaaaaaaa-0000-0000-0000-000000000002"
const FILTER = "ffffffff-0000-0000-0000-000000000001"

const allDevices = (filterId: string | null = null): Item => ({ target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget", deviceAndAppManagementAssignmentFilterId: filterId, deviceAndAppManagementAssignmentFilterType: filterId ? "include" : "none" } })
const group = (groupId: string): Item => ({ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId, deviceAndAppManagementAssignmentFilterId: null, deviceAndAppManagementAssignmentFilterType: "none" } })
const exclude = (groupId: string): Item => ({ target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId } })

function choice(definitionId: string, value: string): Item {
  return { id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: definitionId, choiceSettingValue: { value, children: [], settingValueTemplateReference: null } } }
}

function catalog(id: string, name: string, settings: Item[], assignments: Item[], extra: Item = {}): InventoryItem {
  return { folder: "ConfigurationPolicies", id, name, snapshot: { id, name, platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings, assignments, ...extra } }
}

const COVERED = new Set(["ConfigurationPolicies", "AssignmentFilters", "ScopeTags", "DeviceConfigurations"])
const detect = (items: InventoryItem[], covered = COVERED, groups = new Map<string, GroupState>()) => detectHygiene({ items, covered, groups })

describe("hygiene rules", () => {
  it("finds a definite conflict when two policies include the same target without filters or exclusions", () => {
    const a = catalog("p1", "Firewall A", [choice("firewall_enable", "on")], [allDevices()])
    const b = catalog("p2", "Firewall B", [choice("firewall_enable", "off")], [allDevices()])
    const { findings } = detect([a, b])
    const conflict = findings.find((f) => f.ruleId === "conflicting-setting")
    expect(conflict?.classification).toBe("definite")
    expect(conflict?.settings[0]?.values.map((v) => v.display).sort()).toEqual(["off", "on"])
    expect(conflict?.policies.map((p) => p.id)).toEqual(["p1", "p2"])
  })

  it("does not report a conflict when the values are the same", () => {
    const a = catalog("p1", "A", [choice("s", "on")], [allDevices()])
    const b = catalog("p2", "B", [choice("s", "on"), choice("t", "x")], [allDevices()])
    expect(detect([a, b]).findings.some((f) => f.ruleId === "conflicting-setting")).toBe(false)
  })

  it("keeps different groups and filters as possible overlap, not definite", () => {
    const a = catalog("p1", "A", [choice("s", "on")], [group(G1)])
    const b = catalog("p2", "B", [choice("s", "off")], [group(G2)])
    expect(detect([a, b]).findings.find((f) => f.ruleId === "conflicting-setting")?.classification).toBe("possible")
    const c = catalog("p3", "C", [choice("s", "on")], [allDevices(FILTER)])
    const d = catalog("p4", "D", [choice("s", "off")], [allDevices()])
    expect(overlap(c, d)).toBe("possible")
  })

  it("treats an include excluded by the other policy as intentional targeting, not a conflict", () => {
    const pilot = catalog("p1", "Pilot", [choice("s", "on")], [group(G1)])
    const broad = catalog("p2", "Broad", [choice("s", "off")], [allDevices(), exclude(G1)])
    expect(overlap(pilot, broad)).toBe("none")
    expect(detect([pilot, broad]).findings.some((f) => f.ruleId === "conflicting-setting")).toBe(false)
    // An exclusion elsewhere still leaves the shared include only possible.
    const other = catalog("p3", "Other", [choice("s", "off")], [allDevices(), exclude(G2)])
    const all = catalog("p4", "All", [choice("s", "on")], [allDevices()])
    expect(overlap(all, other)).toBe("possible")
  })

  it("ignores unassigned policies for conflicts but reports them as unassigned", () => {
    const a = catalog("p1", "A", [choice("s", "on")], [allDevices()])
    const b = catalog("p2", "Unused", [choice("s", "off")], [])
    const { findings } = detect([a, b])
    expect(findings.some((f) => f.ruleId === "conflicting-setting")).toBe(false)
    expect(findings.find((f) => f.ruleId === "unassigned-policy")?.policies[0]?.id).toBe("p2")
  })

  it("reports duplicates of the same type regardless of name, assignments and scope tags", () => {
    const a = catalog("p1", "Copy 1", [choice("s", "on")], [allDevices()])
    const b = catalog("p2", "Copy 2", [{ ...choice("s", "on"), id: "7" }], [group(G1)], { roleScopeTagIds: ["0"] })
    const c = catalog("p3", "Different", [choice("s", "off")], [])
    const dup = detect([a, b, c]).findings.filter((f) => f.ruleId === "duplicate-profile")
    expect(dup).toHaveLength(1)
    expect(dup[0]?.policies.map((p) => p.id)).toEqual(["p1", "p2"])
  })

  it("reports missing filters and scope tags only when those types were collected", () => {
    const item = catalog("p1", "A", [], [allDevices(FILTER)], { roleScopeTagIds: ["0", "9"] })
    const tag: InventoryItem = { folder: "ScopeTags", id: "1", name: "Tag", snapshot: { id: "1", displayName: "Tag", assignments: [] } }
    const covered = detect([item, tag])
    expect(covered.findings.find((f) => f.ruleId === "missing-filter")?.details.filterId).toBe(FILTER)
    expect(covered.findings.find((f) => f.ruleId === "missing-scope-tag")?.details.scopeTagId).toBe("9")

    const partial = detect([item, tag], new Set(["ConfigurationPolicies"]))
    expect(partial.findings.some((f) => f.ruleId === "missing-filter" || f.ruleId === "missing-scope-tag")).toBe(false)
    expect(partial.unknowns.map((u) => u.ruleId).sort()).toEqual(["missing-filter", "missing-scope-tag"])
  })

  it("keeps unreadable groups unknown and reports only groups Graph says do not exist", () => {
    const item = catalog("p1", "A", [], [group(G1), exclude(G2)])
    const unknown = detect([item])
    expect(unknown.findings.some((f) => f.ruleId === "missing-group")).toBe(false)
    expect(unknown.unknowns.find((u) => u.ruleId === "missing-group")?.count).toBe(1)
    const resolved = detect([item], COVERED, new Map([[G1, "exists"], [G2, "missing"]]))
    expect(resolved.findings.find((f) => f.ruleId === "missing-group")?.details.groupId).toBe(G2)
  })

  it("names the Group.Read.All opt-in in the unresolved groups rule limits only", () => {
    expect(RULES["missing-group"].limits).toContain("Group.Read.All")
    expect(RULES["missing-group"].limits).toContain("-IncludeGroupRead")
    for (const rule of Object.values(RULES)) {
      if (rule.id === "missing-group") continue
      expect(rule.limits).not.toContain("Group.Read.All")
      expect(rule.limits).not.toContain("-IncludeGroupRead")
    }
    // Other rules keep their unknown wording free of the group hint.
    const item = catalog("p1", "A", [], [allDevices(FILTER)])
    const partial = detect([item], new Set(["ConfigurationPolicies"]))
    expect(partial.unknowns.find((u) => u.ruleId === "missing-filter")?.reason).not.toContain("Group.Read.All")
  })

  it("never puts snapshot secrets into evidence", () => {
    const secret = (value: string): Item => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "wifi_key", simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", value } } })
    const a = catalog("p1", "A", [secret("hunter2")], [allDevices()])
    const b = catalog("p2", "B", [secret("letmein")], [allDevices()])
    const text = JSON.stringify(detect([a, b]))
    expect(text).not.toContain("hunter2")
    expect(text).not.toContain("letmein")
  })

  it("skips types that were not collected", () => {
    const a = catalog("p1", "A", [choice("s", "on")], [])
    expect(detect([a], new Set()).findings).toHaveLength(0)
  })
})

/** A backup with two conflicting policies and one broken filter reference. */
function backupApi(options: { listStatus?: number; policies?: Item[]; metadata?: Item; backups?: Item[] } = {}) {
  const policies = options.policies ?? [
    { id: "p1", name: "Firewall A", platforms: "windows10", settings: [choice("fw", "on")], assignments: [allDevices()], roleScopeTagIds: ["0"] },
    { id: "p2", name: "Firewall B", platforms: "windows10", settings: [choice("fw", "off")], assignments: [allDevices(FILTER)], roleScopeTagIds: ["0"] },
  ]
  const calls: string[] = []
  const api = async (path: string, _tenant: string, body: Record<string, unknown> = {}) => {
    calls.push(path)
    if (path === "/api/list-backups") {
      if (options.listStatus) return Response.json({ error: "Missing storage permissions" }, { status: options.listStatus })
      return Response.json({ backups: options.backups ?? [{ id: "backup-2026-09-29-020000", timestamp: "2026-09-29T02:00:00Z", status: "Success" }] })
    }
    if (path === "/api/list-backup-contents") {
      return Response.json({ content: { groups: [{ folder: "ConfigurationPolicies", policies: policies.map((p) => ({ path: `${body.backupId}/ConfigurationPolicies/${p.id}.json` })) }], metadata: options.metadata ?? { Status: "Success", Scope: { Excluded: ["Apps"] }, SkippedTypes: [], FailedTypes: [] } } })
    }
    if (path === "/api/restore-preview") {
      const paths = body.paths as string[]
      return Response.json({ items: paths.map((path) => ({ path, folder: "ConfigurationPolicies", snapshot: policies.find((p) => path.endsWith(`/${p.id}.json`)) })) })
    }
    return Response.json({ error: "unexpected" }, { status: 500 })
  }
  return { api, calls }
}

describe("/api/hygiene", () => {
  it("saves a 300-finding scan with one store write before returning", async () => {
    const policies = Array.from({ length: 300 }, (_, number) => ({ id: `p${number}`, name: `Policy ${number}`, platforms: "windows10", settings: [choice(`setting_${number}`, "on")], assignments: [], roleScopeTagIds: ["0"] }))
    const { api } = backupApi({ policies })
    const deps = fakeDeps({ api })
    const write = vi.spyOn(deps.store, "setMany")
    const result = await call(routes(deps), "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect(result.status).toBe(200)
    expect(result.body.findings).toHaveLength(300)
    expect(write).toHaveBeenCalledTimes(1)
    expect(deps.records.list("hygiene-findings", TENANT_A)).toHaveLength(301)
  })

  it("scans the latest complete backup, shows collection date and coverage, and marks uncovered types", async () => {
    const { api } = backupApi()
    const deps = fakeDeps({ api, graph: graphOf(async () => ({ status: 403, body: {} })) })
    const r = routes(deps)
    const res = await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect(res.status).toBe(200)
    const scan = res.body.scans[0]
    expect(scan.collectedAt).toBe("2026-09-29T02:00:00Z")
    expect(scan.notCollected.find((n: { folder: string }) => n.folder === "Apps")?.reason).toBe("excluded")
    expect(scan.covered).toContain("ConfigurationPolicies")
    // Filters were collected (empty) so the filter reference is definitely broken.
    expect(res.body.findings.some((f: { ruleId: string }) => f.ruleId === "missing-filter")).toBe(true)
    // The filtered target makes the conflict only possible.
    expect(res.body.findings.find((f: { ruleId: string }) => f.ruleId === "conflicting-setting")?.classification).toBe("possible")
    expect(scan.groupResolution.state).toBe("none")
  })

  it("fails without storing anything when backup storage denies the read", async () => {
    const { api } = backupApi({ listStatus: 403 })
    const deps = fakeDeps({ api })
    const res = await call(routes(deps), "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect(res.status).toBe(502)
    expect(res.body.error).toContain("Missing storage permissions")
    expect((await call(routes(deps), "/api/hygiene", { tenantId: TENANT_A, action: "list" })).body.findings).toEqual([])
  })

  it("marks the scan partial and leaves failed types uncovered", async () => {
    const { api } = backupApi({ backups: [{ id: "backup-2026-09-29-020000", timestamp: "2026-09-29T02:00:00Z", status: "CompletedWithWarnings" }], metadata: { Status: "CompletedWithWarnings", Scope: { Excluded: [] }, SkippedTypes: [], FailedTypes: ["AssignmentFilters"] } })
    const res = await call(routes(fakeDeps({ api })), "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect(res.body.scans[0].completeness).toBe("partial")
    expect(res.body.findings.some((f: { ruleId: string }) => f.ruleId === "missing-filter")).toBe(false)
    expect(res.body.scans[0].unknowns.some((u: { ruleId: string }) => u.ruleId === "missing-filter")).toBe(true)
  })

  it("prefers a complete backup reported with an equivalent status over a newer one with warnings", async () => {
    const { api, calls } = backupApi({ backups: [{ id: "backup-2026-09-30-020000", timestamp: "2026-09-30T02:00:00Z", status: "CompletedWithWarnings" }, { id: "backup-2026-09-29-020000", timestamp: "2026-09-29T02:00:00Z", status: "Succeeded" }] })
    const res = await call(routes(fakeDeps({ api, graph: graphOf(async () => ({ status: 403, body: {} })) })), "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect(res.status).toBe(200)
    expect(calls).toContain("/api/restore-preview")
    expect(res.body.scans[0].collectedAt).toBe("2026-09-29T02:00:00Z")
    expect(res.body.scans[0].completeness).toBe("complete")
  })

  it("keeps group references unknown when Graph denies group reads", async () => {
    const policies = [{ id: "p1", name: "A", platforms: "windows10", settings: [], assignments: [group(G1)], roleScopeTagIds: ["0"] }]
    const { api } = backupApi({ policies })
    const res = await call(routes(fakeDeps({ api, graph: graphOf(async () => ({ status: 403, body: {} })) })), "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect(res.body.scans[0].groupResolution.state).toBe("unavailable")
    expect(res.body.findings.some((f: { ruleId: string }) => f.ruleId === "missing-group")).toBe(false)
    const paths: string[] = []
    const found = await call(routes(fakeDeps({ api, graph: graphOf(async (_m, path) => (paths.push(path), { status: 404, body: {} })) })), "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect(paths[0]).toBe(`groups/${G1}?$select=id`)
    expect(found.body.findings.some((f: { ruleId: string }) => f.ruleId === "missing-group")).toBe(true)
  })

  it("resolves a missing group finding once no assignment references a group", async () => {
    let policies: Item[] = [{ id: "p1", name: "A", platforms: "windows10", settings: [], assignments: [group(G1)], roleScopeTagIds: ["0"] }]
    let clock = Date.parse("2026-09-30T12:00:00Z")
    const deps = fakeDeps({ api: (path, tenant, body) => backupApi({ policies }).api(path, tenant, body), graph: graphOf(async () => ({ status: 404, body: {} })), now: () => new Date(clock) })
    const r = routes(deps)
    const first = await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    const missing = first.body.findings.find((f: { ruleId: string }) => f.ruleId === "missing-group")
    expect(missing.status).toBe("open")
    policies = [{ ...policies[0]!, assignments: [allDevices()] }]
    clock += 60_000
    const second = await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect(second.body.scans[0].groupResolution.state).toBe("none")
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "get", findingId: missing.id })).body.finding.status).toBe("resolved")
  })

  it("explains the Group.Read.All opt-in where the unresolved groups rule reports unknown", async () => {
    const policies = [{ id: "p1", name: "A", platforms: "windows10", settings: [], assignments: [group(G1)], roleScopeTagIds: ["0"] }]
    const { api } = backupApi({ policies })
    const res = await call(routes(fakeDeps({ api, graph: graphOf(async () => ({ status: 403, body: {} })) })), "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect(res.body.scans[0].groupResolution.state).toBe("unavailable")
    expect(res.body.scans[0].groupResolution.reason).toContain("Group.Read.All")
    expect(res.body.scans[0].groupResolution.reason).toContain("-IncludeGroupRead")
    const unknown = res.body.scans[0].unknowns.find((u: { ruleId: string }) => u.ruleId === "missing-group")
    expect(unknown.reason).toContain("Group.Read.All")
    expect(unknown.reason).toContain("-IncludeGroupRead")
    expect(res.body.findings.some((f: { ruleId: string }) => f.ruleId === "missing-group")).toBe(false)
  })

  it("acknowledges, records false positives with a reason and reopens on changed evidence", async () => {
    let policies: Item[] = [
      { id: "p1", name: "A", platforms: "windows10", settings: [choice("fw", "on")], assignments: [allDevices()], roleScopeTagIds: ["0"] },
      { id: "p2", name: "B", platforms: "windows10", settings: [choice("fw", "off")], assignments: [allDevices()], roleScopeTagIds: ["0"] },
    ]
    const deps = fakeDeps({ api: (path, tenant, body) => backupApi({ policies }).api(path, tenant, body) })
    const r = routes(deps)
    const first = await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    const conflict = first.body.findings.find((f: { ruleId: string }) => f.ruleId === "conflicting-setting")
    expect(conflict.classification).toBe("definite")

    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "mark-false-positive", findingId: conflict.id })).status).toBe(400)
    const marked = await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "mark-false-positive", findingId: conflict.id, reason: "Pilot ring by design" })
    expect(marked.body.finding.status).toBe("false-positive")
    expect(marked.body.finding.review.note).toBe("Pilot ring by design")

    // Same evidence keeps the review.
    await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "get", findingId: conflict.id })).body.finding.status).toBe("false-positive")

    // Changed evidence reopens it; history keeps the earlier review and evidence.
    policies = [policies[0]!, { ...policies[1]!, settings: [choice("fw", "block")] }]
    await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    const got = (await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "get", findingId: conflict.id })).body.finding
    expect(got.status).toBe("open")
    expect(got.history.some((h: { snapshot: { status: string } }) => h.snapshot.status === "false-positive")).toBe(true)
    expect(got.history.some((h: { reason: string }) => h.reason.includes("Evidence changed"))).toBe(true)

    // Fixed configuration resolves it.
    policies = [policies[0]!, { ...policies[1]!, settings: [choice("fw", "on")] }]
    await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "get", findingId: conflict.id })).body.finding.status).toBe("resolved")
    // The now identical policies are a duplicate instead.
    const open = (await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "list", status: ["open"], classification: ["definite"] })).body.findings as Array<{ fingerprint: string }>
    expect(open.some((f) => f.fingerprint.includes("conflicting-setting"))).toBe(false)
    expect(open.some((f) => f.fingerprint.includes("duplicate-profile"))).toBe(true)
  })

  it("filters stored findings", async () => {
    const { api } = backupApi()
    const deps = fakeDeps({ api })
    const r = routes(deps)
    await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    const definite = await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "list", classification: ["definite"] })
    expect(definite.body.findings.every((f: { classification: string }) => f.classification === "definite")).toBe(true)
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "list", status: ["bogus"] })).status).toBe(400)
    expect(definite.body.findings.every((f: { collectedAt: string }) => f.collectedAt === "2026-09-29T02:00:00Z")).toBe(true)
  })

  it("keeps stored findings readable after a downgrade but gates scans and reviews", async () => {
    const { api } = backupApi()
    const plans: Record<string, "pro" | "community"> = { [TENANT_A]: "pro" }
    const deps = fakeDeps({ api, plan: async () => plans[TENANT_A]! })
    const r = routes(deps)
    const scanned = await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    const id = scanned.body.findings[0].id
    plans[TENANT_A] = "community"
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "list" })).body.findings.length).toBe(scanned.body.findings.length)
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "get", findingId: id })).status).toBe(200)
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })).status).toBe(402)
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "acknowledge", findingId: id })).status).toBe(402)
  })

  it("isolates tenants and gates the fleet summary to MSP", async () => {
    const { api } = backupApi()
    const deps = fakeDeps({ api, plans: { [TENANT_A]: "msp", [TENANT_B]: "msp", [TENANT_C]: "pro" } })
    const r = routes(deps)
    const scanned = await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "scan" })
    const id = scanned.body.findings[0].id
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_B, action: "get", findingId: id })).status).toBe(404)
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_B, action: "acknowledge", findingId: id })).status).toBe(404)

    const fleet = await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "portfolio-summary", targetTenants: [{ tenantId: TENANT_B }] })
    expect(fleet.status).toBe(200)
    const [a, b] = fleet.body.tenants
    expect(a.tenantId).toBe(TENANT_A)
    expect(a.latestScan.collectedAt).toBe("2026-09-29T02:00:00Z")
    expect(b.latestScan).toBeNull()
    expect(b.queue).toEqual([])

    expect((await call(r, "/api/hygiene", { tenantId: TENANT_C, action: "portfolio-summary", targetTenants: [{ tenantId: TENANT_A }] })).status).toBe(402)
    expect((await call(r, "/api/hygiene", { tenantId: TENANT_A, action: "portfolio-summary", targetTenants: [{ tenantId: TENANT_C }] })).status).toBe(402)
  })
})

describe("Group.Read.All opt-in", () => {
  const script = readFileSync(new URL("../resources/New-TenuVaultDesktopApp.ps1", import.meta.url), "utf8")
  const scanSummary = readFileSync(new URL("../src/renderer/features/hygiene/ScanSummary.tsx", import.meta.url), "utf8")
  const hygieneApi = readFileSync(new URL("../src/renderer/features/hygiene/api.ts", import.meta.url), "utf8")

  it("keeps the default setup permissions unchanged and adds Group.Read.All only with the opt-in flag", () => {
    expect(script).toContain("[switch]$IncludeGroupRead")
    const resourcesAt = script.indexOf("$resources = @(")
    const flagAt = script.indexOf("if ($IncludeGroupRead)")
    expect(resourcesAt).toBeGreaterThan(0)
    expect(flagAt).toBeGreaterThan(resourcesAt)
    // The default scope lists sit between the resources block and the opt-in block.
    expect(script.slice(resourcesAt, flagAt)).not.toContain("Group.Read.All")
    expect(script.slice(flagAt)).toContain('"Group.Read.All"')
    expect(script.match(/"Group\.Read\.All"/g)).toHaveLength(1)
  })

  it("shows the opt-in hint only for the unresolved groups unknown", () => {
    expect(hygieneApi).toContain("GROUP_READ_OPT_IN_HINT")
    expect(hygieneApi).toContain("Group.Read.All")
    expect(hygieneApi).toContain("-IncludeGroupRead")
    expect(scanSummary).toContain('unknown.ruleId === "missing-group"')
    expect(scanSummary).toContain("GROUP_READ_OPT_IN_HINT")
  })
})

describe("hygiene work signals", () => {
  it("reports only open findings, with their severity and scan time", async () => {
    const deps = fakeDeps()
    const meta = { actor: null, reason: "Seeded" }
    const base = { kind: "finding", summary: "Finding.", ruleId: "unassigned-policy", classification: "definite", explanation: "This policy has no assignments.", policies: [], settings: [], details: {}, evidenceSha256: "hash", backupId: "backup-1", collectedAt: "2026-09-29T02:00:00Z", scanId: "scan-1", firstSeenAt: "2026-09-29T02:00:00Z", lastSeenAt: "2026-09-29T02:00:00Z", review: null }
    deps.records.create("hygiene-findings", TENANT_A, { ...base, title: "Open policy", status: "open", fingerprint: "unassigned-policy:p1", severity: "high" } as never, meta)
    deps.records.create("hygiene-findings", TENANT_A, { ...base, title: "Handled policy", status: "acknowledged", fingerprint: "unassigned-policy:p2", severity: "low" } as never, meta)
    deps.records.create("hygiene-findings", TENANT_A, { ...base, title: "Done policy", status: "resolved", fingerprint: "unassigned-policy:p3", severity: "low" } as never, meta)
    const found = await signals(deps, TENANT_A)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ source: "hygiene", severity: "high", state: "open", title: "Open policy", observedAt: "2026-09-29T02:00:00Z" })
    expect(found[0]!.key).toBe("hygiene-finding:unassigned-policy:p1")
    expect(await signals(deps, TENANT_B)).toEqual([])
  })
})
