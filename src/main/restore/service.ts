import { configurationPayload, isEntraConfiguration, configurationApproval, configurationConfirmation, configurationDifference } from "./entra-configuration"
import { randomUUID } from "node:crypto"
import { INTUNE_TYPES, typeForFolder, restoreCapability } from "../../shared/intune/registry"
import { operationProtections, restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { canBackUp, restorePermissionBlocker } from "../../shared/services/modules"
import { grantedPermissions } from "../../shared/services/token"
import { mappedReference } from "../../shared/intune/restore-references"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { requireRestoreActor } from "./restore-actor"
import { guardedGraphIO } from "./graph-io"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedRun, type GuardedStep } from "./guarded-run"
import { RecoveryAccounts, resolveRestoreActor, resolveSafetyReferences } from "./safety-resolvers"
import { safetyReader } from "./safety-reader"
import { referenceMatches, REFERENCE_SCAN_EXCLUDED } from "./reference-scanner"
import type { IdentityRestoreRequest } from "./dispatch"
import type { RestoreOutcome } from "../../portal/lib/policies/graph-restore"

export interface RestoreConnection { token: string; tenantId: string; clientId: string; userId: string }
export class IdentityRestoreService {
  constructor(private readonly journal: GuardedRunJournal, private readonly recovery: RecoveryAccounts, private readonly connection: (tenant: string) => Promise<RestoreConnection>, private readonly fetchImpl: typeof fetch = fetch) {}
  private async context(tenant: string, readOnly = false, folder?: string, operation: GuardedStep["operation"] = "update") {
    const connection = await this.connection(tenant)
    if (connection.tenantId.toLowerCase() !== tenant.toLowerCase()) throw new RestoreSafetyError("This connection belongs to another tenant.")
    const reader = safetyReader(connection.token, this.fetchImpl)
    // Refuse app-only tokens before even the safety reads.
    requireRestoreActor(connection.token, { ...connection, applicationObjectId: "pending", servicePrincipalId: "pending", recoveryAccountIds: [] })
    const permissionBlocker = !readOnly && folder ? restorePermissionBlocker(folder, grantedPermissions(connection.token)) : undefined
    if (permissionBlocker) throw new RestoreSafetyError(permissionBlocker)
    const protections = folder ? operationProtections(folder, operation) : undefined
    const actor = await resolveRestoreActor(reader, connection, readOnly || protections?.length === 0 ? [] : this.recovery.get(tenant), protections)
    const io = guardedGraphIO(connection.token, actor, (step, current, desired) => resolveSafetyReferences(reader, step, current, desired), this.fetchImpl, (mappings, signal) => {
      const granted = grantedPermissions(connection.token)
      // Reference reporting is advisory. Do not probe unrelated services outside the token's scopes.
      if (!granted || INTUNE_TYPES.some(type => type.restoreSafety !== "identity" && !type.singleton && !type.staticIds && !REFERENCE_SCAN_EXCLUDED.has(type.folder) && !canBackUp(type.folder, granted))) throw new Error("Reference scan read access is unavailable")
      return referenceMatches(connection.token, mappings, this.fetchImpl, { signal })
    })
    return { actor, io }
  }
  /** Called by trusted preview builders only. A renderer never supplies fingerprints or an actor. */
  async prepare(tenant: string, request: IdentityRestoreRequest, operation: GuardedStep["operation"], targetId?: string, allowRemoval = false): Promise<GuardedRun> {
    const folder = request.path.split("/")[1] ?? ""
    const type = typeForFolder(folder)
    if (!type || type.restoreSafety !== "identity" || restoreCapability(type) === "none") throw new RestoreSafetyError("This type remains backup-only.")
    if (operation === "create" && restoreCapability(type) === "singleton") throw new RestoreSafetyError("This setting can only be replaced in place.")
    const contract = restoreMatrixRow(folder)?.[operation]
    if (!contract || (!isEntraConfiguration(folder) && Object.keys(request.snapshot).some(key => ![...contract.properties, "id", "@odata.type"].includes(key)))) throw new RestoreSafetyError("This snapshot needs a reviewed request builder before restoring.")
    const { actor, io } = await this.context(tenant, false, folder, operation)
    // The per-policy branding review explicitly restores only the default username hint.
    // Keep the full backup fingerprint below, while leaving every other branding field alone.
    const candidate = folder === "EntraCompanyBranding" ? Object.fromEntries(contract.properties.filter(key => key in request.snapshot).map(key => [key, request.snapshot[key]!])) : request.snapshot
    const step: GuardedStep = { key: "configuration", folder, sourceId: String(request.snapshot.id ?? ""), operation, targetId, allowRemoval, properties: contract.properties, desired: isEntraConfiguration(folder) ? configurationPayload(folder, operation, candidate) : Object.fromEntries(contract.properties.filter(key => key in request.snapshot).map(key => [key, request.snapshot[key]!])), preview: "", requires: [] }
    if (operation === "create" && isEntraConfiguration(folder) && await io.read({ ...step, targetId: step.sourceId }, step.sourceId)) throw new RestoreSafetyError("The original policy still exists. Choose replacement and review its current values instead of recreating it.")
    const mappings = this.journal.mappings(tenant)
    step.targetId = mappedReference(mappings, "objectId", folder, step.sourceId) ?? targetId ?? (operation === "update" ? step.sourceId : undefined)
    step.preview = restoreFingerprint(await io.read(step, step.targetId))
    const run: GuardedRun = { version: 1, id: randomUUID(), tenant, actor, origin: request.origin, source: { path: request.path, fingerprint: restoreFingerprint(request.snapshot) }, entries: [{ step, state: "pending" }], mappings }
    this.journal.save(run)
    return run
  }
  /** Trusted per-item flow only. No bulk restore caller can supply an approval. */
  async review(tenant: string, id: string) {
    const run = this.journal.load(tenant, id)
    if (!run || run.entries.length !== 1) throw new RestoreSafetyError("This restore preview is unavailable.")
    const step = run.entries[0]!.step
    const { io } = await this.context(tenant, false, step.folder, step.operation)
    const current = await io.read(step, step.targetId)
    if (restoreFingerprint(current) !== step.preview) throw new RestoreSafetyError("The tenant changed after this preview. Preview this item again.")
    return { kind: configurationConfirmation(step.folder), fingerprint: configurationApproval(step, run), changes: configurationDifference(step, current) }
  }
  async confirm(tenant: string, id: string, fingerprint: string): Promise<void> {
    const review = await this.review(tenant, id)
    const run = this.journal.load(tenant, id)!
    if (review.fingerprint !== fingerprint || run.entries[0]!.state !== "pending") throw new RestoreSafetyError("This confirmation no longer matches the pending preview.")
    run.entries[0]!.step.confirmation = { kind: review.kind, fingerprint }
    this.journal.save(run)
  }
  async restore(tenant: string, request: IdentityRestoreRequest): Promise<RestoreOutcome> {
    const folder = request.path.split("/")[1] ?? ""
    const type = typeForFolder(folder)
    if (!type || type.restoreSafety !== "identity" || restoreCapability(type) === "none") return { success: false, path: request.path, action: "skipped", retryable: false, error: "This type remains backup-only." }
    const run = request.runId ? this.journal.load(tenant, request.runId) : undefined
    if (!run || run.source?.path !== request.path || (request.origin !== "repair" && run.source.fingerprint !== restoreFingerprint(request.snapshot)) || (request.origin !== "repair" && run.origin !== request.origin) || run.entries.length !== 1 || run.entries[0]!.step.folder !== folder || (request.origin !== "repair" && run.entries[0]!.step.sourceId !== request.snapshot.id)) return { success: false, path: request.path, retryable: false, error: "Preview this identity restore before continuing." }
    const { actor, io } = await this.context(tenant, false, folder, run.entries[0]!.step.operation)
    const result = await executeGuardedRun(this.journal, { ...run, actor }, io)
    const entry = result.run.entries[0]!
    return { success: result.status === "complete", path: request.path, policyId: entry.targetId, partial: result.status === "partial", retryable: false, error: entry.reason, guardedRunId: run.id, replacedReferences: result.run.replacedReferences, warnings: result.run.referenceWarning ? [result.run.referenceWarning] : [] }
  }
  /** Read-back only: history cannot resend a write, reset a step or mark it absent. */
  async reconcile(tenant: string, id: string): Promise<void> {
    const run = this.journal.load(tenant, id)
    if (!run) throw new RestoreSafetyError("This restore is unavailable.")
    const { actor, io } = await this.context(tenant, true, run.entries[0]?.step.folder, run.entries[0]?.step.operation)
    const readOnly = { ...io, write: async () => { throw new RestoreSafetyError("Resume pending steps from the reviewed restore flow.") } }
    // The runner's reconcile-only mode skips every step that has not already been sent.
    await executeGuardedRun(this.journal, { ...run, actor }, readOnly, undefined, true)
  }
}
