import { CommunityChoicePendingError } from "../../shared/plan-errors"
import type { BackupRefusal } from "../../shared/ipc"
import type { KeyValueStore } from "../storage/secure-store"

const KEY = "backup.refusals"
/** The log keeps the most recent refusals across all tenants. */
export const MAX_REFUSALS = 200
const MAX_TEXT = 500

/**
 * Backups TenuVault refused to run because the license did not cover the tenant.
 *
 * A tenant's audit log lives in the tenant's own backup storage, which is closed without
 * a license too, so refusals are kept here, in the app's encrypted store on this device.
 * They are not copied to the tenant's audit log later: its entries are timestamped when
 * they are written, so a late copy would show the refusal at the wrong time.
 */
export class RefusalLog {
  constructor(
    private readonly store: KeyValueStore,
    private readonly onChange: () => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(entry: Omit<BackupRefusal, "at">): BackupRefusal {
    const refusal: BackupRefusal = {
      at: this.now().toISOString(),
      tenantId: entry.tenantId.toLowerCase(),
      tenantName: entry.tenantName.slice(0, MAX_TEXT),
      trigger: entry.trigger,
      reason: entry.reason.slice(0, MAX_TEXT),
    }
    this.store.set(KEY, JSON.stringify([refusal, ...this.read()].slice(0, MAX_REFUSALS)))
    this.onChange()
    return refusal
  }

  /** Newest first, for one tenant or for all. */
  list(tenantId?: string): BackupRefusal[] {
    const all = this.read()
    return tenantId ? all.filter((entry) => entry.tenantId === tenantId.toLowerCase()) : all
  }

  private read(): BackupRefusal[] {
    try {
      const parsed: unknown = JSON.parse(this.store.get(KEY) ?? "[]")
      return Array.isArray(parsed)
        ? (parsed as BackupRefusal[]).filter(
            (entry) => typeof entry?.at === "string" && typeof entry.tenantId === "string" && typeof entry.reason === "string",
          )
        : []
    } catch {
      return []
    }
  }
}

export interface BackupGuard {
  requireEntitlement: (tenantId: string) => Promise<unknown>
  log: RefusalLog
  notify: (tenantName: string, message: string) => void
}

/**
 * Checks the tenant's license before an unattended backup. Returns null when the backup
 * may run; otherwise records the refusal, notifies the admin and returns the message
 * for the schedule status.
 */
export async function refuseUnlicensedBackup(
  guard: BackupGuard,
  tenant: { tenantId: string; name: string },
  trigger: BackupRefusal["trigger"],
): Promise<string | null> {
  try {
    await guard.requireEntitlement(tenant.tenantId)
    return null
  } catch (error) {
    if (error instanceof CommunityChoicePendingError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    guard.log.record({ tenantId: tenant.tenantId, tenantName: tenant.name, trigger, reason })
    const message = `Not backed up: ${reason}`
    guard.notify(tenant.name, message)
    return message
  }
}
