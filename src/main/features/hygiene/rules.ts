import { createHash } from "node:crypto"
import { comparableSnapshot } from "../../../shared/intune/compare"
import { typeForFolder, type Item, type Json } from "../../../shared/intune/registry"

/**
 * Hygiene detection rules (#139). Pure: the input is a collected inventory (the latest
 * complete backup), the output is candidate findings and the checks that could not be made.
 *
 * Invariants:
 * - Only collected types are inspected. A type that was not collected is reported as "not
 *   collected" by the caller, never as clean.
 * - A reference that cannot be resolved because its type was not collected or its endpoint
 *   is unreadable (groups without Group.Read.All) is an unknown, never a finding and never
 *   proof that the reference is fine.
 * - Include and exclude targets are kept apart: a policy that excludes a group another policy
 *   includes is intentional targeting, not a conflict.
 * - Evidence holds hashes and short display values only. Snapshot content (which can hold
 *   secret values inside the encrypted backup) never leaves this module.
 */

export type RuleId = "conflicting-setting" | "duplicate-profile" | "unassigned-policy" | "missing-filter" | "missing-scope-tag" | "missing-group"
export type Classification = "definite" | "possible"
export type Severity = "high" | "medium" | "low"

export interface RuleInfo {
  id: RuleId
  name: string
  description: string
  limits: string
}

/** The detection rules, as shown next to each finding. */
export const RULES: Record<RuleId, RuleInfo> = {
  "conflicting-setting": {
    id: "conflicting-setting",
    name: "Conflicting setting values",
    description: "The same Settings Catalog setting is configured with different values in two or more policies for the same platform whose targets may reach the same devices or users.",
    limits: "Definite only when both policies include the same target (all devices, all users or the same group) without filters or exclusions. Otherwise group membership, filters and device state decide whether the policies meet on a device, which is not collected.",
  },
  "duplicate-profile": {
    id: "duplicate-profile",
    name: "Duplicate profiles",
    description: "Two or more objects of the same type have identical configuration apart from name, description, assignments and scope tags.",
    limits: "Compares the collected configuration only. Duplicates can be intentional, for example during a staged migration.",
  },
  "unassigned-policy": {
    id: "unassigned-policy",
    name: "Unassigned policies",
    description: "The policy has no assignments, so it applies to no device or user.",
    limits: "Built-in defaults that always apply (default enrollment configurations and branding) are left out. Policies included only through a policy set are listed too; check the policy set.",
  },
  "missing-filter": {
    id: "missing-filter",
    name: "Unresolved assignment filters",
    description: "An assignment names an assignment filter that is not in the collected assignment filters.",
    limits: "Checked only when assignment filters were collected in the same backup.",
  },
  "missing-scope-tag": {
    id: "missing-scope-tag",
    name: "Unresolved scope tags",
    description: "The object carries a scope tag ID that is not in the collected scope tags.",
    limits: "Checked only when scope tags were collected in the same backup. The built-in Default tag (0) always exists.",
  },
  "missing-group": {
    id: "missing-group",
    name: "Unresolved groups",
    description: "An assignment targets or excludes a group that Microsoft Graph reports as not existing.",
    limits: "Group reads need Group.Read.All. The setup script does not request it by default: run New-TenuVaultDesktopApp.ps1 with -IncludeGroupRead to add it. Without it every group is unknown, not missing.",
  },
}

/** One collected object. */
export interface InventoryItem {
  folder: string
  id: string
  name: string
  snapshot: Item
}

/** Whether each referenced group exists, as far as Graph could tell. */
export type GroupState = "exists" | "missing" | "unknown"

export interface Inventory {
  items: InventoryItem[]
  /** Registry folders whose objects were fully listed in this collection. */
  covered: ReadonlySet<string>
  /** Group existence by ID; absent IDs are unknown. */
  groups: ReadonlyMap<string, GroupState>
  /** Why group state is unknown, shown with the unknowns. */
  groupReason?: string
}

export interface PolicyRef {
  folder: string
  id: string
  name: string
}

export interface SettingEvidence {
  definitionId: string
  values: Array<{ policyId: string; display: string; valueSha256: string }>
}

export interface DetectedFinding {
  ruleId: RuleId
  /** Stable across scans for the same problem, so reviews carry over. */
  fingerprint: string
  classification: Classification
  severity: Severity
  title: string
  explanation: string
  policies: PolicyRef[]
  settings: SettingEvidence[]
  details: Record<string, string | string[]>
  /** Hash of the evidence; changes when the underlying configuration changes. */
  evidenceSha256: string
}

