import { evaluateHealth } from "../../src/shared/connection-health/evaluate"
import type { ConnectionHealthReport, HealthCause, ReaderHealthState, SignInHealthState } from "../../src/shared/connection-health/model"
import { SIGN_IN_ERRORS, signInErrorLink } from "../../src/shared/sign-in-errors"
import { MODULES } from "../../src/shared/services/modules"
import { knownPermissions } from "../../src/shared/services/manifest"
import type { BackupJobDisplay } from "../../src/portal/lib/backup-job-display"

export const HEALTH_TENANT = "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14"
export const HEALTH_CLIENT = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
const AT = "2026-11-15T10:00:00.000Z"
const permissions = [...knownPermissions("delegated")[0]!.permissions]

export function healthFixture(): ConnectionHealthReport {
  const report = evaluateHealth({
    tenantId: HEALTH_TENANT, clientId: HEALTH_CLIENT, reader: null, storage: "local",
    settings: Object.fromEntries(MODULES.map(module => [module.id, { enabled: module.id === "intune" || module.id === "conditionalAccess", access: module.defaultAccess, areas: {} }])) as Parameters<typeof evaluateHealth>[0]["settings"],
    connections: [{ clientId: HEALTH_CLIENT, mode: "delegated", account: "fixture-account", graph: { at: AT, permissions }, runs: [], verified: {}, refused: {}, updatedAt: AT }],
  }, new Date(AT)).report
  report.acknowledgement = "fixture-receipt"
  report.reader = { state: "healthy", checkedAt: AT }
  for (const service of report.services) {
    if (service.enabled && service.hasTypes) {
      service.verified = { state: "verified", at: AT, mode: "delegated", notVerified: [] }
      service.areas.forEach(area => { area.verified = { ...service.verified } })
    }
  }
  return report
}

/** Real evaluator output: backups can read with Read.All while requested restore access lacks Write. */
export function restoreGapFixture(): ConnectionHealthReport {
  return evaluateHealth({
    tenantId: HEALTH_TENANT, clientId: HEALTH_CLIENT, reader: null, storage: "local",
    settings: Object.fromEntries(MODULES.map(module => [module.id, { enabled: module.id === "intune", access: module.defaultAccess, areas: {} }])) as Parameters<typeof evaluateHealth>[0]["settings"],
    connections: [{ clientId: HEALTH_CLIENT, mode: "delegated", account: "fixture-account", graph: { at: AT, permissions: permissions.filter(name => name !== "DeviceManagementConfiguration.ReadWrite.All") }, runs: [], verified: {}, refused: {}, updatedAt: AT }],
  }, new Date(AT)).report
}

