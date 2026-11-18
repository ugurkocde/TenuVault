import { randomUUID } from "node:crypto"
import { typeForFolder, restoreCapability } from "../../shared/intune/registry"
import { restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { requireRestoreActor } from "./restore-actor"
import { guardedGraphIO } from "./graph-io"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedRun, type GuardedStep } from "./guarded-run"
import { RecoveryAccounts, resolveRestoreActor, resolveSafetyReferences } from "./safety-resolvers"
import { safetyReader } from "./safety-reader"
import { referenceSnapshots } from "./reference-scanner"
import type { IdentityRestoreRequest } from "./dispatch"
import type { RestoreOutcome } from "../../portal/lib/policies/graph-restore"

export interface RestoreConnection { token: string; tenantId: string; clientId: string; userId: string }
export class IdentityRestoreService {
  constructor(private readonly journal: GuardedRunJournal, private readonly recovery: RecoveryAccounts, private readonly connection: (tenant: string) => Promise<RestoreConnection>, private readonly fetchImpl: typeof fetch = fetch) {}
  private async context(tenant: string) {
    const connection = await this.connection(tenant)
    if (connection.tenantId.toLowerCase() !== tenant.toLowerCase()) throw new RestoreSafetyError("This connection belongs to another tenant.")
    const reader = safetyReader(connection.token, this.fetchImpl)
    // Refuse app-only tokens before even the safety reads.
    requireRestoreActor(connection.token, { ...connection, applicationObjectId: "pending", servicePrincipalId: "pending", recoveryAccountIds: [] })
    const actor = await resolveRestoreActor(reader, connection, this.recovery.get(tenant))
    const io = guardedGraphIO(connection.token, actor, (step, current, desired) => resolveSafetyReferences(reader, step, current, desired), this.fetchImpl, () => referenceSnapshots(connection.token, this.fetchImpl))
    return { actor, io }
  }
  /** Called by trusted preview builders only. A renderer never supplies fingerprints or an actor. */
  async prepare(tenant: string, request: IdentityRestoreRequest, operation: GuardedStep["operation"], targetId?: string): Promise<GuardedRun> {
    const folder = request.path.split("/")[1] ?? ""
    const type = typeForFolder(folder)
    if (!type || type.restoreSafety !== "identity" || restoreCapability(type) === "none") throw new RestoreSafetyError("This type remains backup-only.")
    const contract = restoreMatrixRow(folder)?.[operation]
    if (!contract || Object.keys(request.snapshot).some(key => ![...contract.properties, "id", "@odata.type"].includes(key))) throw new RestoreSafetyError("This snapshot needs a reviewed request builder before restoring.")
    const { actor, io } = await this.context(tenant)
    const step: GuardedStep = { key: "configuration", folder, sourceId: String(request.snapshot.id ?? ""), operation, targetId, properties: contract.properties, desired: Object.fromEntries(contract.properties.filter(key => key in request.snapshot).map(key => [key, request.snapshot[key]!])), preview: "", requires: [] }
    step.preview = restoreFingerprint(await io.read(step, targetId))
    const run: GuardedRun = { version: 1, id: randomUUID(), tenant, actor, origin: request.origin, source: { path: request.path, fingerprint: restoreFingerprint(request.snapshot) }, entries: [{ step, state: "pending" }], mappings: [] }
    this.journal.save(run)
    return run
  }
  async restore(tenant: string, request: IdentityRestoreRequest): Promise<RestoreOutcome> {
    const folder = request.path.split("/")[1] ?? ""
    const type = typeForFolder(folder)
    if (!type || type.restoreSafety !== "identity" || restoreCapability(type) === "none") return { success: false, path: request.path, action: "skipped", retryable: false, error: "This type remains backup-only." }
    const run = request.runId ? this.journal.load(tenant, request.runId) : undefined
    if (!run || run.source?.path !== request.path || (request.origin !== "repair" && run.source.fingerprint !== restoreFingerprint(request.snapshot)) || (request.origin !== "repair" && run.origin !== request.origin) || run.entries.length !== 1 || run.entries[0]!.step.folder !== folder || (request.origin !== "repair" && run.entries[0]!.step.sourceId !== request.snapshot.id)) return { success: false, path: request.path, retryable: false, error: "Preview this identity restore before continuing." }
    const { actor, io } = await this.context(tenant)
    const result = await executeGuardedRun(this.journal, { ...run, actor }, io)
    const entry = result.run.entries[0]!
    return { success: result.status === "complete", path: request.path, policyId: entry.targetId, partial: result.status === "partial", retryable: false, error: entry.reason, guardedRunId: run.id, replacedReferences: result.run.replacedReferences, warnings: result.run.referenceWarning ? [result.run.referenceWarning] : [] }
  }
  /** Read-back only: history cannot resend a write, reset a step or mark it absent. */
  async reconcile(tenant: string, id: string): Promise<void> {
    const run = this.journal.load(tenant, id)
    if (!run) throw new RestoreSafetyError("This restore is unavailable.")
    const { actor, io } = await this.context(tenant)
    const readOnly = { ...io, write: async () => { throw new RestoreSafetyError("Resume pending steps from the reviewed restore flow.") } }
    // The runner's reconcile-only mode skips every step that has not already been sent.
    await executeGuardedRun(this.journal, { ...run, actor }, readOnly, undefined, true)
  }
}
