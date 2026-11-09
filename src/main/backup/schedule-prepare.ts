import type { KeyValueStore } from "../storage/secure-store"
import type { BackupSchedule } from "../../shared/ipc"
import { isLocalAccount } from "../storage/blob-emulator"
import type { LicenseService } from "../license/service"
import type { Plan } from "../../shared/plans"

export async function prepareScheduledCoverage(
  schedules: () => BackupSchedule[],
  license: { plan: (tenantId: string) => Plan | null; requireEntitlement: (tenantId: string) => Promise<unknown> },
): Promise<void> {
  for (const schedule of schedules()) {
    if (!schedule.enabled) continue
    const plan = license.plan(schedule.tenantId)
    if (plan === null || (plan === "community" && schedule.frequency === "daily")) {
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
  return { plan: license.plan(tenantId), azure: Boolean(profile && !isLocalAccount(profile.storageAccountName)), endedAt: license.coverageEndedAt(tenantId), pendingChoice: license.communityPendingTenants().includes(tenantId.toLowerCase()) }
}
