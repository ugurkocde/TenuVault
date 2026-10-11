import { typeForFolder, type Item } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import { replaceTenantVariables } from "../../../shared/oib/variables"
import type { ListedRecord, WorkSignal } from "../contracts"
import type { FeatureDeps } from "../deps"
import { DOMAINS } from "../domains"
import { SHARED_SCOPE, type Stored } from "../records"
import { FeatureError } from "../route"
import { createChangeSet, listChangeSets, type OperationInput } from "../change-sets/engine"
import { listAll, readCurrent } from "../change-sets/graph"
import { containsRedaction, diffConfigurations, hashOf, MAX_OPERATIONS, sanitizeSnapshot, type DiffEntry } from "../change-sets/model"
import { policyHash } from "../baseline-upgrades/merge"
import {
  assessPolicy,
  buildStandardPolicies,
  containsTenantEvidence,
  diffVersions,
  effectiveConfiguration,
  migrateParameters,
  parseParameterDefs,
  referencedIds,
  versionContentHash,
  type Overlay,
  type ParameterDef,
  type Problem,
  type SettingState,
  type StandardVersion,
  type VersionDiffEntry,
} from "./model"

/**
 * Organization customizations (Pro) and reusable golden standards with customer overlays (MSP)
 * (#148). Standard versions live in the shared record scope and never carry tenant evidence;
 * each customer's adoption (parameters, overlay, approved exceptions, mappings, adopted version
 * and last assessment) lives under that customer's tenant. A new standard version changes
 * nothing by itself: moving a customer to it is a reviewed diff that creates a change set.
 */

const FOLDER = "ConfigurationPolicies"
const STANDARDS = DOMAINS.standards
const ADOPTIONS = DOMAINS.adoptions
const CUSTOMIZATIONS = DOMAINS.customizations
/** An assessment older than this is shown as stale. */
export const ASSESSMENT_FRESH_DAYS = 7

type Actor = string | null
const policyType = () => typeForFolder(FOLDER)!

// ---------------------------------------------------------------------------------------------
// Organization customizations (Pro)

export interface CustomizationRecord extends ListedRecord {
  status: "active" | "retired"
  /** The installed baseline (#144) it deviates from, when known. */
  installId: string | null
  baselineReference: string | null
  policyName: string | null
  settingKey: string
  /** The organization's value, as plain text; never a secret. */
  value: string | null
  reason: string
  owner: string
  version: number
}

