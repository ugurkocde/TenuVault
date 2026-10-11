import { typeForFolder, type Item } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import type { OibPlatform } from "../../../shared/oib/types"
import { replaceTenantVariables } from "../../../shared/oib/variables"
import type { ListedRecord, WorkSignal } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { FeatureError } from "../route"
import { createChangeSet, listChangeSets, type OperationInput } from "../change-sets/engine"
import { GraphReadError, readCurrent } from "../change-sets/graph"
import { containsRedaction, hashOf, MAX_OPERATIONS, sanitizeSnapshot, type ChangeSetRecord } from "../change-sets/model"
import { comparePolicy, deviations, mergePolicy, policyHash, policyMatchKey, unresolvedKeys, type Choice, type PolicyComparison } from "./merge"
import { offeredOver, resolveRunCommit, type BaselineSources } from "./sources"

/**
 * Baseline upgrades that keep customizations (#144). Provenance (which source was installed,
 * with the exact per-policy snapshots) is stored as records; a comparison reads the tenant live
 * and the new release through the OpenIntuneBaseline source loader, and every tenant write goes
 * through a reviewed change set (origin "baseline-upgrade"). Assignments are never changed.
 *
 * Records in DOMAINS.baselineInstalls have a `kind`:
 * - "install": what is installed in the tenant and from which source (updated as upgrades land);
 * - "source": frozen public source content (policy snapshots of one release), never updated;
 * - "comparison": a frozen three-way comparison the admin reviewed, never updated.
 * Frozen content is kept out of the install and upgrade records, so their history stays small.
 */

export const FOLDER = "ConfigurationPolicies"
const MAX_POLICIES = 200

export interface SourcePolicy {
  key: string
  name: string
  folder: string
  sourcePath: string | null
  supported: boolean
  reason: string | null
  /** Settings Catalog snapshot as the source defines it, without assignments. Null when unsupported. */
  snapshot: Item | null
}

export interface BaselineSourceRecord extends ListedRecord {
  kind: "source"
  status: "frozen"
  /** oib: an OIB release; workspace: a framework workspace pack; snapshot: a tenant backup; custom: an edited baseline. */
  origin: "oib" | "workspace" | "snapshot" | "custom"
  platform: OibPlatform | null
  commit: string | null
  reference: string
  frameworkId: string | null
  /** Backup folder for snapshot sources. */
  backupFolder?: string | null
  /** The source record a custom baseline was derived from (for example an OIB release). */
  derivedFrom?: string | null
  policies: SourcePolicy[]
  contentHash: string
}

export interface InstalledPolicy {
  key: string
  name: string
  folder: string
  objectId: string | null
  /** Source record of the installed version; null when the installed version is unknown. */
  sourceId: string | null
  sourceReference: string | null
  supported: boolean
  note: string | null
}

export interface BaselineInstallRecord extends ListedRecord {
  kind: "install"
  status: "tracked" | "unknown-provenance" | "mixed"
  /** "quickstart": an OpenIntuneBaseline deployment run (the name predates that section and is kept for stored records). */
  origin: { type: "quickstart"; runId: string } | { type: "workspace"; frameworkId: string }
  platform: OibPlatform | null
  commit: string | null
  reference: string
  sourceId: string | null
  policies: InstalledPolicy[]
  /** Increases with every upgrade that landed; identifies the customization version. */
  customizationVersion: number
  customizationHash: string | null
  latestKnownRelease: { commit: string; reference: string; tag: string; checkedAt: string } | null
  lastUpgradeId: string | null
}

export interface ComparisonRecord extends ListedRecord {
  kind: "comparison"
  status: "frozen"
  upgradeId: string | null
  policies: Array<{ key: string; comparison: PolicyComparison | null }>
}

export type PolicyKind = "matched" | "added" | "removed" | "local-missing" | "unsupported" | "unreadable"

export interface UpgradePolicy {
  key: string
  name: string
  kind: PolicyKind
  mode: "three-way" | "manual"
  objectId: string | null
  /** Hash of the tenant policy at comparison time; a different hash later means it changed. */
  localHash: string
  counts: PolicyComparison["counts"] | null
  blockers: string[]
  /** Setting resolutions chosen by the admin, by setting key. */
  resolutions: Record<string, Choice>
  unresolved: number
  /** Added: include or skip. Removed: keep or delete. Local-missing: skip only (recreate is a manual step). */
  choice: "include" | "skip" | "keep" | "delete" | null
  /** Documented customizations (#148) for kept tenant settings. */
  documented: string[]
  batch: string | null
  outcome: "pending" | "verified" | "failed" | "uncertain" | "rolled-back" | null
  createdId: string | null
  previous: { sourceId: string | null; objectId: string | null }
  resultingDeviations: number | null
}

export interface UpgradeRecord extends ListedRecord {
  status: "review" | "ready" | "change-set" | "applied" | "partial" | "failed" | "uncertain" | "stale" | "rolled-back"
  installId: string
  mode: "three-way" | "manual"
  from: { commit: string | null; reference: string; sourceId: string | null }
  to: { platform: OibPlatform | null; commit: string | null; reference: string; sourceId: string }
  comparisonId: string
  comparedAt: string
  policies: UpgradePolicy[]
  unresolved: number
  batches: Array<{ changeSetId: string; operations: Record<string, string> }>
  customizationVersionFrom: number
  customizationVersionTo: number | null
  resultingCustomizationHash: string | null
  finalized: boolean
}

type Actor = string | null
const INSTALLS = DOMAINS.baselineInstalls
const UPGRADES = DOMAINS.baselineUpgrades

const type = () => typeForFolder(FOLDER)!

// ---------------------------------------------------------------------------------------------
// Reading stored records

