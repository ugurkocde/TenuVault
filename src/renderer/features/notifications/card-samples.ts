import { changeEvent, entraChangeDigest, intuneChangeDigest, type AuditChange } from "../../../shared/notifications/audit"
import { backupEvent, credentialExpiringEvent, driftEvent, lateBackupEvent, restoreEvent, testEvent, watcherStaleEvent, type NotificationEnvelope } from "../../../shared/notifications/envelope"
import { groupOf, type EventGroup } from "../../../shared/notifications/layout"

/**
 * Sample events for the card preview, built with the real envelope builders. All names are
 * fictional (Contoso), so the editor never shows the tenant's own policies and screenshots
 * of it are safe to share.
 */

const TENANT = "00000000-0000-4000-8000-000000000001"
const NAME = "Contoso"
const AT = "2026-11-05T08:42:00.000Z"

function change(index: number, partial: Partial<AuditChange> & Pick<AuditChange, "changeType" | "resourceName" | "resourceType">): AuditChange {
  return {
    auditId: `sample-${index}`,
    at: new Date(Date.parse(AT) - (20 - index) * 60_000).toISOString(),
    category: "DeviceConfiguration",
    actorUpn: "megan.bowen@contoso.com",
    actorAppId: null,
    actorAppName: null,
    activity: "Patch DeviceConfiguration",
    ...partial,
  }
}

const intuneChanges: AuditChange[] = [
  change(1, { changeType: "updated", resourceName: "Windows - Compliance", resourceType: "Windows10CompliancePolicy", category: "Compliance", settings: ["BitLockerEnabled", "OsMinimumVersion"] }),
  change(2, { changeType: "updated", resourceName: "Windows - Compliance", resourceType: "Windows10CompliancePolicy", category: "Compliance", settings: ["PasswordRequired"] }),
  change(3, { changeType: "assigned", resourceName: "Windows - Defender Antivirus", resourceType: "Endpoint security" }),
  change(4, { changeType: "deleted", resourceName: "Legacy - Wi-Fi Corp", resourceType: "Device configuration", actorUpn: "alex.wilber@contoso.com" }),
  change(5, { changeType: "created", resourceName: "macOS - FileVault", resourceType: "Settings catalog" }),
  ...Array.from({ length: 7 }, (_, offset) => change(6 + offset, { changeType: "updated", resourceName: `iOS - App protection ${offset + 1}`, resourceType: "App protection" })),
]

const entraChanges: AuditChange[] = [
  change(1, { category: "ConditionalAccess", changeType: "updated", resourceName: "Require MFA for admins", resourceType: "Conditional Access policy", activity: "Update conditional access policy", settings: ["conditions.users.excludeGroups", "state"] }),
  change(2, { category: "ConditionalAccess", changeType: "created", resourceName: "Head office", resourceType: "Named location", activity: "Add named location" }),
  change(3, { category: "ConditionalAccess", changeType: "deleted", resourceName: "Block legacy authentication", resourceType: "Conditional Access policy", activity: "Delete conditional access policy" }),
]

export interface CardSample {
  id: string
  label: string
  envelope: NotificationEnvelope
}

export const CARD_SAMPLES: CardSample[] = [
  { id: "intune", label: "Intune changes (12 changes)", envelope: intuneChangeDigest({ tenantId: TENANT, tenantName: NAME, changes: intuneChanges, includeActor: true, source: "desktop" }) },
  { id: "intune-each", label: "Intune change (one alert per change)", envelope: changeEvent("intune", { tenantId: TENANT, tenantName: NAME, change: intuneChanges[0]!, includeActor: true, source: "desktop" }) },
  { id: "entra", label: "Conditional Access changes", envelope: entraChangeDigest({ tenantId: TENANT, tenantName: NAME, changes: entraChanges, includeActor: true, source: "desktop" }) },
  { id: "backup-failed", label: "Backup failed", envelope: backupEvent({ tenantId: TENANT, tenantName: NAME, status: "Failed", backupFolder: "backup-2026-11-05-020000", occurredAt: AT, totalPolicies: 0, failures: 4, failedTypes: ["Apps", "Remediations"], trigger: "scheduled", message: null, source: "desktop" }) },
  { id: "backup-warning", label: "Backup with warnings", envelope: backupEvent({ tenantId: TENANT, tenantName: NAME, status: "CompletedWithWarnings", backupFolder: "backup-2026-11-05-020000", occurredAt: AT, totalPolicies: 412, failures: 2, failedTypes: ["Apps"], trigger: "scheduled", message: null, source: "desktop" }) },
  { id: "backup-missed", label: "Backup missed its time", envelope: lateBackupEvent({ tenantId: TENANT, tenantName: NAME, occurredAt: AT, slot: "2026-11-05T02:00:00.000Z", source: "desktop" }) },
  { id: "restore", label: "Restore partially completed", envelope: restoreEvent({ tenantId: TENANT, tenantName: NAME, status: "PartiallyCompleted", jobId: "sample-restore", occurredAt: AT, restored: 18, failed: 1, partial: 2, message: null, source: "desktop" }) },
  { id: "drift", label: "Drift detected", envelope: driftEvent({ tenantId: TENANT, tenantName: NAME, occurredAt: AT, jobId: "sample-drift", added: 2, modified: 5, deleted: 1, items: [{ title: "modified: Windows - BitLocker", detail: "ConfigurationPolicies" }, { title: "deleted: Legacy - Wi-Fi Corp", detail: "DeviceConfigurations" }, { title: "added: macOS - FileVault", detail: "ConfigurationPolicies" }], source: "desktop" }) },
  { id: "certificate", label: "Certificate expiring", envelope: credentialExpiringEvent({ tenantId: TENANT, tenantName: NAME, occurredAt: AT, notAfter: "2026-11-12T00:00:00.000Z", daysLeft: 7, renewalPending: false, source: "desktop" })! },
  { id: "watcher", label: "Watcher stale", envelope: watcherStaleEvent({ tenantId: TENANT, tenantName: NAME, occurredAt: AT, lastRunAt: "2026-11-05T03:00:00.000Z", thresholdHours: 3, source: "desktop" }) },
  { id: "test", label: "Test notification", envelope: testEvent({ tenantId: TENANT, tenantName: NAME, occurredAt: AT, channelTitle: "IT Ops alerts", source: "desktop" }) },
]

/** The samples a tab previews: its own event types, or all of them for the default layout. */
export function samplesFor(group: EventGroup | "base"): CardSample[] {
  if (group === "base") return CARD_SAMPLES
  return CARD_SAMPLES.filter((sample) => groupOf(sample.envelope.type) === group)
}

/** Detail row labels the samples of a tab carry, for the "hide rows" choices. */
export function detailLabelsFor(group: EventGroup | "base"): string[] {
  return [...new Set(samplesFor(group).flatMap((sample) => sample.envelope.details.map((entry) => entry.label)))]
}