export function listCustomizations(deps: FeatureDeps, tenantId: string): Stored<CustomizationRecord>[] {
  return deps.records.list<CustomizationRecord>(CUSTOMIZATIONS, tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function getCustomization(deps: FeatureDeps, tenantId: string, id: string): Stored<CustomizationRecord> {
  const record = deps.records.get<CustomizationRecord>(CUSTOMIZATIONS, tenantId, id)
  if (!record) throw new FeatureError("This customization does not exist for this tenant.", 404)
  return record
}

export function createCustomization(deps: FeatureDeps, tenantId: string, input: Omit<CustomizationRecord, "status" | "summary" | "version">, actor: Actor): Stored<CustomizationRecord> {
  return deps.records.create<CustomizationRecord>(CUSTOMIZATIONS, tenantId, { ...input, status: "active", version: 1, summary: `Deviation of ${input.settingKey} owned by ${input.owner}.` }, { actor, reason: `Documented a customization: ${input.reason}` })
}

/** A new version of a customization; the previous one stays in its history. */
export function reviseCustomization(deps: FeatureDeps, tenantId: string, id: string, change: { value?: string | null; reason?: string; owner?: string }, why: string, actor: Actor): Stored<CustomizationRecord> {
  const current = getCustomization(deps, tenantId, id)
  if (current.status !== "active") throw new FeatureError("A retired customization cannot be revised. Document a new one.", 409)
  return deps.records.update<CustomizationRecord>(CUSTOMIZATIONS, tenantId, id, (record) => ({ ...record, ...change, version: record.version + 1, summary: `Deviation of ${record.settingKey} owned by ${change.owner ?? record.owner}, version ${record.version + 1}.` }), { actor, reason: why })!
}

export function retireCustomization(deps: FeatureDeps, tenantId: string, id: string, why: string, actor: Actor): Stored<CustomizationRecord> {
  getCustomization(deps, tenantId, id)
  return deps.records.update<CustomizationRecord>(CUSTOMIZATIONS, tenantId, id, (record) => ({ ...record, status: "retired", summary: `Retired: ${why}` }), { actor, reason: `Retired: ${why}` })!
}

// ---------------------------------------------------------------------------------------------
// Standard versions (MSP, shared scope)

export function listStandardVersions(deps: FeatureDeps): Stored<StandardVersion>[] {
  return deps.records.list<StandardVersion>(STANDARDS, SHARED_SCOPE).sort((a, b) => a.standardKey.localeCompare(b.standardKey) || b.version - a.version)
}

export function getStandardVersion(deps: FeatureDeps, id: string): Stored<StandardVersion> {
  const record = deps.records.get<StandardVersion>(STANDARDS, SHARED_SCOPE, id)
  if (!record) throw new FeatureError("This standard version does not exist.", 404)
  return record
}

export function latestVersion(deps: FeatureDeps, standardKey: string): Stored<StandardVersion> | null {
  return listStandardVersions(deps).find((version) => version.standardKey === standardKey) ?? null
}

export interface VersionInput {
  name: string
  changeNotes: string
  source: StandardVersion["source"]
  policies: unknown
  parameters: unknown
  bindings: Array<{ policyKey: string; settingDefinitionId: string; parameter: string }>
}

/**
 * Publishes an immutable version. A new version of an existing standard must name the latest
 * version as its predecessor, so two technicians never publish from a stale version. The
 * content must not contain the working tenant's identifiers or any connected tenant ID.
 */
export function publishVersion(deps: FeatureDeps, input: VersionInput & { standardKey: string | null; previousVersionId: string | null }, evidenceIds: string[], actor: Actor): Stored<StandardVersion> {
  let parameters: ParameterDef[]
  let policies
  try {
    parameters = parseParameterDefs(input.parameters)
    policies = buildStandardPolicies(input.policies, parameters, input.bindings)
  } catch (error) {
    throw new FeatureError(error instanceof Error ? error.message : String(error))
  }
  if (containsTenantEvidence({ parameters, policies }, evidenceIds)) throw new FeatureError("The content contains identifiers of a connected tenant. Bind tenant-specific values to parameters; reusable standards never store tenant evidence.")
  let standardKey = input.standardKey
  let version = 1
  if (input.previousVersionId) {
    const previous = getStandardVersion(deps, input.previousVersionId)
    const latest = latestVersion(deps, previous.standardKey)!
    if (latest.id !== previous.id) throw new FeatureError(`Version ${previous.version} is not the latest version (${latest.version}) of this standard. Start from the latest version.`, 409)
    standardKey = previous.standardKey
    version = previous.version + 1
    if (versionContentHash({ parameters, policies }) === previous.contentHash) throw new FeatureError("The content is identical to the previous version.", 409)
    for (const def of parameters) {
      if (def.renamedFrom && !previous.parameters.some((old) => old.name === def.renamedFrom)) throw new FeatureError(`Parameter "${def.name}" names a previous name "${def.renamedFrom}" that version ${previous.version} does not have.`)
    }
  } else {
    if (!standardKey || !/^[a-z][a-z0-9-]{1,40}$/.test(standardKey)) throw new FeatureError("A standard key uses lowercase letters, digits and hyphens.")
    if (latestVersion(deps, standardKey)) throw new FeatureError("A standard with this key exists. Publish a new version of it instead.", 409)
  }
  if (!input.changeNotes.trim()) throw new FeatureError("Change notes are required.")
  const record: StandardVersion = {
    title: `${input.name} v${version}`,
    status: "published",
    summary: `${policies.length} policies, ${parameters.length} parameters. ${input.changeNotes.slice(0, 200)}`,
    standardKey: standardKey!,
    version,
    previousVersionId: input.previousVersionId,
    source: input.source,
    changeNotes: input.changeNotes,
    parameters,
    policies,
    contentHash: versionContentHash({ parameters, policies }),
  }
  return deps.records.create<StandardVersion>(STANDARDS, SHARED_SCOPE, record, { actor, reason: `Published ${record.title}` })
}

// ---------------------------------------------------------------------------------------------
// Customer adoptions (MSP, per customer tenant)

export interface AdoptionAssessment {
  at: string
  versionId: string
  counts: Record<SettingState, number>
  policies: Array<{ policyKey: string; state: "assessed" | "missing" | "unreadable" | "unmapped"; deviations: number; message: string | null }>
}

export interface AdoptionRecord extends ListedRecord {
  status: "draft" | "change-set" | "adopted" | "partial" | "failed" | "uncertain"
  standardKey: string
  /** The version this customer is configured for (the next adoption target). */
  versionId: string
  version: number
  /** The version whose change set was applied and verified; null before the first adoption. */
  adoptedVersionId: string | null
  adoptedVersion: number | null
  adoptedAt: string | null
  parameters: Record<string, unknown>
  overlay: Overlay
  overlayVersion: number
  /** Customer policy per standard policy: an existing object to update, or null to create one. */
  mappings: Array<{ policyKey: string; objectId: string | null }>
  migrationNotes: Array<{ kind: string; name: string; message: string }>
  /** The open change set and the exact configuration it writes (parameter values and overlay at plan time). */
  pending: { changeSetId: string; versionId: string; version: number; operations: Record<string, string>; parameters: Record<string, unknown>; overlay: Pick<Overlay, "settings" | "removals"> } | null
  /** Parameter values and overlay of the adopted version as applied; assessments compare against these. */
  adoptedParameters: Record<string, unknown> | null
  adoptedOverlay: Pick<Overlay, "settings" | "removals"> | null
  /** The applied change set of the adopted version, and what was adopted before it, so an applied rollback is recorded. */
  adoptedChangeSetId: string | null
  previousAdopted: { versionId: string | null; version: number | null; mappings: Array<{ policyKey: string; objectId: string | null }>; parameters: Record<string, unknown> | null; overlay: Pick<Overlay, "settings" | "removals"> | null } | null
  lastAssessment: AdoptionAssessment | null
}

export function listAdoptions(deps: FeatureDeps, tenantId: string): Stored<AdoptionRecord>[] {
  return deps.records.list<AdoptionRecord>(ADOPTIONS, tenantId).sort((a, b) => a.standardKey.localeCompare(b.standardKey))
}

export function getAdoption(deps: FeatureDeps, tenantId: string, id: string): Stored<AdoptionRecord> {
  const record = deps.records.get<AdoptionRecord>(ADOPTIONS, tenantId, id)
  if (!record) throw new FeatureError("This adoption does not exist for this tenant.", 404)
  return record
}

export function startAdoption(deps: FeatureDeps, tenantId: string, versionId: string, actor: Actor): Stored<AdoptionRecord> {
  const version = getStandardVersion(deps, versionId)
  if (listAdoptions(deps, tenantId).some((adoption) => adoption.standardKey === version.standardKey)) throw new FeatureError("This customer already adopts this standard. Configure the existing adoption.", 409)
  return deps.records.create<AdoptionRecord>(ADOPTIONS, tenantId, {
    title: version.title,
    status: "draft",
    summary: "Configure parameters, overlay and mappings, then preview.",
    standardKey: version.standardKey,
    versionId: version.id,
    version: version.version,
    adoptedVersionId: null,
    adoptedVersion: null,
    adoptedAt: null,
    parameters: {},
    overlay: { settings: [], removals: [], exceptions: [] },
    overlayVersion: 1,
    mappings: [],
    migrationNotes: [],
    pending: null,
    adoptedParameters: null,
    adoptedOverlay: null,
    adoptedChangeSetId: null,
    previousAdopted: null,
    lastAssessment: null,
  }, { actor, reason: `Started adopting ${version.title}` })
}

/**
 * Changes a customer's parameters, overlay, exceptions, mappings or target version. Moving to
 * another version migrates parameter values (renamed carried over, removed and missing listed)
 * and records the notes; nothing is written to the tenant.
 */
export function configureAdoption(deps: FeatureDeps, tenantId: string, id: string, change: { versionId?: string; parameters?: Record<string, unknown>; overlay?: Overlay; mappings?: AdoptionRecord["mappings"] }, actor: Actor): Stored<AdoptionRecord> {
  const adoption = getAdoption(deps, tenantId, id)
  if (adoption.pending) throw new FeatureError("A change set of this adoption is open. Apply or reject it first.", 409)
  let parameters = change.parameters ?? adoption.parameters
  let migrationNotes = adoption.migrationNotes
  let target = getStandardVersion(deps, adoption.versionId)
  if (change.versionId && change.versionId !== adoption.versionId) {
    const next = getStandardVersion(deps, change.versionId)
    if (next.standardKey !== adoption.standardKey) throw new FeatureError("That version belongs to another standard.")
    const migrated = migrateParameters(target.parameters, next.parameters, parameters)
    parameters = migrated.values
    migrationNotes = migrated.notes
    target = next
  }
  for (const mapping of change.mappings ?? []) {
    if (!target.policies.some((policy) => policy.key === mapping.policyKey)) throw new FeatureError(`A mapping names a policy that is not in ${target.title}.`)
  }
  const overlayChanged = change.overlay && hashOf(change.overlay) !== hashOf(adoption.overlay)
  return deps.records.update<AdoptionRecord>(ADOPTIONS, tenantId, id, (current) => ({
    ...current,
    title: target.title,
    versionId: target.id,
    version: target.version,
    parameters,
    migrationNotes,
    overlay: change.overlay ?? current.overlay,
    overlayVersion: current.overlayVersion + (overlayChanged ? 1 : 0),
    mappings: change.mappings ?? current.mappings,
    summary: target.id !== current.adoptedVersionId && current.adoptedVersionId ? `Configured for ${target.title}; adopted: v${current.adoptedVersion}. Preview the upgrade.` : "Configured. Preview before adoption.",
  }), { actor, reason: change.versionId && change.versionId !== adoption.versionId ? `Retargeted to ${target.title}` : "Updated parameters, overlay or mappings" })!
}

export interface AdoptionPreview {
  adoptionId: string
  version: { id: string; title: string; latest: boolean; latestTitle: string }
  adoptedVersion: number | null
  parameters: Record<string, string | number>
  problems: Problem[]
  migrationNotes: AdoptionRecord["migrationNotes"]
  versionDiff: VersionDiffEntry[]
  policies: Array<{ key: string; name: string; action: "create" | "update" | "none" | "blocked"; objectId: string | null; diff: DiffEntry[]; truncated: boolean }>
  ready: boolean
  notice: string
}

interface Planned {
  preview: AdoptionPreview
  operations: Array<OperationInput & { policyKey: string }>
}

/**
 * The effective customer configuration against the live tenant: conflicts, target-specific
 * validation (mapped policies exist and fit, references exist in this tenant), the version diff
 * from the adopted version and a per-policy diff. Reads only.
 */
async function plan(deps: FeatureDeps, tenantId: string, adoption: AdoptionRecord & { id: string }): Promise<Planned> {
  const version = getStandardVersion(deps, adoption.versionId)
  const latest = latestVersion(deps, version.standardKey)!
  const { policies, problems, parameters } = effectiveConfiguration(version, adoption.parameters, adoption.overlay)
  for (const note of adoption.migrationNotes) if (note.kind === "missing") problems.push({ kind: "blocker", policyKey: null, settingKey: null, message: note.message })
  const graph = await deps.graph(tenantId)
  const references = referencedIds(policies)
  if (references.length) {
    try {
      const reusable = new Set((await listAll(graph, "deviceManagement/reusablePolicySettings?$select=id,displayName")).map((entry) => String(entry.id ?? "").toLowerCase()))
      for (const id of references) if (!reusable.has(id)) problems.push({ kind: "blocker", policyKey: null, settingKey: null, message: `The reusable setting ${id} does not exist in this tenant.` })
    } catch (error) {
      problems.push({ kind: "blocker", policyKey: null, settingKey: null, message: `Reusable settings could not be read (${error instanceof Error ? error.message : String(error)}); references cannot be verified.` })
    }
  }
  const rows: AdoptionPreview["policies"] = []
  const operations: Planned["operations"] = []
  for (const policy of policies) {
    const mapping = adoption.mappings.find((entry) => entry.policyKey === policy.key)
    if (!mapping) {
      problems.push({ kind: "blocker", policyKey: policy.key, settingKey: null, message: `Choose whether "${policy.name}" updates an existing policy or creates a new one.` })
      rows.push({ key: policy.key, name: policy.name, action: "blocked", objectId: null, diff: [], truncated: false })
      continue
    }
    if (!mapping.objectId) {
      const diff = diffConfigurations(policyType(), null, replaceTenantVariables(policy.snapshot, tenantId))
      rows.push({ key: policy.key, name: policy.name, action: "create", objectId: null, diff: diff.entries, truncated: diff.truncated })
      operations.push({ policyKey: policy.key, folder: FOLDER, action: "create", proposed: policy.snapshot, assignments: null, source: { tenantId: null, objectId: null, version: version.id, label: version.title } })
      continue
    }
    let live: Item | null = null
    try {
      live = await readCurrent(graph, policyType(), mapping.objectId)
    } catch (error) {
      problems.push({ kind: "blocker", policyKey: policy.key, settingKey: null, message: `The mapped policy of "${policy.name}" could not be read (${error instanceof Error ? error.message : String(error)}); its state is unknown.` })
      rows.push({ key: policy.key, name: policy.name, action: "blocked", objectId: mapping.objectId, diff: [], truncated: false })
      continue
    }
    if (!live) {
      problems.push({ kind: "blocker", policyKey: policy.key, settingKey: null, message: `The mapped policy of "${policy.name}" no longer exists in this tenant. Map another policy or create one.` })
      rows.push({ key: policy.key, name: policy.name, action: "blocked", objectId: mapping.objectId, diff: [], truncated: false })
      continue
    }
    const { snapshot } = sanitizeSnapshot(policyType(), live)
    if (snapshot.platforms !== policy.snapshot.platforms || snapshot.technologies !== policy.snapshot.technologies) {
      problems.push({ kind: "blocker", policyKey: policy.key, settingKey: null, message: `The mapped policy of "${policy.name}" is for ${String(snapshot.platforms)}/${String(snapshot.technologies)}, the standard for ${String(policy.snapshot.platforms)}/${String(policy.snapshot.technologies)}.` })
      rows.push({ key: policy.key, name: policy.name, action: "blocked", objectId: mapping.objectId, diff: [], truncated: false })
      continue
    }
    if (containsRedaction(snapshot)) {
      problems.push({ kind: "blocker", policyKey: policy.key, settingKey: null, message: `The mapped policy of "${policy.name}" holds values Intune masks; it cannot be updated automatically.` })
      rows.push({ key: policy.key, name: policy.name, action: "blocked", objectId: mapping.objectId, diff: [], truncated: false })
      continue
    }
    // The customer's name, description and scope tags stay; the standard decides the settings.
    const { assignments: _assignments, ...kept } = snapshot
    const proposed: Item = { ...kept, settings: policy.snapshot.settings ?? [] }
    const expected = replaceTenantVariables(proposed, tenantId)
    const diff = diffConfigurations(policyType(), snapshot, expected)
    const unchanged = policyHash(expected) === policyHash(snapshot)
    rows.push({ key: policy.key, name: policy.name, action: unchanged ? "none" : "update", objectId: mapping.objectId, diff: diff.entries, truncated: diff.truncated })
    if (!unchanged) operations.push({ policyKey: policy.key, folder: FOLDER, action: "update", targetId: mapping.objectId, proposed, assignments: null, source: { tenantId: null, objectId: null, version: version.id, label: version.title } })
  }
  const adopted = adoption.adoptedVersionId ? getStandardVersion(deps, adoption.adoptedVersionId) : null
  const blocking = problems.some((problem) => problem.kind !== "warning")
  return {
    preview: {
      adoptionId: adoption.id,
      version: { id: version.id, title: version.title, latest: latest.id === version.id, latestTitle: latest.title },
      adoptedVersion: adoption.adoptedVersion,
      parameters,
      problems,
      migrationNotes: adoption.migrationNotes,
      versionDiff: adopted && adopted.id !== version.id ? diffVersions(adopted, version) : [],
      policies: rows,
      ready: !blocking && operations.length > 0,
      notice: "Preview only. Nothing is written until a change set is created, reviewed, approved and applied. Assignments are never changed by an adoption.",
    },
    operations,
  }
}

export async function previewAdoption(deps: FeatureDeps, tenantId: string, id: string): Promise<AdoptionPreview> {
  return (await plan(deps, tenantId, getAdoption(deps, tenantId, id))).preview
}

/**
 * Creates the change set that moves a customer to its configured version (origin
 * "standard-adoption"). Refuses on any conflict or blocker, and requires acknowledging removed
 * parameters, so a new base version never reaches a tenant without a review.
 */
export async function planAdoption(deps: FeatureDeps, tenantId: string, id: string, input: { acknowledgeMigration: boolean; title: string | null; ticket: string | null }, actor: Actor) {
  const adoption = getAdoption(deps, tenantId, id)
  if (adoption.pending) throw new FeatureError("A change set of this adoption is already open.", 409)
  const { preview, operations } = await plan(deps, tenantId, adoption)
  const blocking = preview.problems.filter((problem) => problem.kind !== "warning")
  if (blocking.length) throw new FeatureError(`Resolve ${blocking.length} conflict${blocking.length === 1 ? "" : "s"} or blocker${blocking.length === 1 ? "" : "s"} first: ${blocking[0]!.message}`, 409)
  if (adoption.migrationNotes.some((note) => note.kind === "removed") && !input.acknowledgeMigration) throw new FeatureError("Parameters were removed in this version. Acknowledge that their customer values no longer apply.", 409)
  if (!operations.length) throw new FeatureError("The tenant already matches the effective configuration; nothing to write.", 409)
  if (operations.length > MAX_OPERATIONS) throw new FeatureError(`A change set holds at most ${MAX_OPERATIONS} operations; this adoption needs ${operations.length}. Split the standard.`)
  const changeSet = await createChangeSet(deps, tenantId, {
    title: input.title ?? `Adopt ${preview.version.title}`.slice(0, 200),
    ticket: input.ticket,
    origin: { workflow: "standard-adoption", recordId: id },
    sourceTenantId: null,
    sourceVersion: preview.version.id,
    operations: operations.map(({ policyKey: _key, ...operation }) => operation),
  }, actor)
  const updated = deps.records.update<AdoptionRecord>(ADOPTIONS, tenantId, id, (current) => ({
    ...current,
    status: "change-set",
    pending: { changeSetId: changeSet.id, versionId: preview.version.id, version: adoption.version, operations: Object.fromEntries(operations.map((operation, index) => [`op-${index + 1}`, operation.policyKey])), parameters: structuredClone(preview.parameters), overlay: { settings: structuredClone(current.overlay.settings), removals: structuredClone(current.overlay.removals) } },
    summary: `Change set "${changeSet.title}" waits for review under Standards.`,
  }), { actor, reason: `Created change set ${changeSet.id} for ${preview.version.title}` })!
  return { adoption: updated, changeSet, preview }
}

/**
 * Records change-set outcomes on an adoption (bookkeeping of stored records, on every plan):
 * applied sets the adopted version and the IDs of created policies; rejected or stale change
 * sets release the adoption for a new review.
 */
export function syncAdoption(deps: FeatureDeps, tenantId: string, id: string): Stored<AdoptionRecord> {
  const adoption = getAdoption(deps, tenantId, id)
  if (!adoption.pending) return syncRollback(deps, tenantId, adoption)
  const pending = adoption.pending
  const changeSet = listChangeSets(deps, tenantId).find((entry) => entry.id === pending.changeSetId)
  if (!changeSet || ["in-review", "approved", "applying"].includes(changeSet.status)) return adoption
  const created = Object.entries(pending.operations).flatMap(([opKey, policyKey]) => {
    const operation = changeSet.operations.find((entry) => entry.key === opKey)
    const result = changeSet.results[opKey]
    return operation?.action === "create" && result?.status === "verified" && isGraphId(result.objectId) ? [{ policyKey, objectId: result.objectId }] : []
  })
  const mappings = (current: AdoptionRecord) => current.mappings.map((mapping) => created.find((entry) => entry.policyKey === mapping.policyKey) ?? mapping)
  if (changeSet.status === "rejected" || changeSet.status === "stale") {
    return deps.records.update<AdoptionRecord>(ADOPTIONS, tenantId, id, (current) => ({ ...current, status: current.adoptedVersionId ? "adopted" : "draft", pending: null, summary: `Change set was ${changeSet.status}; nothing was written. Preview again.` }), { actor: null, reason: `Change set ${changeSet.status}` })!
  }
  if (changeSet.status === "applied") {
    return deps.records.update<AdoptionRecord>(ADOPTIONS, tenantId, id, (current) => ({ ...current, status: "adopted", adoptedVersionId: pending.versionId, adoptedVersion: pending.version, adoptedAt: changeSet.updatedAt, adoptedChangeSetId: changeSet.id, adoptedParameters: pending.parameters, adoptedOverlay: pending.overlay, previousAdopted: { versionId: current.adoptedVersionId, version: current.adoptedVersion, mappings: current.mappings, parameters: current.adoptedParameters, overlay: current.adoptedOverlay }, mappings: mappings(current), migrationNotes: [], pending: null, summary: `Adopted v${pending.version}; verified by read-back.` }), { actor: null, reason: `Adopted version ${pending.version}` })!
  }
  const status = changeSet.status === "partial" ? "partial" : changeSet.status === "failed" ? "failed" : "uncertain"
  if (adoption.status === status && created.every((entry) => adoption.mappings.some((mapping) => mapping.objectId === entry.objectId))) return adoption
  // Keep the pending change set: a retry through this route is synchronized again.
  return deps.records.update<AdoptionRecord>(ADOPTIONS, tenantId, id, (current) => ({ ...current, status, mappings: mappings(current), summary: `Change set ${changeSet.status}: ${changeSet.summary} Retry or roll it back under Standards.` }), { actor: null, reason: `Change set ${changeSet.status}` })!
}

/** An applied rollback of the adopting change set returns the adoption to what was adopted before. */
function syncRollback(deps: FeatureDeps, tenantId: string, adoption: Stored<AdoptionRecord>): Stored<AdoptionRecord> {
  if (!adoption.adoptedChangeSetId || !adoption.previousAdopted) return adoption
  const rollback = listChangeSets(deps, tenantId).find((entry) => entry.kind === "rollback" && entry.rollbackOf === adoption.adoptedChangeSetId && (entry.status === "applied" || entry.status === "partial"))
  if (!rollback) return adoption
  const previous = adoption.previousAdopted
  const complete = rollback.status === "applied"
  return deps.records.update<AdoptionRecord>(ADOPTIONS, tenantId, adoption.id, (current) => ({
    ...current,
    status: complete ? (previous.versionId ? "adopted" : "draft") : "partial",
    adoptedVersionId: complete ? previous.versionId : current.adoptedVersionId,
    adoptedVersion: complete ? previous.version : current.adoptedVersion,
    mappings: complete ? previous.mappings : current.mappings,
    adoptedParameters: complete ? previous.parameters : current.adoptedParameters,
    adoptedOverlay: complete ? previous.overlay : current.adoptedOverlay,
    adoptedChangeSetId: null,
    previousAdopted: null,
    summary: complete ? `Rolled back to ${previous.version ? `v${previous.version}` : "the state before adoption"}.` : "The rollback was applied only partially; assess the tenant.",
  }), { actor: null, reason: complete ? "Adoption rolled back" : "Adoption rollback partial" })!
}

/**
 * Compares the customer's live policies with the effective configuration of the adopted (or,
 * before adoption, the configured) version and stores the result with its time. Unreadable or
 * missing policies stay visible as such, never as matching.
 */
export async function assessAdoption(deps: FeatureDeps, tenantId: string, id: string, actor: Actor): Promise<Stored<AdoptionRecord>> {
  const adoption = getAdoption(deps, tenantId, id)
  const version = getStandardVersion(deps, adoption.adoptedVersionId ?? adoption.versionId)
  // After adoption, compare with exactly what was applied; before, with the current configuration.
  // Exceptions always come from the current overlay: approving one does not need a new adoption.
  const adopted = adoption.adoptedVersionId !== null && adoption.adoptedParameters !== null && adoption.adoptedOverlay !== null
  const parameters = adopted ? adoption.adoptedParameters! : adoption.parameters
  const overlay: Overlay = adopted ? { ...adoption.adoptedOverlay!, exceptions: adoption.overlay.exceptions } : adoption.overlay
  const { policies } = effectiveConfiguration(version, parameters, overlay)
  const graph = await deps.graph(tenantId)
  const counts: Record<SettingState, number> = { match: 0, differs: 0, missing: 0, extra: 0, excepted: 0 }
  const rows: AdoptionAssessment["policies"] = []
  const now = deps.now()
  for (const policy of policies) {
    const objectId = adoption.mappings.find((mapping) => mapping.policyKey === policy.key)?.objectId ?? null
    if (!objectId) {
      rows.push({ policyKey: policy.key, state: "unmapped", deviations: 0, message: "No customer policy is mapped; deviation unknown." })
      continue
    }
    try {
      const live = await readCurrent(graph, policyType(), objectId)
      if (!live) {
        rows.push({ policyKey: policy.key, state: "missing", deviations: 0, message: "The mapped policy no longer exists." })
        continue
      }
      const states = assessPolicy(replaceTenantVariables(policy.snapshot, tenantId), sanitizeSnapshot(policyType(), live).snapshot, policy.key, adoption.overlay.exceptions, now)
      for (const entry of states) counts[entry.state] += 1
      rows.push({ policyKey: policy.key, state: "assessed", deviations: states.filter((entry) => entry.state === "differs" || entry.state === "missing" || entry.state === "extra").length, message: null })
    } catch (error) {
      rows.push({ policyKey: policy.key, state: "unreadable", deviations: 0, message: error instanceof Error ? error.message : String(error) })
    }
  }
  const assessment: AdoptionAssessment = { at: now.toISOString(), versionId: version.id, counts, policies: rows }
  return deps.records.update<AdoptionRecord>(ADOPTIONS, tenantId, id, (current) => ({ ...current, lastAssessment: assessment }), { actor, reason: `Assessed deviation against ${version.title}` })!
}

/** Per adoption: version state, deviation and assessment freshness, from stored records only. */
export function adoptionStatus(deps: FeatureDeps, adoption: AdoptionRecord & { id: string; tenantId: string }) {
  const latest = latestVersion(deps, adoption.standardKey)
  const reference = adoption.adoptedVersion ?? 0
  const assessment = adoption.lastAssessment
  const age = assessment ? deps.now().getTime() - Date.parse(assessment.at) : Infinity
  const unknownPolicies = assessment ? assessment.policies.filter((entry) => entry.state !== "assessed").length : null
  return {
    id: adoption.id,
    tenantId: adoption.tenantId,
    standardKey: adoption.standardKey,
    title: adoption.title,
    status: adoption.status,
    adoptedVersion: adoption.adoptedVersion,
    configuredVersion: adoption.version,
    latestVersion: latest?.version ?? null,
    pendingUpgrade: !!latest && latest.version > reference,
    deviations: assessment ? assessment.policies.reduce((sum, entry) => sum + entry.deviations, 0) : null,
    unknownPolicies,
    assessedAt: assessment?.at ?? null,
    // An assessment of another version than the adopted one no longer describes the tenant.
    freshness: !assessment ? "unknown" : age > ASSESSMENT_FRESH_DAYS * 86_400_000 || (adoption.adoptedVersionId !== null && assessment.versionId !== adoption.adoptedVersionId) ? "stale" : "fresh",
  }
}

// ---------------------------------------------------------------------------------------------
// Signals

/** Customer deviation, stale or missing assessment, pending upgrades and unfinished adoptions. */
export function standardSignals(deps: FeatureDeps, tenantId: string): WorkSignal[] {
  const tenant = tenantId.toLowerCase()
  const link = "/portal/governance/standards"
  const signals: WorkSignal[] = []
  for (const adoption of listAdoptions(deps, tenant)) {
    const status = adoptionStatus(deps, adoption)
    const evidence = [`${ADOPTIONS}:${adoption.id}`]
    if (status.pendingUpgrade && adoption.adoptedVersion !== null) signals.push({ key: `standard-upgrade:${adoption.id}`, tenantId: tenant, source: "standard", severity: "low", state: "open", title: `${adoption.title}: version ${status.latestVersion} is available`, reason: `Adopted: v${adoption.adoptedVersion}. A new version never changes this tenant by itself; preview the upgrade.`, observedAt: adoption.updatedAt, link, evidence })
    if (status.deviations) signals.push({ key: `standard-deviation:${adoption.id}`, tenantId: tenant, source: "standard", severity: "medium", state: "open", title: `${status.deviations} setting${status.deviations === 1 ? "" : "s"} deviate from ${adoption.title}`, reason: "Live settings differ from the effective customer configuration without an approved exception.", observedAt: status.assessedAt, link, evidence })
    if (adoption.adoptedVersion !== null && status.freshness !== "fresh") signals.push({ key: `standard-assessment:${adoption.id}`, tenantId: tenant, source: "standard", severity: "low", state: "unknown", title: `Deviation from ${adoption.title} is ${status.freshness === "stale" ? "stale" : "not assessed"}`, reason: `Assess the tenant; results older than ${ASSESSMENT_FRESH_DAYS} days are stale.`, observedAt: status.assessedAt, link, evidence })
    if (status.unknownPolicies) signals.push({ key: `standard-unknown:${adoption.id}`, tenantId: tenant, source: "standard", severity: "low", state: "unknown", title: `${status.unknownPolicies} polic${status.unknownPolicies === 1 ? "y" : "ies"} of ${adoption.title} could not be assessed`, reason: "Unmapped, missing or unreadable policies; their deviation is unknown.", observedAt: status.assessedAt, link, evidence })
    if (adoption.status === "partial" || adoption.status === "uncertain" || adoption.status === "failed") signals.push({ key: `standard-adoption-${adoption.status}:${adoption.id}`, tenantId: tenant, source: "standard", severity: adoption.status === "uncertain" ? "high" : "medium", state: adoption.status === "uncertain" ? "unknown" : "open", title: `Adoption of ${adoption.title} is ${adoption.status}`, reason: adoption.summary, observedAt: adoption.updatedAt, link, evidence })
  }
  return signals
}
