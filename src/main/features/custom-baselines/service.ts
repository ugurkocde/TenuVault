import { typeForFolder, type Item } from "../../../shared/intune/registry"
import { parsePolicies, type BaselinePolicy } from "../../../shared/frameworks/policies"
import { frameworks, type Framework } from "../../../shared/frameworks/catalog"
import { createEvidenceManifest } from "../../../shared/compliance/manifest"
import { comparisonCounts, FRAMEWORK_SOURCE_COMMIT, type NativeAssessment } from "../../../shared/compliance/native"
import type { AssessmentScope } from "../../../shared/compliance/types"
import { allows, CIS_FRAMEWORKS, PlanRequired, type Plan } from "../../../shared/plans"
import { assessPolicySet } from "../../frameworks/service"
import { loadNcsc } from "../../frameworks/ncsc"
import { OIB_REPO, type OibPlatform } from "../../../shared/oib/types"
import { replaceTenantVariables } from "../../../shared/oib/variables"
import type { ListedRecord } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import type { Stored } from "../records"
import { FeatureError } from "../route"
import { createChangeSet, getChangeSet, listChangeSets, type OperationInput } from "../change-sets/engine"
import { GraphReadError, listAll, readCurrent } from "../change-sets/graph"
import { containsRedaction, MAX_OPERATIONS, sanitizeSnapshot, type ChangeSetRecord } from "../change-sets/model"
import { comparePolicy, comparePolicySets, mergePolicy, policyHash, unresolvedKeys, type Choice, type PolicyComparison, type SettingDecision } from "../baseline-upgrades/merge"
import { getBaselineSource, sourcePolicies, storeBaselineSource } from "../baseline-upgrades/service"
import { defaultSources as upgradeSources, offeredOver, type BaselineSources } from "../baseline-upgrades/sources"
import { requireSourceTenant } from "../promotion/targets"
import { collectFromBackup } from "../hygiene/inventory"
import {
  applyEdits,
  baselineEvidence,
  baselineLandscape,
  comparisonLabel,
  contentHash,
  customPolicy,
  FOLDER,
  keyOf,
  maskUnknownFindings,
  MAX_POLICIES,
  MAX_VERSIONS,
  proposedBody,
  settingViews,
  stripForBaseline,
  updateBlocker,
  type CustomPolicy,
  type Edit,
} from "./model"
import { readSnapshot } from "./snapshot"

/**
 * Custom baselines (Pro and MSP): the organization's own Settings Catalog baseline, created
 * from an OpenIntuneBaseline release ("Customize OIB") or from a complete tenant backup
 * ("company baseline"), edited in immutable versions, deployed through reviewed change sets,
 * rebased onto newer OIB releases and compared with frameworks without reading a tenant.
 *
 * Records (all per tenant, the tenant the baseline was created in):
 * - DOMAINS.customBaselines, kind "baseline": name, origin, provenance, version list and the
 *   deployments made from it; kind "version": frozen policies of one version, never updated;
 *   kind "rebase": a three-way comparison with a newer release and the admin's resolutions.
 * - DOMAINS.customBaselineDeployments (under the target tenant): which version was deployed,
 *   with its change set.
 * - DOMAINS.customBaselineComparisons: frozen comparisons with the tenant or a framework.
 */

type Actor = string | null
const BASELINES = DOMAINS.customBaselines
const DEPLOYMENTS = DOMAINS.customBaselineDeployments
const COMPARISONS = DOMAINS.customBaselineComparisons
export const WORKFLOW = "custom-baseline"

/** Where release content comes from; tests replace GitHub. */
export interface CustomBaselineSources extends Pick<BaselineSources, "releases" | "pack" | "workspace"> {
  ncsc: () => Promise<{ policies: BaselinePolicy[]; reference: string }>
}

export const defaultSources: CustomBaselineSources = {
  releases: upgradeSources.releases,
  pack: upgradeSources.pack,
  workspace: upgradeSources.workspace,
  ncsc: () => loadNcsc(),
}

export interface Provenance {
  platform: OibPlatform | null
  commit: string | null
  reference: string
  /** Frozen source record (DOMAINS.baselineInstalls, kind "source") of the base content. */
  sourceId: string | null
  backupFolder: string | null
  collectedAt: string | null
}

export interface VersionSummary {
  version: number
  versionId: string
  name: string
  note: string
  createdAt: string
  actor: string | null
  contentHash: string
  policies: number
  base: Provenance
}

export interface DeploymentSummary {
  deploymentId: string
  targetTenantId: string
  version: number
  status: DeploymentRecord["status"]
  at: string
}

export interface BaselineRecord extends ListedRecord {
  kind: "baseline"
  status: "active"
  origin: "oib" | "snapshot"
  name: string
  provenance: Provenance
  currentVersion: number
  versions: VersionSummary[]
  /** Settings Catalog policies left out when the baseline was created, with the reason. */
  excluded: Array<{ name: string; reason: string }>
  latestKnownRelease: { commit: string; reference: string; tag: string; checkedAt: string } | null
  deployments: DeploymentSummary[]
}

export interface VersionRecord extends ListedRecord {
  kind: "version"
  status: "frozen"
  baselineId: string
  version: number
  name: string
  note: string
  policies: CustomPolicy[]
  base: Provenance
  contentHash: string
}

export interface RebaseEntry {
  key: string
  name: string
  kind: "matched" | "added" | "removed" | "local-missing"
  comparison: PolicyComparison | null
  blockers: string[]
  /** added: include or skip; removed: keep or drop; blocked matched: local or upstream. */
  choice: "include" | "skip" | "keep" | "drop" | "local" | "upstream" | null
  resolutions: Record<string, Choice>
  unresolved: number
}

export interface RebaseRecord extends ListedRecord {
  kind: "rebase"
  status: "review" | "ready" | "applied" | "discarded"
  baselineId: string
  fromVersion: number
  toVersion: number | null
  upstream: Provenance
  entries: RebaseEntry[]
  unresolved: number
}

export interface DeploymentRecord extends ListedRecord {
  status: "change-set" | "applied" | "partial" | "failed" | "uncertain" | "rejected" | "stale" | "rolled-back"
  baselineId: string
  /** The tenant the baseline belongs to; equals the target for deployments into the own tenant. */
  baselineTenantId: string
  baselineName: string
  version: number
  changeSetId: string | null
  /** Change-set operation key to baseline policy key. */
  operations: Record<string, string>
  policies: Array<{ key: string; name: string; action: "create" | "update" | "unchanged" | "blocked"; reason: string | null; outcome: string | null }>
}