/** A check that could not be made, with the objects it concerned. */
export interface UnknownCheck {
  ruleId: RuleId
  reason: string
  count: number
  policies: PolicyRef[]
}

export interface DetectionResult {
  findings: DetectedFinding[]
  unknowns: UnknownCheck[]
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

const EMPTY_FILTER = "00000000-0000-0000-0000-000000000000"

type Target =
  | { kind: "allDevices"; filterId: string | null }
  | { kind: "allUsers"; filterId: string | null }
  | { kind: "group"; groupId: string; filterId: string | null }
  | { kind: "exclude"; groupId: string }
  | { kind: "other"; filterId: string | null }

function isObject(value: unknown): value is Item {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

/** Assignments of an object, or null when they were not collected with it. */
function assignments(item: InventoryItem): Item[] | null {
  const value = item.snapshot.assignments
  return Array.isArray(value) ? value.filter(isObject) : null
}

function targets(item: InventoryItem): Target[] {
  return (assignments(item) ?? []).flatMap((assignment): Target[] => {
    const target = assignment.target
    if (!isObject(target)) return []
    const type = str(target["@odata.type"]) ?? ""
    const rawFilter = str(target.deviceAndAppManagementAssignmentFilterId)
    const filterType = str(target.deviceAndAppManagementAssignmentFilterType)
    const filterId = rawFilter && rawFilter !== EMPTY_FILTER && filterType !== "none" ? rawFilter : null
    const groupId = str(target.groupId)
    if (type.endsWith("exclusionGroupAssignmentTarget")) return groupId ? [{ kind: "exclude", groupId }] : []
    if (type.endsWith("allDevicesAssignmentTarget")) return [{ kind: "allDevices", filterId }]
    if (type.endsWith("allLicensedUsersAssignmentTarget")) return [{ kind: "allUsers", filterId }]
    if (type.endsWith("groupAssignmentTarget") && groupId) return [{ kind: "group", groupId, filterId }]
    return [{ kind: "other", filterId }]
  })
}

/** Filter IDs on any assignment target (filters on exclusions are not allowed by Intune). */
function filterIds(item: InventoryItem): string[] {
  return [...new Set(targets(item).flatMap((target) => ("filterId" in target && target.filterId ? [target.filterId] : [])))]
}

function groupIds(item: InventoryItem): string[] {
  return [...new Set(targets(item).flatMap((target) => (target.kind === "group" || target.kind === "exclude" ? [target.groupId] : [])))]
}

export type Overlap = "definite" | "possible" | "none"

/**
 * Whether two policies can reach the same device or user, from their assignments alone.
 * - "none": one is unassigned, or every include of one is excluded by group in the other.
 * - "definite": both include the same target with no filter, and neither has exclusions.
 * - "possible": anything that depends on group membership, filters or user and device
 *   targeting meeting on a device, none of which is collected.
 */
export function overlap(a: InventoryItem, b: InventoryItem): Overlap {
  const ta = targets(a)
  const tb = targets(b)
  const includesA = ta.filter((target) => target.kind !== "exclude")
  const includesB = tb.filter((target) => target.kind !== "exclude")
  if (!includesA.length || !includesB.length) return "none"
  const excludedA = new Set(ta.flatMap((target) => (target.kind === "exclude" ? [target.groupId] : [])))
  const excludedB = new Set(tb.flatMap((target) => (target.kind === "exclude" ? [target.groupId] : [])))
  const anyExclusions = excludedA.size > 0 || excludedB.size > 0
  let result: Overlap = "none"
  for (const x of includesA) {
    for (const y of includesB) {
      // An include of one policy that the other excludes is intentional targeting.
      if (x.kind === "group" && excludedB.has(x.groupId)) continue
      if (y.kind === "group" && excludedA.has(y.groupId)) continue
      const same =
        (x.kind === "allDevices" && y.kind === "allDevices") ||
        (x.kind === "allUsers" && y.kind === "allUsers") ||
        (x.kind === "group" && y.kind === "group" && x.groupId === y.groupId)
      const unfiltered = !("filterId" in x && x.filterId) && !("filterId" in y && y.filterId)
      if (same && unfiltered && !anyExclusions) return "definite"
      result = "possible"
    }
  }
  return result
}

const SETTING_VALUE_KEYS = ["choiceSettingValue", "simpleSettingValue"] as const

/**
 * The value of a top-level single-value Settings Catalog setting, as a hash and a short
 * display text. Collections (lists, grouped rules such as elevation rules) are left out: Intune
 * merges or adds them, so different values there are not a conflict.
 */
function settingValue(instance: Item): { hash: string; display: string } | null {
  const type = str(instance["@odata.type"]) ?? ""
  if (!type.endsWith("ChoiceSettingInstance") && !type.endsWith("SimpleSettingInstance")) return null
  for (const key of SETTING_VALUE_KEYS) {
    const value = instance[key]
    if (!isObject(value)) continue
    const canonical = JSON.stringify(stripTemplates(value))
    const valueType = str(value["@odata.type"]) ?? ""
    const raw = value.value
    const display = valueType.toLowerCase().includes("secret")
      ? "Secret value (not shown)"
      : typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? String(raw).slice(0, 160)
        : "Structured value"
    return { hash: sha256(canonical), display }
  }
  return null
}

function stripTemplates(value: Json): Json {
  if (Array.isArray(value)) return value.map(stripTemplates)
  if (!isObject(value)) return value
  const out: Item = {}
  for (const key of Object.keys(value).sort()) {
    if (key === "settingValueTemplateReference" || key === "settingInstanceTemplateReference" || key === "auditRuleInformation") continue
    out[key] = stripTemplates(value[key]!)
  }
  return out
}

function ref(item: InventoryItem): PolicyRef {
  return { folder: item.folder, id: item.id, name: item.name }
}

function finding(input: Omit<DetectedFinding, "evidenceSha256">): DetectedFinding {
  const evidence = JSON.stringify({ policies: input.policies, settings: input.settings, details: input.details, classification: input.classification })
  return { ...input, evidenceSha256: sha256(evidence) }
}

function conflicts(items: InventoryItem[]): DetectedFinding[] {
  const bySetting = new Map<string, Array<{ item: InventoryItem; hash: string; display: string }>>()
  for (const item of items) {
    if (item.folder !== "ConfigurationPolicies") continue
    const platform = str(item.snapshot.platforms) ?? "unknown"
    const settings = Array.isArray(item.snapshot.settings) ? item.snapshot.settings.filter(isObject) : []
    const seen = new Set<string>()
    for (const setting of settings) {
      const instance = setting.settingInstance
      if (!isObject(instance)) continue
      const definitionId = str(instance.settingDefinitionId)
      if (!definitionId || seen.has(definitionId)) continue
      const value = settingValue(instance)
      if (!value) continue
      seen.add(definitionId)
      const key = `${platform}\u0000${definitionId}`
      bySetting.set(key, [...(bySetting.get(key) ?? []), { item, ...value }])
    }
  }
  const results: DetectedFinding[] = []
  for (const [key, entries] of bySetting) {
    if (entries.length < 2 || new Set(entries.map((entry) => entry.hash)).size < 2) continue
    const [platform, definitionId] = key.split("\u0000") as [string, string]
    let level: Overlap = "none"
    const involved = new Set<InventoryItem>()
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!
        const b = entries[j]!
        if (a.hash === b.hash) continue
        const pair = overlap(a.item, b.item)
        if (pair === "none") continue
        involved.add(a.item).add(b.item)
        if (pair === "definite" || level === "none") level = pair
      }
    }
    if (level === "none") continue
    const affected = entries.filter((entry) => involved.has(entry.item)).sort((a, b) => a.item.id.localeCompare(b.item.id))
    results.push(finding({
      ruleId: "conflicting-setting",
      fingerprint: `conflicting-setting:${platform}:${definitionId}`,
      classification: level,
      severity: level === "definite" ? "high" : "medium",
      title: `Different values for ${definitionId}`,
      explanation: level === "definite"
        ? `${affected.length} ${platform} policies set this setting to different values and include the same target without filters or exclusions, so Intune reports a conflict on the devices they reach.`
        : `${affected.length} ${platform} policies set this setting to different values. Whether they meet on a device depends on group membership, filters or user and device targeting, which is not collected.`,
      policies: affected.map((entry) => ref(entry.item)),
      settings: [{ definitionId, values: affected.map((entry) => ({ policyId: entry.item.id, display: entry.display, valueSha256: entry.hash })) }],
      details: { platform },
    }))
  }
  return results
}