export function healthScene(name: string): ConnectionHealthReport {
  const report = name === "restore-only-gap" ? restoreGapFixture() : healthFixture()
  const intune = report.services.find(service => service.id === "intune")!
  const area = intune.areas[0]!
  const missing = "DeviceManagementConfiguration.ReadWrite.All"
  if (name === "missing-permission" || name === "registration-replaced") {
    report.granted = report.granted!.filter(permission => permission !== missing && permission !== "DeviceManagementConfiguration.Read.All")
    intune.missing = [missing]; intune.permissions = "missing"
    area.missing = [missing]; area.permissions = "missing"; area.restore = "missing"
    area.verified = { state: "notVerified", cause: "permission", mode: "delegated", at: AT, notVerified: ["ConfigurationPolicies"] }
    intune.verified = { ...area.verified }
  }
  if (name === "registration-replaced") report.changes = [{ kind: "registrationReplaced", previousClientId: "11111111-1111-4111-8111-111111111111", lacks: [missing] }]
  if (name === "reader-expiring" || name === "reader-expired") report.reader = { state: name === "reader-expiring" ? "certificateExpiring" : "certificateExpired", notAfter: name === "reader-expiring" ? "2026-11-25T10:00:00Z" : "2026-11-14T10:00:00Z", daysLeft: name === "reader-expiring" ? 10 : -1, checkedAt: AT }
  if (name === "reader-lost-access") {
    area.losses = [{ mode: "app-only", cause: "permission", since: "2026-11-13T10:00:00Z", folder: "ConfigurationPolicies" }]
    area.lostAccess = true
  }
  if (name.startsWith("cause-")) {
    area.verified = { state: "notVerified", cause: name.slice(6) as HealthCause, at: AT, mode: name === "cause-reader" || name === "cause-signedIn" ? "app-only" : "delegated", notVerified: ["ConfigurationPolicies"] }
    intune.verified = { ...area.verified }
  }
  if (name === "partly-verified") {
    area.verified = { state: "notVerified", cause: "notRead", at: AT, mode: "delegated", notVerified: ["ConfigurationPolicies"] }
    intune.verified = { ...area.verified, state: "partly" }
  }
  if (name === "changes") {
    report.since = "2026-11-12T10:00:00Z"
    report.changes = [{ kind: "permissionsAdded", permissions: ["Policy.Read.All"] }, { kind: "permissionsRemoved", permissions: ["Group.Read.All"], earlierSignIn: true, foundAt: "2026-11-13T10:00:00Z" }]
  }
  if (name === "personal-data" || name === "entra-backup-types") {
    const entra = report.services.find(service => service.id === "entra")!
    entra.enabled = true
    entra.areas.forEach(area => { area.enabled = !area.optIn })
  }
  if (name === "intune-off") { intune.enabled = false; intune.areas.forEach(area => { area.enabled = false }) }
  if (name.startsWith("graph-")) report.graph = { state: name.slice(6) as SignInHealthState, checkedAt: AT }
  if (name.startsWith("storage-")) report.storage = { state: name.slice(8) as SignInHealthState, checkedAt: AT }
  if (name.startsWith("reader-" ) && !["reader-lost-access", "reader-expiring", "reader-expired"].includes(name)) report.reader = { state: name.slice(7) as ReaderHealthState, checkedAt: AT }
  if (report.graph.state !== "healthy") {
    report.granted = null
    for (const service of report.services) {
      service.permissions = "unknown"; service.missing = []
      service.areas.forEach(area => { area.permissions = "unknown"; area.restore = "unknown"; area.missing = [] })
    }
  }
  for (const state of [report.graph, report.storage]) {
    const code = SIGN_IN_ERRORS.find(row => row.state === state.state)?.code ?? (state.state === "unknown" ? "AADSTS9999999" : undefined)
    if (code) { state.code = code; state.link = signInErrorLink(code) }
  }
  if (report.reader.state === "rolesChanged") report.reader.roleChange = { added: ["Policy.Read.All"], removed: ["DeviceManagementConfiguration.Read.All"], at: AT }
  if (report.reader.state === "refused") { report.reader.code = "AADSTS700027"; report.reader.link = signInErrorLink(report.reader.code) }
  return report
}

export const incompleteBackupFixture: BackupJobDisplay = {
  status: "Completed", progress: 100, progressMessage: "Backup completed with incomplete coverage", isComplete: true, isSuccessful: true,
  startTime: "2026-11-15T09:58:00Z", endTime: AT,
  results: { types: [
    { folder: "ConfigurationPolicies", label: "Settings catalog policies", area: "Configuration", state: "saved", found: 24, saved: 24, failed: 0 },
    { folder: "CompliancePolicies", label: "Compliance policies", area: "Compliance", state: "saved", found: 12, saved: 12, failed: 0 },
    { folder: "AuthenticationMethods", label: "Authentication methods", area: "Authentication", state: "skipped", saved: 0, failed: 0, reason: "Microsoft refused the read although the permission is present. Check the admin role and license, then run a backup again." },
    { folder: "SecureScoreControlProfiles", label: "Secure Score control profiles", area: "Posture", state: "skipped", saved: 0, failed: 0, reason: "Microsoft reported that this service is not onboarded in this tenant." },
  ], notices: [], coverage: "incomplete", totalPolicies: 36 },
}
