import type { RouteModule } from "../../api/host"
import type { ListedRecord, SignalProvider, WorkSignal } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import { resolveHistory, type Stored } from "../records"
import { featureRoute, FeatureError, optionalText, text, type ActionContext, type Body } from "../route"
import { collectFromBackup, resolveGroups, type NotCollected } from "./inventory"
import { detectHygiene, filterFindings, RULES, type Classification, type DetectedFinding, type FindingFilter, type FindingStatus, type PolicyRef, type RuleId, type SettingEvidence, type Severity, type UnknownCheck } from "./rules"

const DOMAIN = DOMAINS.hygieneFindings

/** One hygiene scan: which backup, when it was collected and what it covered. */
export interface ScanRecord extends ListedRecord {
  kind: "scan"
  backupId: string
  collectedAt: string
  completeness: "complete" | "partial"
  partialReason: string | null
  covered: string[]
  notCollected: NotCollected[]
  itemCount: number
  unreadableItems: number
  unknowns: UnknownCheck[]
  groupResolution: { state: string; reason: string | null }
  counts: { definite: number; possible: number }
}

/** A finding with its evidence and review state. Its history keeps every earlier evidence and review. */
export interface FindingRecord extends ListedRecord {
  kind: "finding"
  status: FindingStatus
  ruleId: RuleId
  fingerprint: string
  classification: Classification
  severity: Severity
  explanation: string
  policies: PolicyRef[]
  settings: SettingEvidence[]
  details: Record<string, string | string[]>
  evidenceSha256: string
  backupId: string
  collectedAt: string
  scanId: string
  firstSeenAt: string
  lastSeenAt: string
  /** The latest acknowledgement or false positive decision, null while open. */
  review: { action: "acknowledged" | "false-positive"; by: string | null; at: string; note: string } | null
}

type HygieneRecord = ScanRecord | FindingRecord

function all(deps: FeatureDeps, tenantId: string): Stored<HygieneRecord>[] {
  return deps.records.list<HygieneRecord>(DOMAIN, tenantId)
}

function withoutHistory<T extends { history?: unknown }>(record: T): Omit<T, "history"> {
  const { history: _history, ...rest } = record
  return rest
}

function findingsOf(records: Stored<HygieneRecord>[]): Stored<FindingRecord>[] {
  return records.filter((record): record is Stored<FindingRecord> => record.kind === "finding")
}

function scansOf(records: Stored<HygieneRecord>[]): Stored<ScanRecord>[] {
  return records.filter((record): record is Stored<ScanRecord> => record.kind === "scan").sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function summaryOf(finding: DetectedFinding): string {
  return `${RULES[finding.ruleId].name}: ${finding.policies.length} affected ${finding.policies.length === 1 ? "object" : "objects"}, ${finding.classification === "definite" ? "definite configuration problem" : "possible overlap that needs group, filter or device context"}.`
}

const STATUSES: FindingStatus[] = ["open", "acknowledged", "false-positive", "resolved"]
const CLASSIFICATIONS: Classification[] = ["definite", "possible"]

function listOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T[] | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 20 || !value.every((entry) => typeof entry === "string" && (allowed as readonly string[]).includes(entry))) throw new FeatureError(`${key} is invalid`)
  return value as T[]
}

function parseFilter(body: Body): FindingFilter {
  return {
    status: listOf(body, "status", STATUSES),
    ruleId: listOf(body, "ruleId", Object.keys(RULES) as RuleId[]),
    classification: listOf(body, "classification", CLASSIFICATIONS),
    text: optionalText(body, "text", 200) ?? undefined,
  }
}

function findingId(body: Body): string {
  const id = text(body, "findingId", 100)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FeatureError("findingId is invalid")
  return id
}

/** Whether a scan could have seen a finding again; otherwise its absence proves nothing. */
function couldDetect(scan: ScanRecord, finding: FindingRecord): boolean {
  const covered = new Set(scan.covered)
  if (!finding.policies.every((policy) => covered.has(policy.folder))) return false
  if (finding.ruleId === "missing-filter") return covered.has("AssignmentFilters")
  if (finding.ruleId === "missing-scope-tag") return covered.has("ScopeTags")
  // "none" means no assignment references a group any more, so no group can be missing.
  if (finding.ruleId === "missing-group") return scan.groupResolution.state === "resolved" || scan.groupResolution.state === "none"
  return true
}