/** Properties that do not describe what an object configures. */
const IDENTITY_KEYS = new Set(["id", "displayName", "name", "description", "assignments", "roleScopeTagIds", "isAssigned", "settingCount", "priorityMetaData", "creationSource", "supportsScopeTags", "createdBy", "lastModifiedBy", "priority"])

function contentOnly(value: Json, depth = 0): Json {
  if (Array.isArray(value)) return value.map((entry) => contentOnly(entry, depth + 1))
  if (!isObject(value)) return value
  const out: Item = {}
  for (const [key, entry] of Object.entries(value)) {
    // Nested IDs are per object (setting instance IDs); top-level identity keys describe the object, not its content.
    if (key === "id" || (depth === 0 && IDENTITY_KEYS.has(key))) continue
    out[key] = contentOnly(entry, depth + 1)
  }
  return out
}

function duplicates(items: InventoryItem[]): DetectedFinding[] {
  const groups = new Map<string, InventoryItem[]>()
  for (const item of items) {
    const type = typeForFolder(item.folder)
    if (!type || type.restore === "singleton" || item.folder === "Apps") continue
    const hash = sha256(JSON.stringify(comparableSnapshot(contentOnly(item.snapshot))))
    const key = `${item.folder}:${hash}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const results: DetectedFinding[] = []
  for (const [key, members] of groups) {
    if (members.length < 2) continue
    const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id))
    const label = typeForFolder(sorted[0]!.folder)?.label ?? sorted[0]!.folder
    results.push(finding({
      ruleId: "duplicate-profile",
      fingerprint: `duplicate-profile:${sorted.map((item) => `${item.folder}/${item.id}`).join(",")}`,
      classification: "definite",
      severity: "low",
      title: `${sorted.length} ${label} with identical configuration`,
      explanation: `These ${label} configure exactly the same content. Only names, descriptions, assignments or scope tags differ.`,
      policies: sorted.map(ref),
      settings: [],
      details: { contentSha256: key.slice(key.indexOf(":") + 1) },
    }))
  }
  return results
}

/** Types whose objects apply only through their own assignments. */
const NOT_ASSIGNABLE_POLICY = new Set(["Apps", "ScopeTags", "RoleDefinitions", "AppCategories", "PolicySets"])

function alwaysApplies(item: InventoryItem): boolean {
  // Default enrollment configurations apply to all users and devices without assignments.
  if (item.folder === "EnrollmentConfigurations" && (item.snapshot.priority === 0 || /_(Default[A-Za-z0-9]*|WindowsRestore)$/.test(item.id))) return true
  if (item.folder === "Branding" && item.snapshot.isDefaultProfile === true) return true
  return false
}

function unassigned(items: InventoryItem[]): { findings: DetectedFinding[]; unknown: InventoryItem[] } {
  const findings: DetectedFinding[] = []
  const unknown: InventoryItem[] = []
  for (const item of items) {
    const type = typeForFolder(item.folder)
    if (!type?.assign || NOT_ASSIGNABLE_POLICY.has(item.folder) || alwaysApplies(item)) continue
    const list = assignments(item)
    if (list === null) {
      unknown.push(item)
      continue
    }
    if (list.length) continue
    findings.push(finding({
      ruleId: "unassigned-policy",
      fingerprint: `unassigned-policy:${item.folder}/${item.id}`,
      classification: "definite",
      severity: "low",
      title: `${item.name} is not assigned`,
      explanation: `This ${type.label.replace(/s$/, "")} has no assignments in the collected backup, so it applies to no device or user.`,
      policies: [ref(item)],
      settings: [],
      details: {},
    }))
  }
  return { findings, unknown }
}

function references(inventory: Inventory): DetectionResult {
  const findings: DetectedFinding[] = []
  const unknowns: UnknownCheck[] = []
  const filterIdsKnown = new Set(inventory.items.filter((item) => item.folder === "AssignmentFilters").map((item) => item.id))
  const tagIdsKnown = new Set(["0", ...inventory.items.filter((item) => item.folder === "ScopeTags").map((item) => item.id)])
  const filtersCovered = inventory.covered.has("AssignmentFilters")
  const tagsCovered = inventory.covered.has("ScopeTags")

  const missing = { filter: new Map<string, InventoryItem[]>(), tag: new Map<string, InventoryItem[]>(), group: new Map<string, InventoryItem[]>() }
  const unresolvable = { filter: new Set<InventoryItem>(), tag: new Set<InventoryItem>(), group: new Set<InventoryItem>() }
  const add = (map: Map<string, InventoryItem[]>, id: string, item: InventoryItem) => map.set(id, [...(map.get(id) ?? []), item])

  for (const item of inventory.items) {
    for (const id of filterIds(item)) {
      if (!filtersCovered) unresolvable.filter.add(item)
      else if (!filterIdsKnown.has(id)) add(missing.filter, id, item)
    }
    const tags = Array.isArray(item.snapshot.roleScopeTagIds) ? item.snapshot.roleScopeTagIds.filter((tag): tag is string => typeof tag === "string") : []
    for (const id of new Set(tags)) {
      if (tagIdsKnown.has(id)) continue
      if (!tagsCovered) unresolvable.tag.add(item)
      else add(missing.tag, id, item)
    }
    for (const id of groupIds(item)) {
      const state = inventory.groups.get(id.toLowerCase()) ?? "unknown"
      if (state === "missing") add(missing.group, id, item)
      else if (state === "unknown") unresolvable.group.add(item)
    }
  }

  const emit = (ruleId: RuleId, kind: string, map: Map<string, InventoryItem[]>, detailKey: string) => {
    for (const [id, items] of map) {
      const sorted = [...new Set(items)].sort((a, b) => a.id.localeCompare(b.id))
      findings.push(finding({
        ruleId,
        fingerprint: `${ruleId}:${id}`,
        classification: "definite",
        severity: ruleId === "missing-scope-tag" ? "low" : "medium",
        title: `${sorted.length} ${sorted.length === 1 ? "object references" : "objects reference"} a missing ${kind}`,
        explanation: `The ${kind} ${id} is referenced but ${ruleId === "missing-group" ? "Microsoft Graph reports that it does not exist" : `is not among the ${kind}s collected in the same backup`}.`,
        policies: sorted.map(ref),
        settings: [],
        details: { [detailKey]: id },
      }))
    }
  }
  emit("missing-filter", "assignment filter", missing.filter, "filterId")
  emit("missing-scope-tag", "scope tag", missing.tag, "scopeTagId")
  emit("missing-group", "group", missing.group, "groupId")

  const note = (ruleId: RuleId, reason: string, items: Set<InventoryItem>) => {
    if (items.size) unknowns.push({ ruleId, reason, count: items.size, policies: [...items].slice(0, 50).map(ref) })
  }
  note("missing-filter", "Assignment filters were not collected in this backup, so filter references could not be checked.", unresolvable.filter)
  note("missing-scope-tag", "Scope tags were not collected in this backup, so scope tag references could not be checked.", unresolvable.tag)
  note("missing-group", inventory.groupReason ?? "Group existence could not be read, so group references could not be checked.", unresolvable.group)
  return { findings, unknowns }
}

/**
 * Runs every rule over one collected inventory. Findings are sorted by classification and
 * severity; unknowns list the checks that could not be made and why.
 */
export function detectHygiene(inventory: Inventory): DetectionResult {
  const items = inventory.items.filter((item) => inventory.covered.has(item.folder))
  const refs = references({ ...inventory, items })
  const assigned = unassigned(items)
  const findings = [...conflicts(items), ...duplicates(items), ...assigned.findings, ...refs.findings]
  const unknowns = [...refs.unknowns]
  if (assigned.unknown.length) unknowns.push({ ruleId: "unassigned-policy", reason: "Assignments were not collected with these objects.", count: assigned.unknown.length, policies: assigned.unknown.slice(0, 50).map(ref) })
  const rank = { definite: 0, possible: 1 }
  const severity = { high: 0, medium: 1, low: 2 }
  findings.sort((a, b) => rank[a.classification] - rank[b.classification] || severity[a.severity] - severity[b.severity] || a.title.localeCompare(b.title))
  return { findings, unknowns }
}

/** Stored finding states the admin can filter on. */
export type FindingStatus = "open" | "acknowledged" | "false-positive" | "resolved"

export interface FindingFilter {
  status?: FindingStatus[]
  ruleId?: RuleId[]
  classification?: Classification[]
  text?: string
}

/** Filters stored findings; an empty filter keeps everything. */
export function filterFindings<T extends { status: string; ruleId: string; classification: string; title: string; policies: PolicyRef[] }>(findings: T[], filter: FindingFilter): T[] {
  const text = filter.text?.trim().toLowerCase()
  return findings.filter((entry) =>
    (!filter.status?.length || filter.status.includes(entry.status as FindingStatus)) &&
    (!filter.ruleId?.length || filter.ruleId.includes(entry.ruleId as RuleId)) &&
    (!filter.classification?.length || filter.classification.includes(entry.classification as Classification)) &&
    (!text || entry.title.toLowerCase().includes(text) || entry.policies.some((policy) => policy.name.toLowerCase().includes(text))))
}
