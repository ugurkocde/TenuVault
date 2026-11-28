import type { RouteModule } from "../api/host"
import { isGuid } from "../../shared/security"
import type { RecoveryAccounts } from "./safety-resolvers"
import type { GuardedRunJournal } from "./guarded-run"
import { safetyReader } from "./safety-reader"
import type { IdentityRestoreService, RestoreConnection } from "./service"

export function restoreSafetyRoutes(journal: GuardedRunJournal, recovery: RecoveryAccounts, connection: (tenant: string) => Promise<RestoreConnection>, authorize: (tenant: string) => Promise<void>, service: IdentityRestoreService): Record<string, RouteModule> {
  return { "/api/restore-safety": { POST: async request => {
    const body = await request.json().catch(() => null)
    if (!body || !isGuid(body.tenantId)) return Response.json({ error: "Select a tenant for restore safety." }, { status: 400 })
    const tenant = body.tenantId.toLowerCase()
    try {
      await authorize(tenant)
      if (body.action === "save-recovery") {
        const context = await connection(tenant)
        await recovery.save(tenant, body.accountIds, safetyReader(context.token))
      } else if (body.action === "reconcile") {
        if (!isGuid(body.runId)) throw new Error("Select a saved restore run.")
        await service.reconcile(tenant, body.runId)
      } else if (body.action !== "list") return Response.json({ error: "Unknown restore safety action." }, { status: 400 })
      return Response.json({ accountIds: recovery.get(tenant), runs: journal.list(tenant).map(run => ({ id: run.id, origin: run.origin, entries: run.entries.map(entry => ({ key: entry.step.key, folder: entry.step.folder, sourceId: entry.step.sourceId, targetId: entry.targetId, state: entry.state, reason: entry.reason })), replacedReferences: run.replacedReferences, referenceWarning: run.referenceWarning })) })
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Restore safety is unavailable." }, { status: 409 }) }
  } } }
}