async function scan({ tenantId, body, deps, actor }: ActionContext) {
  const backupId = optionalText(body, "backupId", 80)
  if (backupId !== null && !/^[a-zA-Z0-9_-]+$/.test(backupId)) throw new FeatureError("backupId is invalid")
  const inventory = await collectFromBackup(deps, tenantId, backupId)
  const groups = await resolveGroups(deps, tenantId, inventory.items)
  const result = detectHygiene({ items: inventory.items, covered: new Set(inventory.covered), groups: groups.groups, groupReason: groups.reason })
  const definite = result.findings.filter((finding) => finding.classification === "definite").length
  const meta = { actor, reason: `Hygiene scan of backup ${inventory.backupId}` }

  deps.records.batch(() => {
    const scanRecord = deps.records.create<ScanRecord>(DOMAIN, tenantId, {
      kind: "scan",
      title: `Hygiene scan of ${inventory.backupId}`,
      status: inventory.completeness,
      summary: `${result.findings.length} findings (${definite} definite) from the backup collected ${inventory.collectedAt}; ${inventory.notCollected.length} types not collected.`,
      backupId: inventory.backupId,
      collectedAt: inventory.collectedAt,
      completeness: inventory.completeness,
      partialReason: inventory.partialReason,
      covered: inventory.covered,
      notCollected: inventory.notCollected,
      itemCount: inventory.items.length,
      unreadableItems: inventory.unreadableItems,
      unknowns: result.unknowns,
      groupResolution: { state: groups.state, reason: groups.reason ?? null },
      counts: { definite, possible: result.findings.length - definite },
    }, meta)

    const now = deps.now().toISOString()
    const existing = new Map(findingsOf(all(deps, tenantId)).map((record) => [record.fingerprint, record]))
    const seen = new Set<string>()
    for (const detected of result.findings) {
      seen.add(detected.fingerprint)
      const evidence = {
        title: detected.title,
        summary: summaryOf(detected),
        ruleId: detected.ruleId,
        fingerprint: detected.fingerprint,
        classification: detected.classification,
        severity: detected.severity,
        explanation: detected.explanation,
        policies: detected.policies,
        settings: detected.settings,
        details: detected.details,
        evidenceSha256: detected.evidenceSha256,
        backupId: inventory.backupId,
        collectedAt: inventory.collectedAt,
        scanId: scanRecord.id,
        lastSeenAt: now,
      }
      const current = existing.get(detected.fingerprint)
      if (!current) {
        deps.records.create<FindingRecord>(DOMAIN, tenantId, { kind: "finding", ...evidence, status: "open", firstSeenAt: now, review: null }, meta)
        continue
      }
      const changed = current.evidenceSha256 !== detected.evidenceSha256
      const reviewed = current.status === "acknowledged" || current.status === "false-positive"
      // A review applies to the evidence it was made on; changed evidence needs a new review.
      const reopen = current.status === "resolved" || (reviewed && changed)
      const reason = current.status === "resolved" ? "Detected again" : reopen ? "Evidence changed since it was reviewed; open for a new review" : changed ? "Evidence changed" : "Detected again with the same evidence"
      deps.records.update<FindingRecord>(DOMAIN, tenantId, current.id, (value) => ({ ...value, ...evidence, status: reopen ? "open" : value.status, review: reopen ? null : value.review }), { actor, reason })
    }
    for (const [fingerprint, current] of existing) {
      if (seen.has(fingerprint) || current.status === "resolved" || !couldDetect(scanRecord, current)) continue
      deps.records.update<FindingRecord>(DOMAIN, tenantId, current.id, (value) => ({ ...value, status: "resolved", scanId: scanRecord.id }), { actor, reason: `Not detected in backup ${inventory.backupId}` })
    }
  })
  return list({ tenantId, body: {}, deps } as ActionContext)
}

function list({ tenantId, body, deps }: Pick<ActionContext, "tenantId" | "body" | "deps">) {
  const records = all(deps, tenantId)
  const findings = findingsOf(records).map(withoutHistory)
  return {
    rules: Object.values(RULES),
    scans: scansOf(records).slice(0, 10).map(withoutHistory),
    findings: filterFindings(findings, parseFilter(body)),
    total: findings.length,
  }
}

function get({ tenantId, body, deps }: ActionContext) {
  const record = deps.records.get<HygieneRecord>(DOMAIN, tenantId, findingId(body))
  if (!record || record.kind !== "finding") throw new FeatureError("Finding not found.", 404)
  const scanRecord = deps.records.get<HygieneRecord>(DOMAIN, tenantId, record.scanId)
  return { finding: { ...record, history: resolveHistory(record.history) }, rule: RULES[record.ruleId], scan: scanRecord ? withoutHistory(scanRecord) : null }
}