export function listInstalls(deps: FeatureDeps, tenantId: string): Stored<BaselineInstallRecord>[] {
  return deps.records.list<BaselineInstallRecord>(INSTALLS, tenantId).filter((record) => record.kind === "install").sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getInstall(deps: FeatureDeps, tenantId: string, id: string): Stored<BaselineInstallRecord> {
  const record = deps.records.get<BaselineInstallRecord>(INSTALLS, tenantId, id)
  if (!record || record.kind !== "install") throw new FeatureError("This installed baseline is not recorded for this tenant.", 404)
  return record
}

export function getBaselineSource(deps: FeatureDeps, tenantId: string, id: string): Stored<BaselineSourceRecord> {
  const record = deps.records.get<BaselineSourceRecord>(INSTALLS, tenantId, id)
  if (!record || record.kind !== "source") throw new FeatureError("The recorded source content is missing. Compare again.", 409)
  return record
}

export function getComparison(deps: FeatureDeps, tenantId: string, id: string): Stored<ComparisonRecord> {
  const record = deps.records.get<ComparisonRecord>(INSTALLS, tenantId, id)
  if (!record || record.kind !== "comparison") throw new FeatureError("The recorded comparison is missing. Compare again.", 409)
  return record
}

export function getUpgrade(deps: FeatureDeps, tenantId: string, id: string): Stored<UpgradeRecord> {
  const record = deps.records.get<UpgradeRecord>(UPGRADES, tenantId, id)
  if (!record) throw new FeatureError("This upgrade does not exist for this tenant.", 404)
  return record
}

export function listUpgrades(deps: FeatureDeps, tenantId: string): Stored<UpgradeRecord>[] {
  return deps.records.list<UpgradeRecord>(UPGRADES, tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// ---------------------------------------------------------------------------------------------
// Sources and provenance

/** Source policies from pack items; only Settings Catalog policies keep a snapshot. */
export function sourcePolicies(items: Array<{ folder: string; name: string; source?: string; snapshot: Item }>): SourcePolicy[] {
  if (items.length > MAX_POLICIES) throw new FeatureError("The source holds more policies than a baseline upgrade supports.", 502)
  return items.map((item) => {
    const supported = item.folder === FOLDER
    const { assignments: _assignments, id: _id, createdDateTime: _c, lastModifiedDateTime: _l, ...snapshot } = structuredClone(item.snapshot)
    return {
      key: `${item.folder}:${policyMatchKey(item.name)}`,
      name: item.name,
      folder: item.folder,
      sourcePath: item.source ?? null,
      supported,
      reason: supported ? null : `${typeForFolder(item.folder)?.label ?? item.folder} are compared and upgraded manually; baseline upgrades support Settings Catalog policies.`,
      snapshot: supported ? (snapshot as Item) : null,
    }
  })
}

/**
 * Stores frozen source content once per content and reference, and returns the record. Exported
 * for workflows that keep their own baselines (custom OIB baselines, company baselines from
 * snapshots) so they share the base of three-way comparisons.
 */
export function storeBaselineSource(deps: FeatureDeps, tenantId: string, input: Omit<BaselineSourceRecord, "kind" | "status" | "summary" | "contentHash" | "title"> & { title?: string }, actor: Actor): Stored<BaselineSourceRecord> {
  const contentHash = hashOf(input.policies)
  const existing = deps.records.list<BaselineSourceRecord>(INSTALLS, tenantId).find((record) => record.kind === "source" && record.contentHash === contentHash && record.reference === input.reference)
  if (existing) return existing
  return deps.records.create<BaselineSourceRecord>(INSTALLS, tenantId, {
    ...input,
    kind: "source",
    status: "frozen",
    title: input.title ?? input.reference,
    summary: `${input.policies.length} source policies, ${input.policies.filter((policy) => policy.supported).length} supported.`,
    contentHash,
  }, { actor, reason: "Stored the source content of a baseline" })
}

/**
 * Records an OpenIntuneBaseline deployment run (or a Quick Start run migrated from an earlier
 * version) as an installed baseline. The pack is loaded at the exact commit the run recorded,
 * so the base of later comparisons is the content that was actually deployed. When the commit
 * is unknown, the install is recorded with unknown provenance and later comparisons are manual.
 */
export async function recordQuickStartInstall(deps: FeatureDeps, sources: BaselineSources, tenantId: string, runId: string, actor: Actor): Promise<Stored<BaselineInstallRecord>> {
  let runs
  try {
    runs = sources.runs(tenantId)
  } catch (error) {
    throw new FeatureError(`OpenIntuneBaseline deployment history could not be read. ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  const run = runs.find((entry) => entry.runId === runId)
  if (!run || run.tenantId.toLowerCase() !== tenantId) throw new FeatureError("This OpenIntuneBaseline deployment is not recorded for this tenant on this device.", 404)
  if (listInstalls(deps, tenantId).some((install) => install.origin.type === "quickstart" && install.origin.runId === runId)) throw new FeatureError("This deployment is already recorded as an installed baseline.", 409)
  const commit = resolveRunCommit(run)
  // Policies the run created, and those it updated in place to the OIB version.
  const created = [...run.created, ...run.updated].map((item) => ({ ...item, key: `${item.folder}:${policyMatchKey(item.name)}` }))
  let source: Stored<BaselineSourceRecord> | null = null
  let note: string | null = null
  if (commit) {
    try {
      const pack = await sources.pack(run.platform, commit, true)
      source = storeBaselineSource(deps, tenantId, { origin: "oib", platform: run.platform, commit, reference: pack.reference, frameworkId: null, policies: sourcePolicies(pack.items) }, actor)
    } catch (error) {
      note = `The installed release could not be loaded (${error instanceof Error ? error.message : String(error)}).`
    }
  } else {
    note = "The exact OpenIntuneBaseline commit of this run is not recorded."
  }
  const policies: InstalledPolicy[] = created.map((item) => {
    const base = source?.policies.find((policy) => policy.key === item.key) ?? null
    // Without a recorded source the policy is still compared, manually (every difference needs a resolution).
    const supported = item.folder === FOLDER && !item.partial && isGraphId(item.id) && (!source || !!base?.supported)
    return {
      key: item.key,
      name: item.name,
      folder: item.folder,
      objectId: isGraphId(item.id) ? item.id : null,
      sourceId: base && source ? source.id : null,
      sourceReference: base && source ? source.reference : null,
      supported,
      note: item.partial ? "The deployment changed this policy only partially; compare it manually." : item.folder !== FOLDER ? "Only Settings Catalog policies are upgraded; review this policy manually." : !base && source ? "The recorded release does not contain this policy." : null,
    }
  })
  const unknown = !source
  return deps.records.create<BaselineInstallRecord>(INSTALLS, tenantId, {
    kind: "install",
    title: run.reference,
    status: unknown ? "unknown-provenance" : "tracked",
    summary: unknown ? `${note} Upgrades need a manual reviewed comparison.` : `${policies.filter((policy) => policy.supported).length} of ${policies.length} created policies can be upgraded with a three-way comparison.`,
    origin: { type: "quickstart", runId },
    platform: run.platform,
    commit,
    reference: run.reference,
    sourceId: source?.id ?? null,
    policies,
    customizationVersion: 1,
    customizationHash: null,
    latestKnownRelease: null,
    lastUpgradeId: null,
  }, { actor, reason: unknown ? "Recorded an installed baseline with unknown provenance" : `Recorded the installed baseline ${run.reference}` })
}

/**
 * Records a framework workspace pack as the installed baseline. Policies are mapped to tenant
 * objects only by IDs the workspace recorded when it created them, or by IDs the admin names in
 * `mappings`; never by guessing from names.
 */
export function recordWorkspaceInstall(deps: FeatureDeps, sources: BaselineSources, tenantId: string, frameworkId: string, mappings: Record<string, string>, actor: Actor): Stored<BaselineInstallRecord> {
  let workspace
  try {
    workspace = sources.workspace(tenantId, frameworkId)
  } catch (error) {
    throw new FeatureError(`The workspace could not be read. ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  if (!workspace.policies.length || !workspace.reference) throw new FeatureError("This workspace has no stored pack.", 404)
  const source = storeBaselineSource(deps, tenantId, { origin: "workspace", platform: null, commit: null, reference: workspace.reference, frameworkId, policies: sourcePolicies(workspace.policies.map((policy) => ({ folder: FOLDER, name: policy.name, snapshot: policy as unknown as Item }))) }, actor)
  const policies: InstalledPolicy[] = source.policies.map((policy) => {
    const recorded = workspace.creations.find((entry) => entry.name === policy.name && isGraphId(entry.id))?.id ?? null
    const mapped = mappings[policy.key] ?? recorded
    return { key: policy.key, name: policy.name, folder: FOLDER, objectId: mapped, sourceId: source.id, sourceReference: source.reference, supported: !!mapped, note: mapped ? null : "No tenant policy is mapped to this source policy; name its ID to include it." }
  })
  return deps.records.create<BaselineInstallRecord>(INSTALLS, tenantId, {
    kind: "install",
    title: workspace.reference,
    status: "tracked",
    summary: `${policies.filter((policy) => policy.supported).length} of ${policies.length} workspace policies are mapped to tenant policies.`,
    origin: { type: "workspace", frameworkId },
    platform: null,
    commit: null,
    reference: workspace.reference,
    sourceId: source.id,
    policies,
    customizationVersion: 1,
    customizationHash: null,
    latestKnownRelease: null,
    lastUpgradeId: null,
  }, { actor, reason: `Recorded the workspace baseline ${workspace.reference}` })
}

/** Newer OIB releases of an install's platform; remembers the newest for the pending-upgrade signal. */
export async function checkReleases(deps: FeatureDeps, sources: BaselineSources, tenantId: string, installId: string, actor: Actor) {
  const install = getInstall(deps, tenantId, installId)
  if (install.origin.type !== "quickstart" || !install.platform) return { releases: [], warning: "Workspace baselines are upgraded from the workspace's current pack." }
  const { releases, warning } = await sources.releases()
  const newer = releases.filter((release) => release.platform === install.platform && offeredOver(release, install))
  const newest = newer[0]
  if (newest && newest.commit !== install.latestKnownRelease?.commit) {
    deps.records.update<BaselineInstallRecord>(INSTALLS, tenantId, installId, (current) => ({ ...current, latestKnownRelease: { commit: newest.commit, reference: newest.reference, tag: newest.tag, checkedAt: deps.now().toISOString() } }), { actor, reason: `A newer OpenIntuneBaseline version is available: ${newest.reference}` })
  }
  return { releases: newer, warning }
}

// ---------------------------------------------------------------------------------------------
// Comparison

async function readLocal(deps: FeatureDeps, tenantId: string, objectId: string): Promise<{ state: "present"; snapshot: Item } | { state: "missing" } | { state: "unreadable"; message: string }> {
  try {
    const live = await readCurrent(await deps.graph(tenantId), type(), objectId)
    if (!live) return { state: "missing" }
    return { state: "present", snapshot: sanitizeSnapshot(type(), live).snapshot }
  } catch (error) {
    if (error instanceof GraphReadError || error instanceof Error) return { state: "unreadable", message: error.message }
    return { state: "unreadable", message: String(error) }
  }
}

interface Customization { status: string; settingKey: string; policyName: string | null; installId: string | null }

/** Active documented customizations (#148) of this tenant, by setting key. */
function documentedKeys(deps: FeatureDeps, tenantId: string, installId: string, policyName: string): Set<string> {
  const records = deps.records.list<Customization>(DOMAINS.customizations, tenantId)
  return new Set(records.filter((record) => record.status === "active" && (record.installId === null || record.installId === installId) && (!record.policyName || policyMatchKey(record.policyName) === policyMatchKey(policyName))).map((record) => record.settingKey))
}

/**
 * Compares an installed baseline with a newer release: for every installed Settings Catalog
 * policy the installed snapshot (base), the live tenant policy (local) and the release
 * (upstream). Without provenance each difference needs a resolution (manual comparison).
 * Stores the comparison and a new upgrade record in review; writes nothing to the tenant.
 */
export async function compareUpgrade(deps: FeatureDeps, sources: BaselineSources, tenantId: string, installId: string, commit: string | null, actor: Actor): Promise<Stored<UpgradeRecord>> {
  const install = getInstall(deps, tenantId, installId)
  const open = listUpgrades(deps, tenantId).find((upgrade) => upgrade.installId === installId && ["review", "ready", "change-set"].includes(upgrade.status))
  if (open) throw new FeatureError(`An upgrade of this baseline is already open ("${open.title}"). Finish or discard it first.`, 409)
  let upstream: Stored<BaselineSourceRecord>
  if (install.origin.type === "quickstart") {
    if (!install.platform || !commit || !/^[0-9a-f]{40}$/.test(commit)) throw new FeatureError("Choose a release to compare with.")
    if (commit === install.commit) throw new FeatureError("This release is the installed one.", 409)
    let pack
    try {
      pack = await sources.pack(install.platform, commit)
    } catch (error) {
      throw new FeatureError(`The release could not be loaded. ${error instanceof Error ? error.message : String(error)}`, 502)
    }
    upstream = storeBaselineSource(deps, tenantId, { origin: "oib", platform: install.platform, commit, reference: pack.reference, frameworkId: null, policies: sourcePolicies(pack.items) }, actor)
  } else {
    let workspace
    try {
      workspace = sources.workspace(tenantId, install.origin.frameworkId)
    } catch (error) {
      throw new FeatureError(`The workspace could not be read. ${error instanceof Error ? error.message : String(error)}`, 502)
    }
    if (!workspace.policies.length) throw new FeatureError("The workspace has no stored pack.", 404)
    if (workspace.reference === install.reference) throw new FeatureError("The workspace pack is the installed one. Load a newer pack in the workspace first.", 409)
    upstream = storeBaselineSource(deps, tenantId, { origin: "workspace", platform: null, commit: null, reference: workspace.reference, frameworkId: install.origin.frameworkId, policies: sourcePolicies(workspace.policies.map((policy) => ({ folder: FOLDER, name: policy.name, snapshot: policy as unknown as Item }))) }, actor)
  }

  const sourcesById = new Map<string, Stored<BaselineSourceRecord>>()
  const baseOf = (policy: InstalledPolicy): Item | null => {
    if (!policy.sourceId) return null
    const source = sourcesById.get(policy.sourceId) ?? getBaselineSource(deps, tenantId, policy.sourceId)
    sourcesById.set(policy.sourceId, source)
    return source.policies.find((entry) => entry.key === policy.key)?.snapshot ?? null
  }
  const manual = install.status === "unknown-provenance"
  const policies: UpgradePolicy[] = []
  const comparisons: ComparisonRecord["policies"] = []
  const blank = (policy: { key: string; name: string }, kind: PolicyKind, extra: Partial<UpgradePolicy> = {}): UpgradePolicy => ({ key: policy.key, name: policy.name, kind, mode: manual ? "manual" : "three-way", objectId: null, localHash: "missing", counts: null, blockers: [], resolutions: {}, unresolved: 0, choice: null, documented: [], batch: null, outcome: null, createdId: null, previous: { sourceId: null, objectId: null }, resultingDeviations: null, ...extra })

  for (const installed of install.policies) {
    const release = upstream.policies.find((entry) => entry.key === installed.key)
    const previous = { sourceId: installed.sourceId, objectId: installed.objectId }
    if (!installed.supported || !installed.objectId || installed.folder !== FOLDER) {
      policies.push(blank(installed, "unsupported", { objectId: installed.objectId, previous, blockers: [installed.note ?? "This policy is reviewed manually."] }))
      continue
    }
    const local = await readLocal(deps, tenantId, installed.objectId)
    if (local.state === "unreadable") {
      policies.push(blank(installed, "unreadable", { objectId: installed.objectId, previous, blockers: [`The tenant policy could not be read (${local.message}). Its state is unknown.`] }))
      continue
    }
    if (local.state === "missing") {
      policies.push(blank(installed, "local-missing", { objectId: installed.objectId, previous, choice: "skip", blockers: ["The policy no longer exists in the tenant. It is not recreated by the upgrade; deploy it again from the OpenIntuneBaseline section or a change set if it is still wanted."] }))
      continue
    }
    const localHash = policyHash(local.snapshot)
    if (!release) {
      policies.push(blank(installed, "removed", { objectId: installed.objectId, previous, localHash, choice: "keep", blockers: [] }))
      continue
    }
    if (!release.supported || !release.snapshot) {
      policies.push(blank(installed, "unsupported", { objectId: installed.objectId, previous, localHash, blockers: [release.reason ?? "Not supported."] }))
      continue
    }
    const base = manual ? null : baseOf(installed)
    const comparison = comparePolicy(base ? replaceTenantVariables(base, tenantId) : null, local.snapshot, replaceTenantVariables(release.snapshot, tenantId))
    const blockers = [...comparison.blockers]
    if (containsRedaction(local.snapshot)) blockers.push("The tenant policy holds values Intune masks; it cannot be written back automatically. Upgrade it manually.")
    const documented = documentedKeys(deps, tenantId, installId, installed.name)
    comparisons.push({ key: installed.key, comparison })
    policies.push(blank(installed, blockers.length ? "unsupported" : "matched", {
      // Without a recorded base this policy is compared manually even in a tracked baseline.
      mode: base ? "three-way" : "manual",
      objectId: installed.objectId,
      previous,
      localHash,
      counts: comparison.counts,
      blockers,
      unresolved: blockers.length ? 0 : unresolvedKeys(comparison, {}).length,
      documented: comparison.settings.filter((setting) => setting.kind === "local-kept" && documented.has(setting.key)).map((setting) => setting.key),
    }))
  }
  for (const release of upstream.policies) {
    if (install.policies.some((policy) => policy.key === release.key)) continue
    if (!release.supported) policies.push(blank(release, "unsupported", { blockers: [release.reason ?? "Not supported."] }))
    else policies.push(blank(release, "added", { choice: "include" }))
  }
  const comparisonRecord = deps.records.create<ComparisonRecord>(INSTALLS, tenantId, { kind: "comparison", status: "frozen", title: `Comparison with ${upstream.reference}`, summary: `${comparisons.length} policies compared.`, upgradeId: null, policies: comparisons }, { actor, reason: "Froze a baseline comparison" })
  const unresolved = policies.reduce((sum, policy) => sum + policy.unresolved, 0)
  return deps.records.create<UpgradeRecord>(UPGRADES, tenantId, {
    title: `${install.reference} to ${upstream.reference}`,
    status: unresolved ? "review" : "ready",
    summary: summaryOf(policies, manual),
    installId,
    mode: manual ? "manual" : "three-way",
    from: { commit: install.commit, reference: install.reference, sourceId: install.sourceId },
    to: { platform: upstream.platform, commit: upstream.commit, reference: upstream.reference, sourceId: upstream.id },
    comparisonId: comparisonRecord.id,
    comparedAt: deps.now().toISOString(),
    policies,
    unresolved,
    batches: [],
    customizationVersionFrom: install.customizationVersion,
    customizationVersionTo: null,
    resultingCustomizationHash: null,
    finalized: false,
  }, { actor, reason: manual ? "Compared manually: the installed source is unknown" : `Compared with ${upstream.reference}` })
}

function summaryOf(policies: UpgradePolicy[], manual: boolean): string {
  const count = (kind: PolicyKind) => policies.filter((policy) => policy.kind === kind).length
  const unresolved = policies.reduce((sum, policy) => sum + policy.unresolved, 0)
  return `${manual ? "Manual comparison (installed source unknown). " : ""}${count("matched")} to upgrade, ${count("added")} added, ${count("removed")} removed upstream, ${count("unsupported") + count("unreadable") + count("local-missing")} manual; ${unresolved} setting${unresolved === 1 ? "" : "s"} need${unresolved === 1 ? "s" : ""} a resolution.`
}

/**
 * Stores the admin's resolutions. Only settings that need one accept a choice; policy choices
 * are limited to what the policy kind allows. A policy already in a change set is not changed.
 */
export function resolveUpgrade(deps: FeatureDeps, tenantId: string, id: string, input: { settings: Array<{ policyKey: string; settingKey: string; choice: Choice }>; policies: Array<{ policyKey: string; choice: UpgradePolicy["choice"] }> }, actor: Actor): Stored<UpgradeRecord> {
  const upgrade = getUpgrade(deps, tenantId, id)
  if (!["review", "ready", "change-set"].includes(upgrade.status)) throw new FeatureError("This upgrade can no longer be changed.", 409)
  const comparison = getComparison(deps, tenantId, upgrade.comparisonId)
  const policies = structuredClone(upgrade.policies)
  for (const entry of input.settings) {
    const policy = policies.find((candidate) => candidate.key === entry.policyKey)
    const compared = comparison.policies.find((candidate) => candidate.key === entry.policyKey)?.comparison
    if (!policy || !compared) throw new FeatureError("A resolution names a policy that is not part of this upgrade.")
    if (policy.batch) throw new FeatureError(`"${policy.name}" is already in a change set.`, 409)
    const setting = compared.settings.find((candidate) => candidate.key === entry.settingKey)
    if (!setting || !setting.needsResolution) throw new FeatureError("A resolution names a setting that does not need one.")
    policy.resolutions[entry.settingKey] = entry.choice
  }
  for (const entry of input.policies) {
    const policy = policies.find((candidate) => candidate.key === entry.policyKey)
    if (!policy) throw new FeatureError("A choice names a policy that is not part of this upgrade.")
    if (policy.batch) throw new FeatureError(`"${policy.name}" is already in a change set.`, 409)
    const allowed = policy.kind === "added" ? ["include", "skip"] : policy.kind === "removed" ? ["keep", "delete"] : []
    if (!allowed.includes(String(entry.choice))) throw new FeatureError(`"${policy.name}" does not take this choice.`)
    policy.choice = entry.choice
  }
  for (const policy of policies) {
    const compared = comparison.policies.find((candidate) => candidate.key === policy.key)?.comparison
    policy.unresolved = compared && policy.kind === "matched" ? unresolvedKeys(compared, policy.resolutions).length : 0
  }
  const unresolved = policies.reduce((sum, policy) => sum + policy.unresolved, 0)
  return deps.records.update<UpgradeRecord>(UPGRADES, tenantId, id, (current) => ({ ...current, policies, unresolved, status: current.status === "change-set" ? "change-set" : unresolved ? "review" : "ready", summary: summaryOf(policies, current.mode === "manual") }), { actor, reason: `Recorded ${input.settings.length} setting resolution(s) and ${input.policies.length} policy choice(s)` })!
}

/**
 * Creates the reviewed change set of an upgrade (or of the selected policies, at most 25 per
 * change set). Refuses while any selected policy has an unresolved setting, and re-reads each
 * tenant policy first: when it changed after the comparison, the upgrade becomes stale and has
 * to be compared again, so a merge is never based on outdated tenant state.
 */
export async function createUpgradeChangeSet(deps: FeatureDeps, tenantId: string, id: string, input: { policyKeys: string[] | null; title: string | null; ticket: string | null }, actor: Actor): Promise<{ upgrade: Stored<UpgradeRecord>; changeSet: Stored<ChangeSetRecord> }> {
  const upgrade = getUpgrade(deps, tenantId, id)
  if (!["ready", "change-set"].includes(upgrade.status)) throw new FeatureError(upgrade.status === "review" ? "Resolve every conflicting setting before creating the change set." : "This upgrade can no longer create change sets.", 409)
  const install = getInstall(deps, tenantId, upgrade.installId)
  const comparison = getComparison(deps, tenantId, upgrade.comparisonId)
  const upstream = getBaselineSource(deps, tenantId, upgrade.to.sourceId)
  const candidates = upgrade.policies.filter((policy) => !policy.batch && (policy.kind === "matched" || (policy.kind === "added" && policy.choice === "include") || (policy.kind === "removed" && policy.choice === "delete")))
  const selected = input.policyKeys ? candidates.filter((policy) => input.policyKeys!.includes(policy.key)) : candidates
  if (input.policyKeys && selected.length !== input.policyKeys.length) throw new FeatureError("A selected policy is not waiting for a change set.")
  if (selected.some((policy) => policy.unresolved > 0)) throw new FeatureError("A selected policy still has unresolved settings.", 409)
  const operations: Array<OperationInput & { policyKey: string }> = []
  const deviationsByPolicy: Record<string, Array<{ key: string; hash: string | null }>> = {}
  const unchanged: string[] = []
  const sourceLabel = { tenantId: null, objectId: null, version: upgrade.to.commit ?? upgrade.to.reference, label: upgrade.to.reference }
  for (const policy of selected) {
    const release = upstream.policies.find((entry) => entry.key === policy.key)
    if (policy.kind === "added") {
      if (!release?.snapshot) throw new FeatureError(`The release content of "${policy.name}" is missing.`, 409)
      operations.push({ policyKey: policy.key, folder: FOLDER, action: "create", proposed: release.snapshot, assignments: null, source: { ...sourceLabel, objectId: release.sourcePath } })
      deviationsByPolicy[policy.key] = []
      continue
    }
    const local = await readLocal(deps, tenantId, policy.objectId!)
    // A failed read says nothing about the tenant: refuse without marking the upgrade stale.
    if (local.state === "unreadable") throw new FeatureError(`"${policy.name}" could not be read (${local.message}). Nothing was created; try again.`, 502)
    const current = local.state === "present" ? policyHash(local.snapshot) : "missing"
    if (current !== policy.localHash) {
      deps.records.update<UpgradeRecord>(UPGRADES, tenantId, id, (record) => ({ ...record, status: "stale", summary: `"${policy.name}" changed in the tenant after the comparison. Compare again.` }), { actor, reason: `${policy.name} changed after the comparison` })
      throw new FeatureError(`"${policy.name}" changed in the tenant after the comparison. The upgrade is stale; compare again.`, 409)
    }
    if (local.state !== "present") throw new FeatureError(`"${policy.name}" could not be read.`, 502)
    if (policy.kind === "removed") {
      operations.push({ policyKey: policy.key, folder: FOLDER, action: "delete", targetId: policy.objectId, name: policy.name, source: sourceLabel })
      continue
    }
    if (!release?.snapshot) throw new FeatureError(`The release content of "${policy.name}" is missing.`, 409)
    const installed = install.policies.find((entry) => entry.key === policy.key)
    const threeWay = upgrade.mode === "three-way" && policy.mode === "three-way"
    const base = !threeWay || !installed?.sourceId ? null : getBaselineSource(deps, tenantId, installed.sourceId).policies.find((entry) => entry.key === policy.key)?.snapshot ?? null
    if (threeWay && !base) throw new FeatureError(`The installed source of "${policy.name}" is missing. Compare again.`, 409)
    if (!comparison.policies.some((entry) => entry.key === policy.key)) throw new FeatureError(`The comparison of "${policy.name}" is missing. Compare again.`, 409)
    let merged: Item
    const expected = replaceTenantVariables(release.snapshot, tenantId)
    try {
      merged = mergePolicy(base ? replaceTenantVariables(base, tenantId) : null, local.snapshot, expected, policy.resolutions)
    } catch (error) {
      throw new FeatureError(`"${policy.name}" cannot be merged: ${error instanceof Error ? error.message : String(error)}`, 409)
    }
    deviationsByPolicy[policy.key] = deviations(expected, merged)
    if (policyHash(merged) === policy.localHash) {
      unchanged.push(policy.key)
      continue
    }
    operations.push({ policyKey: policy.key, folder: FOLDER, action: "update", targetId: policy.objectId, proposed: merged, assignments: null, source: sourceLabel })
  }
  if (!operations.length) throw new FeatureError(unchanged.length ? "The selected policies already match the merged result; nothing to write." : "Select at least one policy.", 409)
  if (operations.length > MAX_OPERATIONS) throw new FeatureError(`A change set holds at most ${MAX_OPERATIONS} operations. Select up to ${MAX_OPERATIONS} policies and create another change set for the rest.`)
  const changeSet = await createChangeSet(deps, tenantId, {
    title: input.title ?? `Baseline upgrade: ${upgrade.title}`.slice(0, 200),
    ticket: input.ticket,
    origin: { workflow: "baseline-upgrade", recordId: id },
    sourceTenantId: null,
    sourceVersion: upgrade.to.commit ?? upgrade.to.reference,
    operations: operations.map(({ policyKey: _key, ...operation }) => operation),
  }, actor)
  // Policies whose tenant state already equals the merged result need no write: their base moves now.
  if (unchanged.length) applyInstallChanges(deps, tenantId, upgrade, unchanged.map((key) => ({ key, action: "advance" as const, objectId: null, name: upgrade.policies.find((policy) => policy.key === key)!.name })))
  const opKeys = Object.fromEntries(operations.map((operation, index) => [`op-${index + 1}`, operation.policyKey]))
  const resultingHash = hashOf(Object.entries(deviationsByPolicy).sort(([a], [b]) => a.localeCompare(b)))
  const updated = deps.records.update<UpgradeRecord>(UPGRADES, tenantId, id, (current) => ({
    ...current,
    status: "change-set",
    batches: [...current.batches, { changeSetId: changeSet.id, operations: opKeys }],
    policies: current.policies.map((policy) => {
      if (unchanged.includes(policy.key)) return { ...policy, batch: "unchanged", outcome: "verified", resultingDeviations: deviationsByPolicy[policy.key]?.length ?? 0 }
      if (!operations.some((operation) => operation.policyKey === policy.key)) return policy
      return { ...policy, batch: changeSet.id, outcome: "pending", resultingDeviations: deviationsByPolicy[policy.key]?.length ?? null }
    }),
    resultingCustomizationHash: current.resultingCustomizationHash ? hashOf([current.resultingCustomizationHash, resultingHash]) : resultingHash,
    summary: `Change set "${changeSet.title}" created with ${operations.length} operation${operations.length === 1 ? "" : "s"}. Review and apply it under Baseline upgrades.`,
  }), { actor, reason: `Created change set ${changeSet.id} with the selected resolutions` })!
  return { upgrade: updated, changeSet }
}

/** Closes an upgrade that was never applied (for example after it became stale). */
export function discardUpgrade(deps: FeatureDeps, tenantId: string, id: string, reason: string, actor: Actor): Stored<UpgradeRecord> {
  const upgrade = getUpgrade(deps, tenantId, id)
  if (upgrade.policies.some((policy) => policy.batch && policy.batch !== "unchanged")) throw new FeatureError("Part of this upgrade is in a change set. Reject that change set first.", 409)
  return deps.records.update<UpgradeRecord>(UPGRADES, tenantId, id, (current) => ({ ...current, status: "stale", finalized: true, summary: `Discarded: ${reason}` }), { actor, reason: `Discarded: ${reason}` })!
}

// ---------------------------------------------------------------------------------------------
// Synchronizing with change-set outcomes

/**
 * Brings an upgrade and its install up to date with the stored outcomes of its change sets.
 * Only bookkeeping of records that already exist: verified operations advance the installed
 * source of their policy (so the next comparison uses the new release as its base), an applied
 * rollback returns it, and once every batch is final the customization version increases.
 * Reads no tenant data and runs on every plan, so records stay consistent after a downgrade.
 */
export function syncUpgrade(deps: FeatureDeps, tenantId: string, id: string): Stored<UpgradeRecord> {
  const upgrade = getUpgrade(deps, tenantId, id)
  if (!upgrade.batches.length || upgrade.finalized && upgrade.status !== "applied" && upgrade.status !== "partial") return upgrade
  const changeSets = listChangeSets(deps, tenantId)
  const policies = structuredClone(upgrade.policies)
  let changed = false
  const installChanges: Array<{ key: string; action: "advance" | "revert" | "remove" | "add"; objectId: string | null; name: string }> = []
  for (const batch of upgrade.batches) {
    const changeSet = changeSets.find((entry) => entry.id === batch.changeSetId)
    if (!changeSet) continue
    for (const [opKey, policyKey] of Object.entries(batch.operations)) {
      const policy = policies.find((entry) => entry.key === policyKey)
      const result = changeSet.results[opKey]
      // A policy belongs to one batch at a time: an earlier rejected or stale batch no longer owns it.
      if (!policy || !result || policy.batch !== batch.changeSetId || policy.outcome === "verified" || policy.outcome === "rolled-back") continue
      const outcome = changeSet.status === "rejected" || changeSet.status === "stale" ? "failed" : result.status === "writing" ? "uncertain" : result.status === "pending" ? "pending" : result.status
      if (outcome !== policy.outcome) {
        changed = true
        policy.outcome = outcome
        if (changeSet.status === "rejected" || (changeSet.status === "stale" && result.status === "pending")) policy.batch = null
        if (outcome === "verified") {
          const operation = changeSet.operations.find((entry) => entry.key === opKey)
          if (operation?.action === "create") policy.createdId = result.objectId
          installChanges.push({ key: policy.key, action: operation?.action === "delete" ? "remove" : operation?.action === "create" ? "add" : "advance", objectId: operation?.action === "create" ? result.objectId : policy.objectId, name: policy.name })
        }
      }
    }
    for (const rollback of changeSets.filter((entry) => entry.kind === "rollback" && entry.rollbackOf === batch.changeSetId)) {
      for (const operation of rollback.operations) {
        if (rollback.results[operation.key]?.status !== "verified") continue
        const objectId = operation.action === "create" ? operation.source?.objectId ?? null : operation.targetId
        const policy = policies.find((entry) => entry.batch === batch.changeSetId && entry.outcome === "verified" && (entry.objectId === objectId || entry.createdId === objectId))
        if (!policy) continue
        changed = true
        policy.outcome = "rolled-back"
        installChanges.push({ key: policy.key, action: policy.kind === "added" ? "remove" : policy.kind === "removed" ? "add" : "revert", objectId: policy.kind === "removed" ? rollback.results[operation.key]?.objectId ?? null : policy.previous.objectId, name: policy.name })
      }
    }
  }
  if (!changed) return upgrade
  if (installChanges.length) applyInstallChanges(deps, tenantId, upgrade, installChanges)
  const batched = policies.filter((policy) => policy.batch && policy.batch !== "unchanged")
  const final = batched.every((policy) => policy.outcome === "verified" || policy.outcome === "failed" || policy.outcome === "rolled-back")
  const waiting = policies.some((policy) => !policy.batch && (policy.kind === "matched" || (policy.kind === "added" && policy.choice === "include") || (policy.kind === "removed" && policy.choice === "delete")))
  const verified = batched.filter((policy) => policy.outcome === "verified").length
  let status: UpgradeRecord["status"] = upgrade.status
  if (batched.some((policy) => policy.outcome === "uncertain")) status = "uncertain"
  else if (batched.length && batched.every((policy) => policy.outcome === "rolled-back")) status = "rolled-back"
  else if (final && !waiting) status = verified === batched.length ? "applied" : verified ? "partial" : "failed"
  else if (!batched.length) status = policies.some((policy) => policy.unresolved > 0) ? "review" : "ready"
  else status = "change-set"
  const finalize = (status === "applied" || status === "partial") && !upgrade.finalized
  if (finalize) {
    deps.records.update<BaselineInstallRecord>(INSTALLS, tenantId, upgrade.installId, (install) => ({ ...install, customizationVersion: install.customizationVersion + 1, customizationHash: upgrade.resultingCustomizationHash, lastUpgradeId: upgrade.id }), { actor: null, reason: `Upgrade ${upgrade.title} landed; customization version increased` })
  }
  const version = finalize ? getInstall(deps, tenantId, upgrade.installId).customizationVersion : upgrade.customizationVersionTo
  return deps.records.update<UpgradeRecord>(UPGRADES, tenantId, id, (current) => ({
    ...current,
    policies,
    status,
    finalized: current.finalized || finalize,
    customizationVersionTo: version,
    summary: `${verified} of ${batched.length} policy change${batched.length === 1 ? "" : "s"} verified; ${batched.filter((policy) => policy.outcome === "failed").length} failed, ${batched.filter((policy) => policy.outcome === "uncertain").length} uncertain, ${batched.filter((policy) => policy.outcome === "rolled-back").length} rolled back.`,
  }), { actor: null, reason: `Synchronized with change-set outcomes: ${status}` })!
}

function applyInstallChanges(deps: FeatureDeps, tenantId: string, upgrade: UpgradeRecord, changes: Array<{ key: string; action: "advance" | "revert" | "remove" | "add"; objectId: string | null; name: string }>): void {
  deps.records.update<BaselineInstallRecord>(INSTALLS, tenantId, upgrade.installId, (install) => {
    let policies = [...install.policies]
    for (const change of changes) {
      const previous = upgrade.policies.find((policy) => policy.key === change.key)?.previous ?? { sourceId: null, objectId: null }
      const existing = policies.find((policy) => policy.key === change.key)
      if (change.action === "remove") policies = policies.filter((policy) => policy.key !== change.key)
      else if (change.action === "add") {
        const sourceId = upgrade.policies.find((policy) => policy.key === change.key)?.kind === "removed" ? previous.sourceId : upgrade.to.sourceId
        policies = [...policies.filter((policy) => policy.key !== change.key), { key: change.key, name: change.name, folder: FOLDER, objectId: change.objectId, sourceId, sourceReference: sourceId === upgrade.to.sourceId ? upgrade.to.reference : upgrade.from.reference, supported: !!change.objectId, note: null }]
      } else if (existing) {
        const sourceId = change.action === "advance" ? upgrade.to.sourceId : previous.sourceId
        policies = policies.map((policy) => (policy.key === change.key ? { ...policy, sourceId, sourceReference: change.action === "advance" ? upgrade.to.reference : upgrade.from.reference, objectId: change.objectId ?? policy.objectId } : policy))
      }
    }
    // When every tracked policy shares one source again (after a full upgrade or a full
    // rollback), the baseline is that source; otherwise it is mixed.
    const tracked = policies.filter((policy) => policy.supported)
    const sources = [...new Set(tracked.map((policy) => policy.sourceId))]
    const single = tracked.length > 0 && sources.length === 1 ? sources[0]! : undefined
    const origin = single === upgrade.to.sourceId ? { sourceId: upgrade.to.sourceId, commit: upgrade.to.commit, reference: upgrade.to.reference } : single === upgrade.from.sourceId ? { sourceId: upgrade.from.sourceId, commit: upgrade.from.commit, reference: upgrade.from.reference } : null
    const status: BaselineInstallRecord["status"] = !origin ? "mixed" : origin.sourceId === null ? "unknown-provenance" : "tracked"
    return {
      ...install,
      policies,
      status,
      ...(origin ? { ...origin, latestKnownRelease: install.latestKnownRelease?.commit === origin.commit ? null : install.latestKnownRelease } : {}),
      summary: origin ? (origin.sourceId ? `Installed source: ${origin.reference}.` : install.summary) : "Policies come from different source versions after a partial upgrade or rollback.",
    }
  }, { actor: null, reason: `Recorded upgrade outcomes of ${changes.length} policies` })
}

// ---------------------------------------------------------------------------------------------
// Signals

/** Pending upgrades, unresolved conflicts, unknown provenance and unfinished upgrades. */
export function baselineSignals(deps: FeatureDeps, tenantId: string): WorkSignal[] {
  const tenant = tenantId.toLowerCase()
  const signals: WorkSignal[] = []
  const link = "/portal/changes/baseline-upgrades"
  for (const install of listInstalls(deps, tenant)) {
    if (install.status === "unknown-provenance") signals.push({ key: `baseline-provenance:${install.id}`, tenantId: tenant, source: "change", severity: "low", state: "unknown", title: `Installed source of "${install.title}" is unknown`, reason: "Upgrades of this baseline need a manual reviewed comparison.", observedAt: install.updatedAt, link, evidence: [`${INSTALLS}:${install.id}`] })
    if (install.latestKnownRelease && install.latestKnownRelease.commit !== install.commit) signals.push({ key: `baseline-upgrade-available:${install.id}`, tenantId: tenant, source: "change", severity: "low", state: "open", title: `Baseline upgrade available: ${install.latestKnownRelease.reference}`, reason: `Installed: ${install.reference}. Compare to review what changes.`, observedAt: install.latestKnownRelease.checkedAt, link, evidence: [`${INSTALLS}:${install.id}`] })
  }
  for (const upgrade of listUpgrades(deps, tenant)) {
    if (upgrade.status === "review" && upgrade.unresolved > 0) signals.push({ key: `baseline-conflicts:${upgrade.id}`, tenantId: tenant, source: "change", severity: "medium", state: "open", title: `${upgrade.unresolved} unresolved setting${upgrade.unresolved === 1 ? "" : "s"} in "${upgrade.title}"`, reason: "Conflicting edits and changed data types need an explicit resolution before the upgrade can continue.", observedAt: upgrade.comparedAt, link, evidence: [`${UPGRADES}:${upgrade.id}`] })
    if (upgrade.status === "uncertain" || upgrade.status === "partial") signals.push({ key: `baseline-upgrade-${upgrade.status}:${upgrade.id}`, tenantId: tenant, source: "change", severity: upgrade.status === "uncertain" ? "high" : "medium", state: upgrade.status === "uncertain" ? "unknown" : "open", title: `Baseline upgrade "${upgrade.title}" is ${upgrade.status}`, reason: upgrade.summary, observedAt: upgrade.updatedAt, link, evidence: [`${UPGRADES}:${upgrade.id}`] })
    if (upgrade.status === "stale" && !upgrade.finalized) signals.push({ key: `baseline-upgrade-stale:${upgrade.id}`, tenantId: tenant, source: "change", severity: "low", state: "open", title: `Baseline upgrade "${upgrade.title}" is stale`, reason: upgrade.summary, observedAt: upgrade.updatedAt, link, evidence: [`${UPGRADES}:${upgrade.id}`] })
  }
  return signals
}
