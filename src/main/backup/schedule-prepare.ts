import type { KeyValueStore } from "../storage/secure-store"
import type { BackupScheduler } from "./scheduler"
import { isLocalAccount } from "../storage/blob-emulator"
import type { LicenseService } from "../license/service"
import type { Plan } from "../../shared/plans"

const RECHECK_MS = 6 * 60 * 60_000

export function prepareScheduledCoverage(
  license: { plan: (tenantId: string) => Plan | null; requireEntitlement: (tenantId: string) => Promise<unknown> },
  now: () => number = Date.now,
): (scheduler: Pick<BackupScheduler, "list" | "isDue">) => Promise<void> {
  const checked = new Map<string, number>()
  return async (scheduler) => {
    for (const schedule of scheduler.list()) {
      if (!schedule.enabled) continue
      const plan = license.plan(schedule.tenantId)
      if (plan === null) {
        const previous = checked.get(schedule.tenantId)
        if (previous === undefined ? !scheduler.isDue({ ...schedule, pausedReason: undefined }) : now() - previous < RECHECK_MS) continue
        checked.set(schedule.tenantId, now())
      } else {
        checked.delete(schedule.tenantId)
        if (plan !== "community" || schedule.frequency !== "daily") continue
      }
      await license.requireEntitlement(schedule.tenantId).catch(() => undefined)
    }
  }
}

export function announceCommunityChoice(store: KeyValueStore, pending: boolean, notify: () => void): void {
  const key = "license.communityChoiceNotified"
  if (!pending) {
    if (store.get(key)) store.delete(key)
  } else if (!store.get(key)) {
    store.set(key, "true")
    notify()
  }
}

export function scheduledCoverage(license: Pick<LicenseService, "plan" | "coverageEndedAt" | "communityPendingTenants">, tenantId: string, profile: { storageAccountName: string } | null) {
  if (!profile) return undefined
  return { plan: license.plan(tenantId), azure: !isLocalAccount(profile.storageAccountName), endedAt: license.coverageEndedAt(tenantId), pendingChoice: license.communityPendingTenants().includes(tenantId.toLowerCase()) }
}