function review(action: "acknowledged" | "false-positive") {
  return ({ tenantId, body, deps, actor }: ActionContext) => {
    const id = findingId(body)
    const note = action === "false-positive" ? text(body, "reason", 2000) : optionalText(body, "note", 2000) ?? ""
    const current = deps.records.get<HygieneRecord>(DOMAIN, tenantId, id)
    if (!current || current.kind !== "finding") throw new FeatureError("Finding not found.", 404)
    if (current.status === "resolved") throw new FeatureError("This finding was not detected in the latest scan.", 409)
    const at = deps.now().toISOString()
    const updated = deps.records.update<FindingRecord>(DOMAIN, tenantId, id, (value) => ({ ...value, status: action, review: { action, by: actor, at, note } }), {
      actor,
      reason: action === "false-positive" ? `Marked as false positive: ${note}` : note ? `Acknowledged: ${note}` : "Acknowledged",
    })
    return { finding: updated }
  }
}

function reopen({ tenantId, body, deps, actor }: ActionContext) {
  const id = findingId(body)
  const current = deps.records.get<HygieneRecord>(DOMAIN, tenantId, id)
  if (!current || current.kind !== "finding") throw new FeatureError("Finding not found.", 404)
  if (current.status !== "acknowledged" && current.status !== "false-positive") throw new FeatureError("Only reviewed findings can be reopened.", 409)
  const reason = optionalText(body, "reason", 2000) ?? "Reopened"
  return { finding: deps.records.update<FindingRecord>(DOMAIN, tenantId, id, (value) => ({ ...value, status: "open", review: null }), { actor, reason }) }
}

/** Per customer counts and the open definite queue, each read only from that customer's records. */
function portfolioSummary({ tenantId, targetTenants, deps }: ActionContext) {
  const tenants = [tenantId, ...targetTenants].map((id) => {
    const records = all(deps, id)
    const findings = findingsOf(records)
    const latest = scansOf(records)[0]
    const count = (status: FindingStatus, classification?: Classification) => findings.filter((finding) => finding.status === status && (!classification || finding.classification === classification)).length
    return {
      tenantId: id,
      name: deps.tenant(id)?.name ?? id,
      latestScan: latest ? { collectedAt: latest.collectedAt, completeness: latest.completeness, notCollected: latest.notCollected.length, unknowns: latest.unknowns.length } : null,
      counts: { openDefinite: count("open", "definite"), openPossible: count("open", "possible"), acknowledged: count("acknowledged"), falsePositive: count("false-positive"), resolved: count("resolved") },
      queue: findings
        .filter((finding) => finding.status === "open" && finding.classification === "definite")
        .sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity])
        .slice(0, 25)
        .map((finding) => ({ id: finding.id, title: finding.title, ruleId: finding.ruleId, severity: finding.severity, collectedAt: finding.collectedAt })),
    }
  })
  return { tenants }
}

/** /api/hygiene (#139). Reads stored findings on every plan; scanning and reviews need the explorer. */
export function routes(deps: FeatureDeps): Record<string, RouteModule> {
  return featureRoute("/api/hygiene", deps, {
    list,
    get,
    scan,
    acknowledge: review("acknowledged"),
    "mark-false-positive": review("false-positive"),
    reopen,
    "portfolio-summary": portfolioSummary,
  })
}

/** Open hygiene findings of the latest scans; acknowledged, false positive and resolved findings are handled and stay silent. */
export function hygieneSignals(deps: FeatureDeps, tenantId: string): WorkSignal[] {
  const tenant = tenantId.toLowerCase()
  return findingsOf(all(deps, tenant))
    .filter((finding) => finding.status === "open")
    .map((finding) => ({
      key: `hygiene-finding:${finding.fingerprint}`,
      tenantId: tenant,
      source: "hygiene" as const,
      severity: finding.severity,
      state: "open" as const,
      title: finding.title,
      reason: finding.explanation,
      observedAt: finding.collectedAt,
      link: "/portal/governance/hygiene",
      evidence: [`${DOMAIN}:${finding.id}`],
    }))
}

/** Background work while the app runs; returns a function that stops it. */
export function start(_deps: FeatureDeps): () => void {
  return () => undefined
}

/** Open hygiene findings for one tenant. */
export const signals: SignalProvider = (deps, tenantId) => hygieneSignals(deps, tenantId)