export interface TenantComparisonPolicy {
  key: string
  name: string
  state: "matched" | "missing" | "ambiguous" | "unreadable"
  note: string | null
  differences: SettingDecision[]
}

export interface ComparisonRecord extends ListedRecord {
  kind: "tenant" | "framework"
  baselineId: string
  version: number
  label: string
  /** tenant: backup or live read. framework: pack or native assessment. */
  source: { type: "backup"; backupId: string; collectedAt: string; completeness: string } | { type: "live"; readAt: string } | { type: "pack"; frameworkId: string; reference: string } | { type: "native"; frameworkId: string; rulesetVersion: string }
  tenantPolicies?: TenantComparisonPolicy[]
  findings?: ReturnType<typeof maskUnknownFindings>
  counts: Record<string, number>
  native?: NativeAssessment
}

// ---------------------------------------------------------------------------------------------
// Reading stored records

const plainOf = <T extends { history?: unknown }>(record: T) => {
  const { history: _history, ...rest } = record
  return rest
}

export function listBaselines(deps: FeatureDeps, tenantId: string): Stored<BaselineRecord>[] {
  return deps.records.list<BaselineRecord>(BASELINES, tenantId).filter((record) => record.kind === "baseline").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function getBaseline(deps: FeatureDeps, tenantId: string, id: string): Stored<BaselineRecord> {
  const record = deps.records.get<BaselineRecord>(BASELINES, tenantId, id)
  if (!record || record.kind !== "baseline") throw new FeatureError("This baseline does not exist for this tenant.", 404)
  return record
}

export function getVersion(deps: FeatureDeps, tenantId: string, baseline: BaselineRecord, version: number | null): Stored<VersionRecord> {
  const summary = baseline.versions.find((entry) => entry.version === (version ?? baseline.currentVersion))
  if (!summary) throw new FeatureError("This version does not exist.", 404)
  const record = deps.records.get<VersionRecord>(BASELINES, tenantId, summary.versionId)
  if (!record || record.kind !== "version") throw new FeatureError("The stored content of this version is missing.", 409)
  return record
}

export function listRebases(deps: FeatureDeps, tenantId: string, baselineId: string): Stored<RebaseRecord>[] {
  return deps.records.list<RebaseRecord>(BASELINES, tenantId).filter((record) => record.kind === "rebase" && record.baselineId === baselineId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getRebase(deps: FeatureDeps, tenantId: string, id: string): Stored<RebaseRecord> {
  const record = deps.records.get<RebaseRecord>(BASELINES, tenantId, id)
  if (!record || record.kind !== "rebase") throw new FeatureError("This rebase does not exist for this tenant.", 404)
  return record
}

export function listDeployments(deps: FeatureDeps, tenantId: string): Stored<DeploymentRecord>[] {
  return deps.records.list<DeploymentRecord>(DEPLOYMENTS, tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getDeployment(deps: FeatureDeps, tenantId: string, id: string): Stored<DeploymentRecord> {
  const record = deps.records.get<DeploymentRecord>(DEPLOYMENTS, tenantId, id)
  if (!record) throw new FeatureError("This deployment does not exist for this tenant.", 404)
  return record
}

export function listComparisons(deps: FeatureDeps, tenantId: string): Stored<ComparisonRecord>[] {
  return deps.records.list<ComparisonRecord>(COMPARISONS, tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getComparison(deps: FeatureDeps, tenantId: string, id: string): Stored<ComparisonRecord> {
  const record = deps.records.get<ComparisonRecord>(COMPARISONS, tenantId, id)
  if (!record) throw new FeatureError("This comparison does not exist for this tenant.", 404)
  return record
}

/** A version with its editor view (readable settings and value kinds). */
export function versionView(version: VersionRecord) {
  return { ...plainOf(version as VersionRecord & { history?: unknown }), policies: version.policies.map((policy) => ({ key: policy.key, name: policy.name, platforms: policy.snapshot.platforms ?? null, technologies: policy.snapshot.technologies ?? null, nonPortable: policy.nonPortable, settings: settingViews(policy) })) }
}

// ---------------------------------------------------------------------------------------------
// Creating baselines and versions

function createBaseline(deps: FeatureDeps, tenantId: string, input: { name: string; origin: BaselineRecord["origin"]; provenance: Provenance; policies: CustomPolicy[]; excluded: BaselineRecord["excluded"]; note: string }, actor: Actor): Stored<BaselineRecord> {
  if (!input.policies.length) throw new FeatureError("The source holds no Settings Catalog policy that can become a baseline.", 404)
  const baseline = deps.records.create<BaselineRecord>(BASELINES, tenantId, {
    kind: "baseline",
    title: input.name,
    status: "active",
    summary: `${input.policies.length} Settings Catalog policies from ${input.provenance.reference}.`,
    origin: input.origin,
    name: input.name,
    provenance: input.provenance,
    currentVersion: 0,
    versions: [],
    excluded: input.excluded,
    latestKnownRelease: null,
    deployments: [],
  }, { actor, reason: `Created the baseline from ${input.provenance.reference}` })
  return addVersion(deps, tenantId, baseline, { name: input.name, note: input.note, policies: input.policies, base: input.provenance }, actor)
}

function addVersion(deps: FeatureDeps, tenantId: string, baseline: BaselineRecord & { id: string }, input: { name: string; note: string; policies: CustomPolicy[]; base: Provenance }, actor: Actor): Stored<BaselineRecord> {
  if (baseline.versions.length >= MAX_VERSIONS) throw new FeatureError(`A baseline keeps at most ${MAX_VERSIONS} versions. Create a new baseline from the latest version's source to continue.`, 409)
  const version = baseline.currentVersion + 1
  const hash = contentHash(input.policies)
  const record = deps.records.create<VersionRecord>(BASELINES, tenantId, {
    kind: "version",
    status: "frozen",
    title: `${input.name} v${version}`,
    summary: `${input.policies.length} policies. ${input.note}`.slice(0, 500),
    baselineId: baseline.id,
    version,
    name: input.name,
    note: input.note,
    policies: input.policies,
    base: input.base,
    contentHash: hash,
  }, { actor, reason: `Version ${version}: ${input.note}`.slice(0, 500) })
  const summary: VersionSummary = { version, versionId: record.id, name: input.name, note: input.note, createdAt: record.createdAt, actor, contentHash: hash, policies: input.policies.length, base: input.base }
  return deps.records.update<BaselineRecord>(BASELINES, tenantId, baseline.id, (current) => ({
    ...current,
    title: input.name,
    name: input.name,
    currentVersion: version,
    provenance: input.base,
    versions: [...current.versions, summary],
    summary: `Version ${version}, ${input.policies.length} policies, based on ${input.base.reference}.`,
  }), { actor, reason: `Saved version ${version}: ${input.note}`.slice(0, 500) })!
}

/** Settings Catalog items of a source as baseline policies; duplicates by match key are left out and reported. */
function policiesFrom(items: Array<{ name: string; snapshot: Item }>): { policies: CustomPolicy[]; excluded: BaselineRecord["excluded"] } {
  const policies: CustomPolicy[] = []
  const excluded: BaselineRecord["excluded"] = []
  for (const item of items) {
    const policy = customPolicy(item.name, item.snapshot)
    if (!Array.isArray(policy.snapshot.settings) || !policy.snapshot.settings.length) excluded.push({ name: item.name, reason: "The policy has no settings." })
    else if (policies.some((entry) => entry.key === policy.key)) excluded.push({ name: item.name, reason: "Another policy has the same name (without its version suffix); only the first is kept." })
    else policies.push(policy)
  }
  if (policies.length > MAX_POLICIES) throw new FeatureError(`A baseline holds at most ${MAX_POLICIES} policies.`, 413)
  return { policies, excluded }
}

/**
 * "Customize OIB": the organization's own baseline from an OIB platform at the commit the
 * OpenIntuneBaseline section resolved. The exact release content is stored as a frozen source (the base of later
 * three-way rebases) and its Settings Catalog policies become version 1. Other policy types of
 * the pack are listed as excluded. Nothing is read from or written to the tenant.
 */
export async function customizeOib(deps: FeatureDeps, sources: CustomBaselineSources, tenantId: string, input: { platform: OibPlatform; commit: string; name: string | null; releaseTag?: string }, actor: Actor): Promise<Stored<BaselineRecord>> {
  let pack
  try {
    pack = await sources.pack(input.platform, input.commit, undefined, input.releaseTag)
  } catch (error) {
    throw new FeatureError(`The release could not be loaded. ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  const source = storeBaselineSource(deps, tenantId, { origin: "oib", platform: input.platform, commit: pack.commit, reference: pack.reference, frameworkId: null, policies: sourcePolicies(pack.items) }, actor)
  const catalog = source.policies.filter((policy) => policy.supported && policy.snapshot).map((policy) => ({ name: policy.name, snapshot: policy.snapshot! }))
  const { policies, excluded } = policiesFrom(catalog)
  for (const other of source.policies.filter((policy) => !policy.supported)) excluded.push({ name: other.name, reason: other.reason ?? "Only Settings Catalog policies are part of a custom baseline." })
  const provenance: Provenance = { platform: input.platform, commit: pack.commit, reference: pack.reference, sourceId: source.id, backupFolder: null, collectedAt: null }
  return createBaseline(deps, tenantId, { name: input.name ?? `My ${pack.reference.replace(/ · (\S+ @ )?[0-9a-f]{7}$/, "")}`, origin: "oib", provenance, policies, excluded, note: `Created from ${pack.reference}.` }, actor)
}

/**
 * "Company baseline from a tenant snapshot": the Settings Catalog policies of a complete backup
 * of this tenant, without IDs, assignments or scope tags. Masked secrets are stored as the
 * redaction marker (never deployable) and listed as not portable.
 */
export async function fromSnapshot(deps: FeatureDeps, tenantId: string, input: { backupId: string; name: string | null }, actor: Actor): Promise<Stored<BaselineRecord>> {
  const snapshot = await readSnapshot(deps, tenantId, input.backupId)
  const stripped = snapshot.items.map((item) => ({ folder: FOLDER, name: item.name, snapshot: stripForBaseline(item.snapshot).snapshot }))
  const reference = `Backup ${snapshot.backupId}`
  const source = storeBaselineSource(deps, tenantId, { origin: "snapshot", platform: null, commit: null, reference, frameworkId: null, backupFolder: snapshot.backupId, policies: sourcePolicies(stripped) }, actor)
  const { policies, excluded } = policiesFrom(snapshot.items)
  const provenance: Provenance = { platform: null, commit: null, reference, sourceId: source.id, backupFolder: snapshot.backupId, collectedAt: snapshot.collectedAt }
  return createBaseline(deps, tenantId, { name: input.name ?? `Company baseline from ${snapshot.backupId}`, origin: "snapshot", provenance, policies, excluded, note: `Created from ${reference}.` }, actor)
}

/**
 * Saves edits as a new immutable version. `fromVersion` must be the current version, so two
 * editors never overwrite each other's work silently. A rename alone is a version too.
 */
export function saveVersion(deps: FeatureDeps, tenantId: string, id: string, input: { fromVersion: number; name: string | null; note: string; edits: Edit[] }, actor: Actor): Stored<BaselineRecord> {
  const baseline = getBaseline(deps, tenantId, id)
  if (input.fromVersion !== baseline.currentVersion) throw new FeatureError(`Version ${baseline.currentVersion} was saved after you started editing version ${input.fromVersion}. Reload and apply your edits again.`, 409)
  const current = getVersion(deps, tenantId, baseline, null)
  const policies = applyEdits(current.policies, input.edits)
  const name = input.name ?? current.name
  if (name === current.name && contentHash(policies) === current.contentHash) throw new FeatureError("Nothing changed; no version was saved.")
  return addVersion(deps, tenantId, baseline, { name, note: input.note, policies, base: current.base }, actor)
}

// ---------------------------------------------------------------------------------------------
// Deploying

/**
 * Plans a deployment of a baseline version into the context tenant and creates its change set
 * (origin "custom-baseline"). Existing policies are matched by name without version suffix
 * (policyMatchKey); a match is updated in place (its scope tags and assignments stay), no match
 * creates the policy unassigned. Policies with non-portable settings, several matches or a
 * different platform or template are left out and reported. Deploying a baseline of another
 * tenant needs that tenant in `targetTenants`; on Pro both tenants share the license.
 */
export async function deployVersion(deps: FeatureDeps, context: { tenantId: string; plan: Plan; targetTenants: string[] }, input: { baselineId: string; sourceTenantId: string | null; version: number | null; policyKeys: string[] | null; title: string | null; ticket: string | null }, actor: Actor): Promise<{ deployment: Stored<DeploymentRecord>; changeSet: Stored<ChangeSetRecord> }> {
  const target = context.tenantId
  const owner = input.sourceTenantId && input.sourceTenantId.toLowerCase() !== target ? requireSourceTenant({ ...context, deps }, input.sourceTenantId, { distinct: true }) : target
  const baseline = getBaseline(deps, owner, input.baselineId)
  const version = getVersion(deps, owner, baseline, input.version)
  const open = listDeployments(deps, target).filter((entry) => entry.baselineId === baseline.id && entry.baselineTenantId === owner).map((entry) => syncDeployment(deps, target, entry.id)).find((entry) => entry.status === "change-set")
  if (open) throw new FeatureError(`A deployment of this baseline is still open ("${open.title}"). Apply or reject its change set first.`, 409)
  const selected = input.policyKeys ? version.policies.filter((policy) => input.policyKeys!.includes(policy.key)) : version.policies
  if (input.policyKeys && selected.length !== input.policyKeys.length) throw new FeatureError("A selected policy is not in this version.")
  if (!selected.length) throw new FeatureError("Select at least one policy.")

  const graph = await deps.graph(target)
  const type = typeForFolder(FOLDER)!
  let existing: Item[]
  try {
    existing = await listAll(graph, `${type.path}?$select=id,name`)
  } catch (error) {
    throw new FeatureError(`The tenant's policies could not be read, so nothing was planned. ${error instanceof Error ? error.message : String(error)}`, error instanceof GraphReadError && error.status === 403 ? 403 : 502)
  }
  const operations: Array<OperationInput & { policyKey: string }> = []
  const planned: DeploymentRecord["policies"] = []
  for (const policy of selected) {
    const blocked = (reason: string) => planned.push({ key: policy.key, name: policy.name, action: "blocked", reason, outcome: null })
    if (policy.nonPortable.length) {
      blocked(`${policy.nonPortable.length} setting${policy.nonPortable.length === 1 ? "" : "s"} cannot be deployed (secret or tenant-specific values). Remove them in the editor first.`)
      continue
    }
    const matches = existing.filter((entry) => typeof entry.name === "string" && keyOf(entry.name) === policy.key)
    if (matches.length > 1) {
      blocked(`${matches.length} tenant policies have this name; rename or remove duplicates in Intune first.`)
      continue
    }
    const source = { tenantId: owner === target ? null : owner, objectId: null, version: `v${version.version}`, label: `${baseline.name} v${version.version}` }
    if (!matches.length) {
      operations.push({ policyKey: policy.key, folder: FOLDER, action: "create", proposed: proposedBody(policy, null), assignments: null, source })
      planned.push({ key: policy.key, name: policy.name, action: "create", reason: null, outcome: "pending" })
      continue
    }
    const id = String(matches[0]!.id)
    let live: Item | null
    try {
      live = await readCurrent(graph, type, id)
    } catch (error) {
      throw new FeatureError(`"${policy.name}" could not be read in the tenant (${error instanceof Error ? error.message : String(error)}). Nothing was planned.`, 502)
    }
    if (!live) {
      blocked("The matching tenant policy disappeared while planning. Plan again.")
      continue
    }
    const sanitized = sanitizeSnapshot(type, live)
    const blocker = updateBlocker(policy.snapshot, sanitized.snapshot) ?? (sanitized.redacted || containsRedaction(sanitized.snapshot) ? "The tenant policy holds values Intune masks; it cannot be overwritten automatically." : null)
    if (blocker) {
      blocked(blocker)
      continue
    }
    const body = proposedBody(policy, sanitized.snapshot)
    if (policyHash(replaceTenantVariables(body, target)) === policyHash(sanitized.snapshot)) {
      planned.push({ key: policy.key, name: policy.name, action: "unchanged", reason: "The tenant policy already matches this version.", outcome: null })
      continue
    }
    operations.push({ policyKey: policy.key, folder: FOLDER, action: "update", targetId: id, proposed: body, assignments: null, source })
    planned.push({ key: policy.key, name: policy.name, action: "update", reason: null, outcome: "pending" })
  }
  if (!operations.length) throw new FeatureError(planned.some((entry) => entry.action === "blocked") ? `Nothing can be deployed: ${planned.filter((entry) => entry.action === "blocked").map((entry) => `"${entry.name}": ${entry.reason}`).join(" ")}` : "The tenant already matches this version; nothing to write.", 409)
  if (operations.length > MAX_OPERATIONS) throw new FeatureError(`A change set holds at most ${MAX_OPERATIONS} operations; this version needs ${operations.length}. Select up to ${MAX_OPERATIONS} policies and deploy the rest in another change set.`)

  const deployment = deps.records.create<DeploymentRecord>(DEPLOYMENTS, target, {
    title: `${baseline.name} v${version.version}`,
    status: "change-set",
    summary: `${operations.length} operation${operations.length === 1 ? "" : "s"} planned, ${planned.filter((entry) => entry.action === "blocked").length} blocked, ${planned.filter((entry) => entry.action === "unchanged").length} unchanged.`,
    baselineId: baseline.id,
    baselineTenantId: owner,
    baselineName: baseline.name,
    version: version.version,
    changeSetId: null,
    operations: {},
    policies: planned,
  }, { actor, reason: `Planned deployment of ${baseline.name} v${version.version}` })
  let changeSet: Stored<ChangeSetRecord>
  try {
    changeSet = await createChangeSet(deps, target, {
      title: (input.title ?? `Deploy ${baseline.name} v${version.version}`).slice(0, 200),
      ticket: input.ticket,
      origin: { workflow: WORKFLOW, recordId: deployment.id },
      sourceTenantId: owner === target ? null : owner,
      sourceVersion: `${baseline.id}:v${version.version}`,
      operations: operations.map(({ policyKey: _key, ...operation }) => operation),
    }, actor)
  } catch (error) {
    deps.records.update<DeploymentRecord>(DEPLOYMENTS, target, deployment.id, (current) => ({ ...current, status: "failed", summary: `The change set could not be created: ${error instanceof Error ? error.message : String(error)}` }), { actor, reason: "Change set creation failed" })
    throw error
  }
  const updated = deps.records.update<DeploymentRecord>(DEPLOYMENTS, target, deployment.id, (current) => ({ ...current, changeSetId: changeSet.id, operations: Object.fromEntries(operations.map((operation, index) => [`op-${index + 1}`, operation.policyKey])) }), { actor, reason: `Created change set ${changeSet.id}` })!
  deps.records.update<BaselineRecord>(BASELINES, owner, baseline.id, (current) => ({ ...current, deployments: [...current.deployments.filter((entry) => entry.deploymentId !== updated.id), { deploymentId: updated.id, targetTenantId: target, version: version.version, status: updated.status, at: updated.createdAt }].slice(-200) }), { actor, reason: `Deployment of v${version.version} to ${target} planned` })
  return { deployment: updated, changeSet }
}

/**
 * Brings a deployment up to date with its change set and rollbacks: bookkeeping of stored
 * records only, free on every plan. The owning baseline's deployment list follows.
 */
export function syncDeployment(deps: FeatureDeps, tenantId: string, id: string): Stored<DeploymentRecord> {
  const deployment = getDeployment(deps, tenantId, id)
  if (!deployment.changeSetId) return deployment
  let changeSet: Stored<ChangeSetRecord>
  try {
    changeSet = getChangeSet(deps, tenantId, deployment.changeSetId)
  } catch {
    return deployment
  }
  const rolledBack = listChangeSets(deps, tenantId).some((entry) => entry.kind === "rollback" && entry.rollbackOf === changeSet.id && entry.status === "applied")
  const status: DeploymentRecord["status"] = rolledBack ? "rolled-back" : changeSet.status === "rejected" ? "rejected" : changeSet.status === "stale" ? "stale" : ["applied", "partial", "failed", "uncertain"].includes(changeSet.status) ? (changeSet.status as DeploymentRecord["status"]) : "change-set"
  const policies = deployment.policies.map((policy) => {
    const opKey = Object.entries(deployment.operations).find(([, key]) => key === policy.key)?.[0]
    const result = opKey ? changeSet.results[opKey] : undefined
    return result ? { ...policy, outcome: rolledBack ? "rolled-back" : result.status } : policy
  })
  if (status === deployment.status && JSON.stringify(policies) === JSON.stringify(deployment.policies)) return deployment
  const updated = deps.records.update<DeploymentRecord>(DEPLOYMENTS, tenantId, id, (current) => ({ ...current, status, policies, summary: status === "change-set" ? current.summary : `Change set ${changeSet.status}${rolledBack ? ", rolled back" : ""}. ${changeSet.summary}` }), { actor: null, reason: `Synchronized with the change set: ${status}` })!
  const owner = deps.records.get<BaselineRecord>(BASELINES, deployment.baselineTenantId, deployment.baselineId)
  if (owner?.kind === "baseline") deps.records.update<BaselineRecord>(BASELINES, deployment.baselineTenantId, deployment.baselineId, (current) => ({ ...current, deployments: current.deployments.map((entry) => (entry.deploymentId === id ? { ...entry, status } : entry)) }), { actor: null, reason: `Deployment to ${tenantId}: ${status}` })
  return updated
}

// ---------------------------------------------------------------------------------------------
// Newer releases and rebasing

/** Newer OIB releases of the baseline's platform than its base release; remembers the newest. */
export async function checkReleases(deps: FeatureDeps, sources: CustomBaselineSources, tenantId: string, id: string, actor: Actor) {
  const baseline = getBaseline(deps, tenantId, id)
  if (baseline.origin !== "oib" || !baseline.provenance.platform) return { releases: [], warning: "Company baselines from a snapshot have no upstream release." }
  const { releases, warning } = await sources.releases()
  const newer = releases.filter((release) => release.platform === baseline.provenance.platform && offeredOver(release, baseline.provenance))
  const newest = newer[0]
  if (newest && newest.commit !== baseline.latestKnownRelease?.commit) {
    deps.records.update<BaselineRecord>(BASELINES, tenantId, id, (current) => ({ ...current, latestKnownRelease: { commit: newest.commit, reference: newest.reference, tag: newest.tag, checkedAt: deps.now().toISOString() } }), { actor, reason: `A newer OpenIntuneBaseline version is available: ${newest.reference}` })
  }
  return { releases: newer, warning }
}

function setPolicy(policy: { key: string; name: string; snapshot: Item }) {
  return { key: policy.key, name: policy.name, snapshot: stripForBaseline(policy.snapshot).snapshot }
}

function unresolvedOf(entry: RebaseEntry): number {
  if (entry.kind !== "matched" || !entry.comparison) return 0
  if (entry.blockers.length) return entry.choice === "local" || entry.choice === "upstream" ? 0 : 1
  return unresolvedKeys(entry.comparison, entry.resolutions).length
}

/**
 * Three-way comparison of the current version with a newer release: base = the OIB release the
 * version is based on, local = the custom version, upstream = the new release. Stored as a
 * rebase in review; nothing in any tenant is read or changed.
 */
export async function compareRebase(deps: FeatureDeps, sources: CustomBaselineSources, tenantId: string, id: string, commit: string, actor: Actor): Promise<Stored<RebaseRecord>> {
  const baseline = getBaseline(deps, tenantId, id)
  if (baseline.origin !== "oib" || !baseline.provenance.platform) throw new FeatureError("Only baselines customized from OpenIntuneBaseline can be rebased onto a release.", 409)
  if (listRebases(deps, tenantId, id).some((rebase) => rebase.status === "review" || rebase.status === "ready")) throw new FeatureError("A rebase of this baseline is already open. Apply or discard it first.", 409)
  const version = getVersion(deps, tenantId, baseline, null)
  if (commit === version.base.commit) throw new FeatureError("The baseline is already based on this release.", 409)
  let pack
  try {
    pack = await sources.pack(baseline.provenance.platform, commit)
  } catch (error) {
    throw new FeatureError(`The release could not be loaded. ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  const upstreamSource = storeBaselineSource(deps, tenantId, { origin: "oib", platform: baseline.provenance.platform, commit: pack.commit, reference: pack.reference, frameworkId: null, policies: sourcePolicies(pack.items) }, actor)
  const baseSource = version.base.sourceId ? getBaselineSource(deps, tenantId, version.base.sourceId) : null
  const fromSource = (source: typeof upstreamSource) => source.policies.filter((policy) => policy.supported && policy.snapshot).map((policy) => setPolicy({ key: policy.key, name: policy.name, snapshot: policy.snapshot! }))
  const compared = comparePolicySets(baseSource ? fromSource(baseSource) : null, version.policies.map(setPolicy), fromSource(upstreamSource)).map((entry) => {
    const blockers = entry.comparison?.blockers ?? []
    const result: RebaseEntry = { key: entry.key, name: entry.name, kind: entry.kind, comparison: entry.comparison, blockers, choice: entry.kind === "added" ? "include" : entry.kind === "removed" ? "keep" : null, resolutions: {}, unresolved: 0 }
    result.unresolved = unresolvedOf(result)
    return result
  })
  // A policy kept in an earlier rebase is in neither this base nor the release, and
  // comparePolicySets does not list it: it is offered like a removed one, kept by default.
  for (const policy of version.policies) {
    if (!compared.some((entry) => entry.key === policy.key)) compared.push({ key: policy.key, name: policy.name, kind: "removed", comparison: null, blockers: [], choice: "keep", resolutions: {}, unresolved: 0 })
  }
  const entries = compared
  const unresolved = entries.reduce((sum, entry) => sum + entry.unresolved, 0)
  const upstream: Provenance = { platform: baseline.provenance.platform, commit: pack.commit, reference: pack.reference, sourceId: upstreamSource.id, backupFolder: null, collectedAt: null }
  return deps.records.create<RebaseRecord>(BASELINES, tenantId, {
    kind: "rebase",
    title: `${baseline.name} v${version.version} onto ${pack.reference}`,
    status: unresolved ? "review" : "ready",
    summary: rebaseSummary(entries),
    baselineId: id,
    fromVersion: version.version,
    toVersion: null,
    upstream,
    entries,
    unresolved,
  }, { actor, reason: baseSource ? `Compared with ${pack.reference}` : `Compared with ${pack.reference} without a recorded base` })
}

function rebaseSummary(entries: RebaseEntry[]): string {
  const count = (kind: RebaseEntry["kind"]) => entries.filter((entry) => entry.kind === kind).length
  const unresolved = entries.reduce((sum, entry) => sum + entry.unresolved, 0)
  return `${count("matched")} compared, ${count("added")} new in the release, ${count("removed")} removed by the release, ${count("local-missing")} removed by you; ${unresolved} decision${unresolved === 1 ? "" : "s"} open.`
}

/** Stores setting resolutions and policy choices of a rebase. */
export function resolveRebase(deps: FeatureDeps, tenantId: string, id: string, input: { settings: Array<{ policyKey: string; settingKey: string; choice: Choice }>; policies: Array<{ policyKey: string; choice: RebaseEntry["choice"] }> }, actor: Actor): Stored<RebaseRecord> {
  const rebase = getRebase(deps, tenantId, id)
  if (rebase.status !== "review" && rebase.status !== "ready") throw new FeatureError("This rebase can no longer be changed.", 409)
  const entries = structuredClone(rebase.entries)
  for (const setting of input.settings) {
    const entry = entries.find((candidate) => candidate.key === setting.policyKey)
    const decision = entry?.comparison?.settings.find((candidate) => candidate.key === setting.settingKey)
    if (!entry || !decision || !decision.needsResolution) throw new FeatureError("A resolution names a setting that does not need one.")
    entry.resolutions[setting.settingKey] = setting.choice
  }
  for (const choice of input.policies) {
    const entry = entries.find((candidate) => candidate.key === choice.policyKey)
    if (!entry) throw new FeatureError("A choice names a policy that is not part of this rebase.")
    const allowed = entry.kind === "added" ? ["include", "skip"] : entry.kind === "removed" ? ["keep", "drop"] : entry.kind === "matched" && entry.blockers.length ? ["local", "upstream"] : []
    if (!allowed.includes(String(choice.choice))) throw new FeatureError(`"${entry.name}" does not take this choice.`)
    entry.choice = choice.choice
  }
  for (const entry of entries) entry.unresolved = unresolvedOf(entry)
  const unresolved = entries.reduce((sum, entry) => sum + entry.unresolved, 0)
  return deps.records.update<RebaseRecord>(BASELINES, tenantId, id, (current) => ({ ...current, entries, unresolved, status: unresolved ? "review" : "ready", summary: rebaseSummary(entries) }), { actor, reason: `Recorded ${input.settings.length} resolution(s) and ${input.policies.length} policy choice(s)` })!
}

/**
 * Creates the rebased version: every decision applied, provenance moved to the new release.
 * Refuses while a decision is open or when the baseline got a newer version after the
 * comparison. Writes nothing to any tenant.
 */
export function applyRebase(deps: FeatureDeps, tenantId: string, id: string, note: string | null, actor: Actor): Stored<BaselineRecord> {
  const rebase = getRebase(deps, tenantId, id)
  if (rebase.status !== "ready") throw new FeatureError(rebase.status === "review" ? "Resolve every open decision first." : "This rebase was already applied or discarded.", 409)
  const baseline = getBaseline(deps, tenantId, rebase.baselineId)
  if (baseline.currentVersion !== rebase.fromVersion) throw new FeatureError(`Version ${baseline.currentVersion} was saved after this comparison. Discard it and compare again.`, 409)
  const version = getVersion(deps, tenantId, baseline, null)
  const upstream = getBaselineSource(deps, tenantId, rebase.upstream.sourceId!)
  const baseSource = version.base.sourceId ? getBaselineSource(deps, tenantId, version.base.sourceId) : null
  const snapshotOf = (source: typeof upstream | null, key: string) => {
    const found = source?.policies.find((policy) => policy.key === key)?.snapshot
    return found ? stripForBaseline(found).snapshot : null
  }
  const policies: CustomPolicy[] = []
  for (const entry of rebase.entries) {
    const local = version.policies.find((policy) => policy.key === entry.key)
    const release = snapshotOf(upstream, entry.key)
    if (entry.kind === "local-missing" || (entry.kind === "removed" && entry.choice === "drop") || (entry.kind === "added" && entry.choice === "skip")) continue
    if (entry.kind === "removed") {
      if (local) policies.push(local)
      continue
    }
    if (entry.kind === "added") {
      if (!release) throw new FeatureError(`The release content of "${entry.name}" is missing.`, 409)
      policies.push(customPolicy(String(release.name ?? entry.name), release))
      continue
    }
    if (!local || !release) throw new FeatureError(`The content of "${entry.name}" is missing. Compare again.`, 409)
    if (entry.blockers.length) {
      policies.push(entry.choice === "upstream" ? customPolicy(String(release.name ?? entry.name), release) : local)
      continue
    }
    let merged: Item
    try {
      merged = mergePolicy(snapshotOf(baseSource, entry.key), local.snapshot, release, entry.resolutions)
    } catch (error) {
      throw new FeatureError(`"${entry.name}" cannot be merged: ${error instanceof Error ? error.message : String(error)}`, 409)
    }
    const policy = customPolicy(String(merged.name ?? local.name), merged)
    policies.push({ ...policy, key: local.key })
  }
  if (!policies.length) throw new FeatureError("The rebased baseline would hold no policy.", 409)
  const updated = addVersion(deps, tenantId, baseline, { name: version.name, note: `Rebased onto ${rebase.upstream.reference}.${note ? ` ${note}` : ""}`, policies, base: rebase.upstream }, actor)
  deps.records.update<RebaseRecord>(BASELINES, tenantId, id, (current) => ({ ...current, status: "applied", toVersion: updated.currentVersion, summary: `Applied as version ${updated.currentVersion}.` }), { actor, reason: `Applied as version ${updated.currentVersion}` })
  deps.records.update<BaselineRecord>(BASELINES, tenantId, baseline.id, (current) => ({ ...current, latestKnownRelease: current.latestKnownRelease?.commit === rebase.upstream.commit ? null : current.latestKnownRelease }), { actor, reason: "Base release updated" })
  return getBaseline(deps, tenantId, baseline.id)
}

export function discardRebase(deps: FeatureDeps, tenantId: string, id: string, actor: Actor): Stored<RebaseRecord> {
  const rebase = getRebase(deps, tenantId, id)
  if (rebase.status === "applied") throw new FeatureError("An applied rebase stays in the history.", 409)
  return deps.records.update<RebaseRecord>(BASELINES, tenantId, id, (current) => ({ ...current, status: "discarded", summary: "Discarded." }), { actor, reason: "Discarded" })!
}

// ---------------------------------------------------------------------------------------------
// Comparisons

/**
 * Deviations between a baseline version and the tenant's Settings Catalog policies, from the
 * latest complete backup (or a chosen one) or from a live read. Only this tenant's own
 * baselines are compared. Writes nothing.
 */
export async function compareWithTenant(deps: FeatureDeps, tenantId: string, input: { baselineId: string; version: number | null; source: "backup" | "live"; backupId: string | null }, actor: Actor): Promise<Stored<ComparisonRecord>> {
  const baseline = getBaseline(deps, tenantId, input.baselineId)
  const version = getVersion(deps, tenantId, baseline, input.version)
  const type = typeForFolder(FOLDER)!
  let tenantPolicies: Array<{ id: string; name: string; snapshot: Item | null; error?: string }>
  let source: ComparisonRecord["source"]
  if (input.source === "backup") {
    const inventory = await collectFromBackup(deps, tenantId, input.backupId)
    if (!inventory.covered.includes(FOLDER)) throw new FeatureError("The backup did not collect Settings Catalog policies completely, so it cannot be compared.", 409)
    tenantPolicies = inventory.items.filter((item) => item.folder === FOLDER).map((item) => ({ id: item.id, name: item.name, snapshot: item.snapshot }))
    source = { type: "backup", backupId: inventory.backupId, collectedAt: inventory.collectedAt, completeness: inventory.completeness }
  } else {
    const graph = await deps.graph(tenantId)
    let listed: Item[]
    try {
      listed = await listAll(graph, `${type.path}?$select=id,name`)
    } catch (error) {
      throw new FeatureError(`The tenant's policies could not be read. ${error instanceof Error ? error.message : String(error)}`, 502)
    }
    const wanted = new Set(version.policies.map((policy) => policy.key))
    tenantPolicies = []
    for (const entry of listed) {
      if (typeof entry.name !== "string" || typeof entry.id !== "string" || !wanted.has(keyOf(entry.name))) {
        continue
      }
      try {
        const live = await readCurrent(graph, type, entry.id)
        tenantPolicies.push({ id: entry.id, name: entry.name, snapshot: live ? sanitizeSnapshot(type, live).snapshot : null })
      } catch (error) {
        tenantPolicies.push({ id: entry.id, name: entry.name, snapshot: null, error: error instanceof Error ? error.message : String(error) })
      }
    }
    source = { type: "live", readAt: deps.now().toISOString() }
  }
  const results: TenantComparisonPolicy[] = version.policies.map((policy) => {
    const matches = tenantPolicies.filter((entry) => keyOf(entry.name) === policy.key)
    if (!matches.length) return { key: policy.key, name: policy.name, state: "missing", note: "No tenant policy has this name.", differences: [] }
    if (matches.length > 1) return { key: policy.key, name: policy.name, state: "ambiguous", note: `${matches.length} tenant policies have this name.`, differences: [] }
    const match = matches[0]!
    if (!match.snapshot) return { key: policy.key, name: policy.name, state: "unreadable", note: match.error ? `The tenant policy could not be read (${match.error}). Its state is unknown.` : "The tenant policy disappeared during the read.", differences: [] }
    const tenantSnapshot = stripForBaseline(match.snapshot).snapshot
    // Base and upstream are the baseline: every tenant difference shows as a local difference.
    const expected = replaceTenantVariables(policy.snapshot, tenantId)
    const comparison = comparePolicy(expected, tenantSnapshot, expected)
    return { key: policy.key, name: policy.name, state: "matched", note: comparison.blockers.length ? comparison.blockers.join(" ") : null, differences: comparison.settings.filter((setting) => setting.kind !== "unchanged") }
  })
  // Secret and reference values cannot be compared: they are unknown, not deviations.
  const deviates = (entry: TenantComparisonPolicy) => entry.differences.some((setting) => setting.kind !== "unsupported")
  const counts = { matched: results.filter((entry) => entry.state === "matched").length, deviating: results.filter(deviates).length, unknownSettings: results.reduce((sum, entry) => sum + entry.differences.filter((setting) => setting.kind === "unsupported").length, 0), missing: results.filter((entry) => entry.state === "missing").length, unknown: results.filter((entry) => entry.state === "ambiguous" || entry.state === "unreadable").length, differences: results.reduce((sum, entry) => sum + entry.differences.filter((setting) => setting.kind !== "unsupported").length, 0) }
  const label = `Baseline ${baseline.name} v${version.version} compared with ${source.type === "backup" ? `backup ${source.backupId}` : "the live tenant"}.`
  return deps.records.create<ComparisonRecord>(COMPARISONS, tenantId, {
    kind: "tenant",
    title: `${baseline.name} v${version.version} and the tenant`,
    status: "frozen",
    summary: `${counts.deviating} of ${version.policies.length} policies deviate (${counts.differences} settings), ${counts.missing} missing, ${counts.unknown} unknown policies, ${counts.unknownSettings} settings not comparable.`,
    baselineId: baseline.id,
    version: version.version,
    label,
    source,
    tenantPolicies: results,
    counts,
  }, { actor, reason: label })
}

/** OpenIntuneBaseline as a comparison target; it is not in the framework catalog. */
const OIB_FRAMEWORK: Framework = { id: "oib", name: "OpenIntuneBaseline", publisher: "SkipToTheEndpoint", kind: "Baseline", source: `https://github.com/${OIB_REPO}`, description: "Community Intune policy baselines for managed endpoints.", coverage: "Settings Catalog policies of the chosen platform." }

export type FrameworkTarget =
  | { kind: "oib"; platform: OibPlatform; commit: string }
  | { kind: "ncsc" }
  | { kind: "workspace"; frameworkId: string }
  | { kind: "native"; frameworkId: string; scope: AssessmentScope }

/**
 * Compares a baseline version with a framework without reading any tenant. Pack frameworks
 * (OIB at any listed release, NCSC, workspace packs) run the existing pack assessment with the
 * baseline's policies as the policy set; native frameworks run the native engine on evidence
 * built from the baseline, where everything a baseline cannot provide stays unknown.
 * CIS content keeps its own paid gate and is not offered while it is disabled.
 */
export async function compareWithFramework(deps: FeatureDeps, sources: CustomBaselineSources, context: { tenantId: string; plan: Plan }, input: { baselineId: string; version: number | null; target: FrameworkTarget }, actor: Actor): Promise<Stored<ComparisonRecord>> {
  const { tenantId } = context
  const baseline = getBaseline(deps, tenantId, input.baselineId)
  const version = getVersion(deps, tenantId, baseline, input.version)
  const label = comparisonLabel(baseline.name, version.version)
  const target = input.target
  const frameworkId = target.kind === "oib" ? OIB_FRAMEWORK.id : target.kind === "ncsc" ? "ncsc-dsg" : target.frameworkId
  // OpenIntuneBaseline has its own section rather than a catalog entry.
  const framework = target.kind === "oib" ? OIB_FRAMEWORK : frameworks.find((entry) => entry.id === frameworkId)
  if (!framework) throw new FeatureError("Unknown framework.")
  if (framework.disabledReason) throw new FeatureError(framework.disabledReason, 403)
  if (CIS_FRAMEWORKS.has(framework.id) && !allows(context.plan, "baselineAllPlatforms")) throw new PlanRequired("baselineAllPlatforms")
  const title = `${baseline.name} v${version.version} and ${framework.name}`

  if (target.kind === "native") {
    if (!framework.nativeId) throw new FeatureError("This framework has no native comparison.")
    const data = baselineEvidence(version.policies, version.createdAt)
    data.assessmentScope = target.scope
    const manifest = await createEvidenceManifest(data)
    const selected = manifest.assessment.frameworks.find((entry) => entry.framework.id === framework.nativeId)
    if (!selected) throw new FeatureError("Native framework definition unavailable.", 500)
    const ids = new Set(selected.controls.flatMap((control) => [...control.capabilityIds, ...control.excludedCapabilityIds]))
    const native: NativeAssessment = {
      schemaVersion: 1,
      runId: `baseline-${version.id}`,
      tenantId,
      frameworkId: framework.id,
      sourceCommit: FRAMEWORK_SOURCE_COMMIT,
      snapshotSha256: manifest.snapshotSha256,
      rulesetSha256: manifest.rulesetSha256,
      licenseNotice: framework.licenseNotice ?? "",
      assessment: { ...manifest.assessment, frameworks: [selected], capabilities: manifest.assessment.capabilities.filter((capability) => ids.has(capability.capability.id)) },
    }
    const counts = comparisonCounts(native)
    return deps.records.create<ComparisonRecord>(COMPARISONS, tenantId, {
      kind: "framework",
      title,
      status: "frozen",
      summary: `${counts.matches} matching, ${counts.different} different, ${counts.unableToCheck} unknown checks. ${label}`,
      baselineId: baseline.id,
      version: version.version,
      label,
      source: { type: "native", frameworkId: framework.id, rulesetVersion: manifest.assessment.provenance.rulesetVersion },
      counts,
      native,
    }, { actor, reason: label })
  }

  let pack: { policies: BaselinePolicy[]; reference: string }
  try {
    if (target.kind === "oib") {
      const loaded = await sources.pack(target.platform, target.commit)
      const catalog = loaded.items.filter((item) => item.folder === FOLDER).map((item) => item.snapshot)
      pack = { policies: catalog.length ? parsePolicies(catalog) : [], reference: loaded.reference }
    } else if (target.kind === "ncsc") pack = await sources.ncsc()
    else {
      if (framework.nativeId) throw new FeatureError("Use the native comparison for this framework.")
      const workspace = sources.workspace(tenantId, framework.id)
      pack = { policies: workspace.policies, reference: workspace.reference }
    }
  } catch (error) {
    if (error instanceof FeatureError) throw error
    throw new FeatureError(`The framework pack could not be loaded. ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  if (!pack.policies.length) throw new FeatureError(target.kind === "workspace" ? "This framework workspace has no stored pack. Load or import one on its Frameworks page first." : "The pack holds no Settings Catalog policies.", 404)
  const assessment = assessPolicySet({ tenantId, frameworkId: framework.id, reference: pack.reference, policies: pack.policies, current: baselineLandscape(version.policies), assessedAt: deps.now().toISOString() })
  const findings = maskUnknownFindings(assessment.findings)
  const counts = { Present: 0, Missing: 0, Different: 0, Review: 0 }
  for (const finding of findings) counts[finding.status] += 1
  return deps.records.create<ComparisonRecord>(COMPARISONS, tenantId, {
    kind: "framework",
    title,
    status: "frozen",
    summary: `${counts.Present} present, ${counts.Missing} missing, ${counts.Different} different, ${counts.Review} to review. ${label}`,
    baselineId: baseline.id,
    version: version.version,
    label,
    source: { type: "pack", frameworkId: framework.id, reference: pack.reference },
    findings,
    counts,
  }, { actor, reason: label })
}

export { plainOf }
