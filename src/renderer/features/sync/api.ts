import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"
import type { SyncRunRecord, SyncSkip } from "../../../main/features/sync/engine"
import type { SyncStatus, SyncStatusEntry } from "../../../main/features/sync/status"
import type { PromotionPreview } from "../../../main/features/promotion/engine"
import type { Promotion, PolicyOption } from "../promotion/api"
import type { ChangeSet, ChangeSetActions, ChangeSetPreview, RollbackPreview } from "../shared/change-set"
import type { RunOutcome } from "./model"

export type { PolicyOption, Promotion, SyncStatusEntry }

/**
 * Calls of /api/sync. Run-level calls (policies, targets, status, plan, list-runs, get-run) go
 * to the source tenant; the calls of one target (preview, approve, apply, retry, rollback) go to
 * that target tenant with the ID of its Sync target record.
 */

export type SyncRun = SyncRunRecord & { id: string; createdAt: string; updatedAt: string }
/** One target of a run with its stored records; promotion and change set are null when it could not be planned. */
export type SyncTarget = SyncRunRecord["targets"][number] & { promotion: Promotion | null; changeSet: ChangeSet | null; rollbackChangeSet: ChangeSet | null }
export type SyncBackup = "new" | "none"
export interface SyncTargetOption { tenantId: string; eligible: boolean; multiple: boolean; reason: "msp" | "plan" | "unavailable" | null }
export type SyncPreview = Omit<PromotionPreview, "promotion"> & { promotion: Promotion }

/** The four policy types Sync writes, by the folder the engine uses. */
export const SYNC_TYPES = [
  { folder: "ConfigurationPolicies", label: "Settings Catalog" },
  { folder: "CompliancePolicies", label: "Compliance" },
  { folder: "EndpointSecurityIntents", label: "Endpoint security" },
  { folder: "DeviceConfigurations", label: "Device configuration" },
] as const

export const MAX_SYNC_POLICIES = 25

const PATH = "/api/sync"
const named = (tenantIds: string[]) => tenantIds.map((tenantId) => ({ tenantId }))

/**
 * Runs from the source tenant, newest first, without discarded ones; `applied` tells whether any
 * target was ever applied, `outcome` what the run did.
 */
export const listSyncRuns = (source: Tenant) => featureCall<{ runs: Array<SyncRun & { applied?: boolean; inSync?: boolean; outcome?: RunOutcome }> }>(PATH, source, "list-runs")
/** Discards a run none of whose targets was approved; the record is kept and leaves Recent syncs. */
export const discardSyncRun = (source: Tenant, id: string) => featureCall<{ run: SyncRun }>(PATH, source, "discard-run", { id })
export const getSyncRun = (source: Tenant, id: string) => featureCall<{ run: SyncRun; targets: SyncTarget[] }>(PATH, source, "get-run", { id })
export const syncPolicies = (source: Tenant, folder: string) => featureCall<{ source: PolicyOption[] }>(PATH, source, "policies", { folder })
export const syncTargets = (source: Tenant) => featureCall<{ multiple: boolean; targets: SyncTargetOption[] }>(PATH, source, "targets")
export const syncStatus = (source: Tenant, targetTenantIds: string[]) => featureCall<SyncStatus>(PATH, source, "status", { targetTenants: named(targetTenantIds) })

export const planSync = (source: Tenant, input: { title: string; targets: string[]; items: Array<{ folder: string; sourceId: string }>; acknowledgeRedacted: boolean }) =>
  featureCall<{ run: SyncRun; targets: Array<{ targetTenantId: string; promotion: Promotion | null; error: string | null; skipped: SyncSkip[] }> }>(PATH, source, "plan", {
    title: input.title,
    targetTenants: named(input.targets),
    items: input.items,
    // Assignments are never synced: policies are created unassigned and existing assignments stay.
    includeAssignments: false,
    acknowledgeRedacted: input.acknowledgeRedacted,
  })

export const previewSyncTarget = (target: Tenant, id: string) => featureCall<SyncPreview>(PATH, target, "preview", { id })
/**
 * Sync records no reviewer or note; the route stores null for both. The approval names the backup
 * choice, which the route stores on the target, so its apply and every retry use it.
 */
export const approveSyncTarget = (target: Tenant, id: string, preview: Pick<ChangeSetPreview, "contentHash" | "targetFingerprint">, backup: SyncBackup) =>
  featureCall(PATH, target, "approve", { id, contentHash: preview.contentHash, targetFingerprint: preview.targetFingerprint, backup })
export const applySyncTarget = (target: Tenant, id: string, contentHash: string, backup: SyncBackup) => featureCall(PATH, target, "apply", { id, contentHash, confirm: true, backup })
/** A retry names no backup choice: the route applies the one the target was approved with. */
export const retrySyncTarget = (target: Tenant, id: string, contentHash: string) => featureCall(PATH, target, "retry", { id, contentHash, confirm: true })

/**
 * Change-set calls of one Sync target, for its details: results, apply and rollback. Apply and
 * retry name no backup choice, so the route applies the approved one; an approval from here names
 * `backup`, the target's stored choice.
 */
export function syncTargetActions(target: Tenant, id: string, backup: SyncBackup): ChangeSetActions {
  const base = { id }
  return {
    preview: async () => (await featureCall<SyncPreview>(PATH, target, "preview", base)).changeSet,
    approve: (input) => featureCall(PATH, target, "approve", { ...base, contentHash: input.contentHash, targetFingerprint: input.targetFingerprint, backup }),
    reject: () => featureCall(PATH, target, "reject", base),
    apply: (contentHash) => featureCall(PATH, target, "apply", { ...base, contentHash, confirm: true }),
    retry: (contentHash) => featureCall(PATH, target, "retry", { ...base, contentHash, confirm: true }),
    rollbackPreview: () => featureCall<RollbackPreview>(PATH, target, "rollback-preview", base),
    rollbackCreate: () => featureCall<{ changeSet: ChangeSet }>(PATH, target, "rollback-create", base),
  }
}

/** Review and apply calls of a Sync target's rollback. A rollback always backs up first. */
export function syncRollbackActions(target: Tenant, id: string): ChangeSetActions {
  const base = { id }
  const none = () => Promise.reject(new Error("A rollback is itself undone by a new reviewed sync, not by a rollback of a rollback."))
  return {
    preview: () => featureCall<ChangeSetPreview>(PATH, target, "rollback-review", base),
    approve: (input) => featureCall(PATH, target, "rollback-approve", { ...base, contentHash: input.contentHash, targetFingerprint: input.targetFingerprint }),
    reject: () => featureCall(PATH, target, "rollback-reject", base),
    apply: (contentHash) => featureCall(PATH, target, "rollback-apply", { ...base, contentHash, confirm: true }),
    retry: (contentHash) => featureCall(PATH, target, "rollback-apply", { ...base, contentHash, confirm: true }),
    rollbackPreview: none,
    rollbackCreate: none,
  }
}
