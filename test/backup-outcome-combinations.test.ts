vi.hoisted(() => vi.stubGlobal("__TV_LAB_EXPANDED_ENTRA__", true))

import JSZip from "jszip"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { importArchive, reviewArchive } from "../src/main/backup/archive"
import type { BackupEngineDeps, BackupJob, BackupRequest } from "../src/main/backup/engine"
import { notifiedStatus, scheduledResult } from "../src/main/backup/scheduler"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { manifestCoverage, type RunOutcomes } from "../src/shared/backup-outcomes"
import { BACKUP_OWNER_FILE } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { coveredFolders } from "../src/shared/intune/scope"
import { moduleForFolder, type ModuleId } from "../src/shared/services/modules"
import { fixture, jwt, refusal, registerTestTypes, scriptedGraph, TENANT, testType, type Fixture, type GraphRoute } from "./helpers/backup-fixture"
import { reviewAsRelease05, RELEASE_FOLDERS } from "./fixtures/release-0.5-import"

/**
 * Every way the types of a backup can end, against what reads a backup's result: the manifest
 * status, retention, the scheduler, notifications and import (into this version and into release
 * 0.5.x). Coverage is recorded next to the status and changes none of the others, with one
 * exception: a backup in which every selected type was left out read nothing, and that is a failure.
 */

const NOW = new Date("2026-11-10T02:00:00Z")
/**
 * A backup of the tenant past the retention period that holds every type of the services the row
 * backs up. Retention removes it only when the new backup holds them too.
 */
const OLD = "backup-2026-09-01-020000"

const TYPES = [
  testType("TokenLifetimePolicies", "policies/tokenLifetimePolicies", { listOnly: true }),
  testType("FederatedTokenValidationPolicy", "policies/federatedTokenValidationPolicy", { singleton: { id: "federatedTokenValidationPolicy", name: "Federated token validation policy" }, notConfigured: [{ status: 404, code: "Request_ResourceNotFound" }] }),
  testType("MdmEnrollmentPolicies", "policies/mobileDeviceManagementPolicies", { listOnly: true }),
  testType("TermsOfUseAgreements", "identityGovernance/termsOfUse/agreements", { listOnly: true }),
]

const termsOnly = { excluded: TYPES.filter(type => type.folder !== "TermsOfUseAgreements").map(type => type.folder) }

let unregister: () => void
beforeAll(() => {
  unregister = registerTestTypes(TYPES)
})
afterAll(() => unregister())

const unset = refusal(404, "Request_ResourceNotFound", "Resource '' does not exist or one of its queried reference-property objects are not present.")

function tenant(routes: Record<string, GraphRoute> = {}) {
  return scriptedGraph({
    "/beta/deviceManagement/deviceCompliancePolicies": { value: [{ id: "cp1", displayName: "Compliance" }] },
    "/beta/deviceManagement/deviceCompliancePolicies/cp1?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations),assignments": { id: "cp1", displayName: "Compliance", scheduledActionsForRule: [], assignments: [] },
    "/beta/deviceManagement/deviceManagementScripts": { value: [{ id: "ps1", displayName: "Script" }] },
    "/beta/deviceManagement/deviceManagementScripts/ps1?$expand=assignments": { id: "ps1", displayName: "Script", assignments: [] },
    "/beta/policies/tokenLifetimePolicies": { value: [] },
    "/beta/policies/federatedTokenValidationPolicy": unset,
    "/beta/policies/mobileDeviceManagementPolicies": { value: [] },
    "/beta/identityGovernance/termsOfUse/agreements": { value: [] },
    ...routes,
  })
}

const INTUNE: ModuleId[] = ["intune"]
const ALL: ModuleId[] = ["intune", "entra"]
const reader = (roles: string[], excluded: string[] = []): Partial<BackupEngineDeps> => ({
  unattendedTokens: () => ({ mode: "app-only", graph: async () => jwt({ roles }), storage: async () => "storage", excludedTypes: async () => excluded }),
})

interface Row {
  name: string
  services: ModuleId[]
  routes?: Record<string, GraphRoute>
  deps?: Partial<BackupEngineDeps>
  request?: Partial<BackupRequest>
  /** The manifest: Status, Failures, SkippedTypes, FailedTypes as before this version, and Coverage next to them. */
  manifest: { Status: string; Failures: number; SkippedTypes: string[]; FailedTypes: string[]; Coverage: "Complete" | "Incomplete" }
  /** The outcome of the type the row is about. */
  outcome?: [folder: string, outcome: string, cause?: string]
  /** The services whose types the old backup holds, when not the ones the row backs up. */
  oldHolds?: ModuleId[]
  /** Whether retention removed the old backup. It stays when the new backup has failures or does not hold a type the old one has. */
  oldBackup: "removed" | "kept"
  /** Completed: the slot is done. Failed: the scheduler tries the slot again, up to three times. */
  scheduler: "Completed" | "Failed"
  notification: "Success" | "CompletedWithWarnings" | "Failed"
  /** Whether this version imports the backup, and whether release 0.5.x does; a refusal names the release's message. */
  importHere: true | string
  importRelease: true | string
  /** What the schedule, the notification and the result say of the job, where the row is about that. */
  message?: string
}

const INCOMPLETE = "Only complete backups with item metadata can be imported"
/** Release 0.5.x has no such type, whatever its outcome. */
const UNKNOWN_TYPE = "Unsupported backup item"

const denied = refusal(403, "Forbidden", "Forbidden")
const broken = refusal(400, "BadRequest", "Something went wrong")
const notOnboarded = refusal(403, "Forbidden", "Tenant is not onboarded to this service.")
/** A backup scope that selects the PowerShell scripts and nothing else. */
const ONLY_SCRIPTS = INTUNE_TYPES.map((type) => type.folder).filter((folder) => folder !== "PowerShellScripts")

const ROWS: Row[] = [
  // A tenant that backs up what it did before the update.
  { name: "Intune: every type saved", services: INTUNE,
    manifest: { Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Coverage: "Complete" }, oldBackup: "removed", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },
  { name: "Intune: a type denied in every run", services: INTUNE, routes: { "/beta/deviceManagement/deviceManagementScripts": denied },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: ["PowerShellScripts"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["PowerShellScripts", "skipped", "permission"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },
  { name: "Intune: an object that could not be read", services: INTUNE, routes: { "/beta/deviceManagement/deviceManagementScripts/ps1?$expand=assignments": broken },
    manifest: { Status: "CompletedWithWarnings", Failures: 1, SkippedTypes: [], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["PowerShellScripts", "failed"], oldBackup: "kept", scheduler: "Failed", notification: "CompletedWithWarnings", importHere: INCOMPLETE, importRelease: INCOMPLETE },
  { name: "Intune: a type whose list could not be read", services: INTUNE, routes: { "/beta/deviceManagement/deviceManagementScripts": broken },
    manifest: { Status: "CompletedWithWarnings", Failures: 1, SkippedTypes: [], FailedTypes: ["PowerShellScripts"], Coverage: "Incomplete" }, outcome: ["PowerShellScripts", "failed"], oldBackup: "kept", scheduler: "Failed", notification: "CompletedWithWarnings", importHere: INCOMPLETE, importRelease: INCOMPLETE },
  { name: "Intune: nothing saved and a type failed", services: INTUNE, routes: { "/beta/deviceManagement/deviceCompliancePolicies": broken, "/beta/deviceManagement/deviceManagementScripts": { value: [] } }, request: { scope: { excluded: ["CompliancePolicySettings"] } },
    manifest: { Status: "Failed", Failures: 1, SkippedTypes: [], FailedTypes: ["CompliancePolicies"], Coverage: "Incomplete" }, outcome: ["CompliancePolicies", "failed"], oldBackup: "kept", scheduler: "Failed", notification: "Failed", importHere: INCOMPLETE, importRelease: INCOMPLETE },
  { name: "Intune: a type the Backup Reader does not read", services: INTUNE, deps: reader(["DeviceManagementConfiguration.Read.All"], ["DeviceCategories", "DeviceCleanupRules"]), request: { trigger: "scheduled" },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["DeviceCategories", "skipped", "permission"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },
  { name: "Intune: a type the backup scope leaves out", services: INTUNE, request: { scope: { excluded: ["PowerShellScripts"] } },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Coverage: "Complete" }, oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },

  // A tenant that turned on Entra ID.
  { name: "new service: a type saved", services: ALL, routes: { "/beta/policies/tokenLifetimePolicies": { value: [{ id: "tl1", displayName: "Lifetime" }] } },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Coverage: "Complete" }, outcome: ["TokenLifetimePolicies", "saved"], oldBackup: "removed", scheduler: "Completed", notification: "Success", importHere: true, importRelease: UNKNOWN_TYPE },
  { name: "new service: a type not configured", services: ALL,
    manifest: { Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Coverage: "Complete" }, outcome: ["FederatedTokenValidationPolicy", "notConfigured"], oldBackup: "removed", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },
  { name: "new service: a type left out for a permission (401 HTML page)", services: ALL, routes: { "/beta/policies/tokenLifetimePolicies": () => new Response("<html>401</html>", { status: 401 }) },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: ["TokenLifetimePolicies"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["TokenLifetimePolicies", "skipped", "permission"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },
  { name: "new service: a granted type refused for the account's role", services: ALL, routes: { "/beta/policies/tokenLifetimePolicies": refusal(403, "Authorization_RequestDenied", "Insufficient privileges to complete the operation.") },
    deps: { getToken: async () => jwt({ scp: "DeviceManagementConfiguration.Read.All DeviceManagementScripts.Read.All Policy.Read.All Agreement.Read.All" }) },
    manifest: { Status: "CompletedWithWarnings", Failures: 1, SkippedTypes: [], FailedTypes: ["TokenLifetimePolicies"], Coverage: "Incomplete" }, outcome: ["TokenLifetimePolicies", "failed"], oldBackup: "kept", scheduler: "Failed", notification: "CompletedWithWarnings", importHere: INCOMPLETE, importRelease: INCOMPLETE },
  { name: "new service: a type left out because the token lacks its permission", services: ALL, deps: { getToken: async () => jwt({ scp: "DeviceManagementConfiguration.Read.All Policy.Read.All" }) },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: ["TermsOfUseAgreements"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["TermsOfUseAgreements", "skipped", "permission"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },
  { name: "new service: a type left out for a missing license or onboarding", services: ALL, routes: { "/beta/identityGovernance/termsOfUse/agreements": refusal(403, "Forbidden", "Tenant is not onboarded to this service.") },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: ["TermsOfUseAgreements"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["TermsOfUseAgreements", "skipped", "license"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },
  { name: "new service: a type only a signed-in admin can read, in a Backup Reader run", services: ALL, deps: reader(["DeviceManagementConfiguration.Read.All", "DeviceManagementScripts.Read.All", "DeviceManagementApps.Read.All", "DeviceManagementServiceConfig.Read.All", "DeviceManagementRBAC.Read.All", "DeviceManagementManagedDevices.Read.All", "Policy.Read.All", "Agreement.Read.All"]), request: { trigger: "scheduled" },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: ["MdmEnrollmentPolicies"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["MdmEnrollmentPolicies", "skipped", "signedIn"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },
  { name: "new service: a type that could not be read (asked to wait ten minutes)", services: ALL, routes: { "/beta/policies/tokenLifetimePolicies": () => new Response("", { status: 429, headers: { "retry-after": "600" } }) },
    manifest: { Status: "CompletedWithWarnings", Failures: 1, SkippedTypes: [], FailedTypes: ["TokenLifetimePolicies"], Coverage: "Incomplete" }, outcome: ["TokenLifetimePolicies", "failed"], oldBackup: "kept", scheduler: "Failed", notification: "CompletedWithWarnings", importHere: INCOMPLETE, importRelease: INCOMPLETE },
  // The old backup was made while the service was on: it stays, as the last backup that holds the service's types.
  { name: "new service: turned off for the tenant, although its endpoint would fail", services: INTUNE, routes: { "/beta/policies/tokenLifetimePolicies": broken }, oldHolds: ALL,
    manifest: { Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Coverage: "Complete" }, oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true },

  // A tenant that backs up a new service only. A backup that read nothing is a failure; one that read the tenant is not, whatever it found.
  { name: "new service only: every type left out, nothing read", services: ["entra"], request: { scope: termsOnly }, routes: { "/beta/identityGovernance/termsOfUse/agreements": notOnboarded },
    manifest: { Status: "Failed", Failures: 0, SkippedTypes: ["TermsOfUseAgreements"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["TermsOfUseAgreements", "skipped", "license"], oldBackup: "kept", scheduler: "Failed", notification: "Failed", importHere: INCOMPLETE, importRelease: INCOMPLETE,
    message: "Nothing could be read. The selected type was left out because the tenant has no license for the product or never set it up." },
  { name: "new service only: every type left out for different causes, nothing read", services: ["entra"], request: { scope: { excluded: ["TermsOfUseAgreements"] } }, deps: { concurrency: 1 },
    routes: { "/beta/policies/tokenLifetimePolicies": () => new Response("<html>401</html>", { status: 401 }), "/beta/policies/federatedTokenValidationPolicy": notOnboarded, "/beta/policies/mobileDeviceManagementPolicies": notOnboarded },
    manifest: { Status: "Failed", Failures: 0, SkippedTypes: ["TokenLifetimePolicies", "FederatedTokenValidationPolicy", "MdmEnrollmentPolicies"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["TokenLifetimePolicies", "skipped", "permission"], oldBackup: "kept", scheduler: "Failed", notification: "Failed", importHere: INCOMPLETE, importRelease: INCOMPLETE,
    message: "Nothing could be read. Every selected type was left out, most of them because the tenant has no license for the product or never set it up." },
  { name: "new service only: every type left out because the token lacks its permission, before any request", services: ["entra"], request: { scope: termsOnly }, deps: { getToken: async () => jwt({ scp: "DeviceManagementConfiguration.Read.All" }) },
    manifest: { Status: "Failed", Failures: 0, SkippedTypes: ["TermsOfUseAgreements"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["TermsOfUseAgreements", "skipped", "permission"], oldBackup: "kept", scheduler: "Failed", notification: "Failed", importHere: INCOMPLETE, importRelease: INCOMPLETE,
    message: "Nothing could be read. The selected type was left out because the TenuVault app registration may lack the permission or its admin consent. Services and permissions in Settings shows what is missing." },
  { name: "new service only: every type empty or not configured", services: ["entra"],
    manifest: { Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Coverage: "Complete" }, outcome: ["FederatedTokenValidationPolicy", "notConfigured"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true,
    message: "Backup completed successfully" },
  { name: "new service only: a type read and another left out", services: ["entra"], routes: { "/beta/policies/tokenLifetimePolicies": { value: [{ id: "tl1", displayName: "Lifetime" }] }, "/beta/policies/mobileDeviceManagementPolicies": notOnboarded },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: ["MdmEnrollmentPolicies"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["MdmEnrollmentPolicies", "skipped", "license"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: UNKNOWN_TYPE,
    message: "Backup completed successfully" },
  { name: "new service only: a type empty and the others left out", services: ["entra"], routes: { "/beta/policies/federatedTokenValidationPolicy": notOnboarded, "/beta/policies/mobileDeviceManagementPolicies": notOnboarded }, deps: { concurrency: 1 },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: ["FederatedTokenValidationPolicy", "MdmEnrollmentPolicies"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["TokenLifetimePolicies", "saved"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true,
    message: "Backup completed successfully" },
  { name: "new service only: the one type could not be read", services: ["entra"], request: { scope: termsOnly }, routes: { "/beta/identityGovernance/termsOfUse/agreements": broken },
    manifest: { Status: "Failed", Failures: 1, SkippedTypes: [], FailedTypes: ["TermsOfUseAgreements"], Coverage: "Incomplete" }, outcome: ["TermsOfUseAgreements", "failed"], oldBackup: "kept", scheduler: "Failed", notification: "Failed", importHere: INCOMPLETE, importRelease: INCOMPLETE,
    message: "Backup failed: no policies could be saved" },
  // The same rule for Intune, where it only shows when the backup scope leaves out the four types whose refusal always was a failure.
  { name: "Intune: the only selected type denied, nothing read", services: INTUNE, routes: { "/beta/deviceManagement/deviceManagementScripts": denied }, request: { scope: { excluded: ONLY_SCRIPTS } },
    manifest: { Status: "Failed", Failures: 0, SkippedTypes: ["PowerShellScripts"], FailedTypes: [], Coverage: "Incomplete" }, outcome: ["PowerShellScripts", "skipped", "permission"], oldBackup: "kept", scheduler: "Failed", notification: "Failed", importHere: INCOMPLETE, importRelease: INCOMPLETE,
    message: "Nothing could be read. The selected type was left out because the TenuVault app registration may lack the permission or its admin consent. Services and permissions in Settings shows what is missing." },
  { name: "Intune: the only selected type empty", services: INTUNE, routes: { "/beta/deviceManagement/deviceManagementScripts": { value: [] } }, request: { scope: { excluded: ONLY_SCRIPTS } },
    manifest: { Status: "Success", Failures: 0, SkippedTypes: [], FailedTypes: [], Coverage: "Complete" }, outcome: ["PowerShellScripts", "saved"], oldBackup: "kept", scheduler: "Completed", notification: "Success", importHere: true, importRelease: true,
    message: "Backup completed successfully" },
]

async function seedOld(store: LocalBlobStore, account: string, services: ModuleId[]): Promise<void> {
  await store.createContainer(account, "intune-backups")
  const held = INTUNE_TYPES.map((type) => type.folder).filter((folder) => services.includes(moduleForFolder(folder)!.module.id))
  const metadata = { BackupFolder: OLD, Status: "Success", Failures: 0, TenantId: TENANT, Scope: { Excluded: [], Included: held }, SkippedTypes: [], FailedTypes: [] }
  await store.put(account, "intune-backups", `${OLD}/metadata.json`, Buffer.from(JSON.stringify(metadata)), "application/json")
  await store.put(account, "intune-backups", `${OLD}/CompliancePolicies/Compliance.json`, Buffer.from("{}"), "application/json")
}

/** The files a download of the backup holds: everything but the ownership marker, plus the export manifest. */
async function exported({ store, account }: Fixture, job: BackupJob, change: (metadata: Record<string, unknown>) => Record<string, unknown> = (metadata) => metadata): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  for (const blob of await store.list(account, "intune-backups")) {
    if (!blob.name.startsWith(`${job.backupFolder}/`) || blob.name.endsWith(`/${BACKUP_OWNER_FILE}`)) continue
    const name = blob.name.slice(job.backupFolder!.length + 1)
    const { data } = await store.get(account, "intune-backups", blob.name)
    files.set(name, name === "metadata.json" ? Buffer.from(JSON.stringify(change(JSON.parse(data.toString())))) : data)
  }
  files.set("tenuvault-manifest.json", Buffer.from(JSON.stringify({ version: 1, sourceTenantId: TENANT, backupId: job.backupFolder })))
  return files
}

async function zipped(files: Map<string, Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, data] of files) zip.file(name, data)
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

const answer = async (attempt: () => unknown): Promise<true | string> => {
  try {
    await attempt()
    return true
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe("every outcome combination against what reads a backup's result", () => {
  it.each(ROWS)("$name", async (row) => {
    const handed: RunOutcomes[] = []
    const setup = fixture(tenant(row.routes), { services: () => ({ services: row.services }), retentionDays: () => 30, now: () => NOW, onOutcomes: (outcomes) => handed.push(outcomes), ...row.deps })
    await seedOld(setup.store, setup.account, row.oldHolds ?? row.services)
    const job = await setup.run(row.request)
    const metadata = await setup.manifest(job)

    // The manifest: the fields release 0.5.x reads, and coverage next to them.
    expect({ Status: metadata.Status, Failures: metadata.Failures, SkippedTypes: metadata.SkippedTypes, FailedTypes: metadata.FailedTypes, Coverage: metadata.Coverage }).toEqual(row.manifest)
    expect(job.coverage).toBe(row.manifest.Coverage === "Complete" ? "complete" : "incomplete")
    expect(job.results!.coverage).toBe(job.coverage)

    // One outcome per selected type, with the run ID, on the job, in the manifest and handed to the listener.
    expect(job.outcomes).toMatchObject({ runId: job.id, tenantId: TENANT, status: row.manifest.Status, coverage: job.coverage })
    expect(metadata.RunId).toBe(job.id)
    expect(handed).toEqual([job.outcomes])
    expect(metadata.Outcomes.map((entry: { Folder: string }) => entry.Folder)).toEqual(job.outcomes!.types.map((type) => type.folder))
    expect(job.outcomes!.types.map((type) => type.folder)).toEqual(job.results!.types.map((type) => type.folder))
    expect(new Set(job.outcomes!.types.map((type) => type.folder)).size).toBe(job.outcomes!.types.length)
    if (row.outcome) {
      const [folder, outcome, cause] = row.outcome
      expect(job.outcomes!.types.find((type) => type.folder === folder)).toMatchObject({ outcome, ...(cause ? { cause } : {}) })
    }
    // A type that is not selected has no outcome: its service is off, or the scope leaves it out.
    const selected = new Set(job.outcomes!.types.map((type) => type.folder))
    for (const type of TYPES) expect(selected.has(type.folder)).toBe(row.services.includes("entra") && !row.request?.scope?.excluded.includes(type.folder))
    for (const folder of row.request?.scope?.excluded ?? []) expect(selected.has(folder)).toBe(false)
    // What the manifest says of coverage agrees with the folders retention and comparison count as covered.
    const notRead = manifestCoverage(metadata).notRead
    for (const folder of notRead) if (job.outcomes!.types.find((type) => type.folder === folder)!.outcome === "skipped") expect(coveredFolders(metadata).has(folder)).toBe(false)

    // Retention, the scheduler and notifications follow status and failures, never coverage.
    const folders = new Set((await setup.store.list(setup.account, "intune-backups")).map((blob) => blob.name.split("/")[0]))
    expect(folders.has(OLD) ? "kept" : "removed").toBe(row.oldBackup)
    expect(scheduledResult(job).status).toBe(row.scheduler)
    expect(notifiedStatus(job)).toBe(row.notification)
    if (row.message) expect(scheduledResult(job).message).toBe(row.message)
    // A failure that Microsoft answered, or that came before any request, is never taken for an unreachable network.
    expect(job.unreachable).toBeUndefined()

    // Import: into this version, and by the rules of release 0.5.x.
    const files = await exported(setup, job)
    const archive = await zipped(files)
    expect(await answer(() => reviewArchive(archive))).toBe(row.importHere)
    expect(await answer(() => reviewAsRelease05(files))).toBe(row.importRelease)
  })

  it("names every outcome and every cause at least once", () => {
    const seen = new Set(ROWS.flatMap((row) => (row.outcome ? [row.outcome[1], ...(row.outcome[2] ? [row.outcome[2]] : [])] : [])))
    expect([...seen].sort()).toEqual(["failed", "license", "notConfigured", "permission", "saved", "signedIn", "skipped"])
    expect(new Set(ROWS.map((row) => row.manifest.Status))).toEqual(new Set(["Success", "CompletedWithWarnings", "Failed"]))
  })
})

describe("a backup that read nothing", () => {
  it("is recorded as failed with the reason, keeps every older backup and says so where the result is read", async () => {
    const setup = fixture(tenant({ "/beta/identityGovernance/termsOfUse/agreements": notOnboarded }), { services: () => ({ services: ["entra"] }), retentionDays: () => 30, now: () => NOW })
    // An old backup that holds nothing the tenant still backs up would be removed by a backup that worked.
    await seedOld(setup.store, setup.account, [])
    const job = await setup.run({ trigger: "scheduled", scope: termsOnly })
    const reason = "Nothing could be read. The selected type was left out because the tenant has no license for the product or never set it up."
    expect(job).toMatchObject({ status: "Failed", failures: 0, totalPolicies: 0, coverage: "incomplete", progressMessage: "Backup failed: nothing could be read", exception: reason })
    expect(await setup.manifest(job)).toMatchObject({ Status: "Failed", Failures: 0, Error: reason, Coverage: "Incomplete", ItemCounts: { TotalPolicies: 0 } })
    expect(job.outcomes).toMatchObject({ status: "Failed", coverage: "incomplete" })
    expect(job.log.map((line) => line.slice(11))).toEqual(expect.arrayContaining(["Older backups were kept because this backup is incomplete.", `Backup failed: n${reason.slice(1)}`]))
    expect(job.log.some((line) => line.includes("Backup completed"))).toBe(false)
    expect((await setup.store.list(setup.account, "intune-backups")).some((blob) => blob.name.startsWith(OLD))).toBe(true)
    // The scheduler tries the slot again, as for any failed backup that Microsoft answered.
    expect(scheduledResult(job)).toEqual({ status: "Failed", message: reason })
    expect(notifiedStatus(job)).toBe("Failed")
  })

  it("fails a run when the Backup Reader is refused on its only granted type", async () => {
    const setup = fixture(tenant({ "/beta/identityGovernance/termsOfUse/agreements": refusal(403, "Forbidden", "Missing application roles. API required roles: Agreement.Read.All.") }), { services: () => ({ services: ["entra"] }), ...reader(["Agreement.Read.All"]) })
    const job = await setup.run({ trigger: "scheduled", scope: termsOnly })
    expect(job.status).toBe("Failed")
    expect(job.outcomes?.types).toMatchObject([{ outcome: "failed", status: 403 }])
    expect(job.progressMessage).toBe("Backup failed: no policies could be saved")
    // Not a problem with the reader's certificate, which a retry could not fix.
    expect(job.credentialError).toBeUndefined()
  })

  it("is not what a backup without a selected type is: a tenant with every service off still completes", async () => {
    const setup = fixture(tenant(), { services: () => ({ services: [] }) })
    const job = await setup.run()
    expect(job).toMatchObject({ status: "Completed", progressMessage: "Backup completed successfully", coverage: "complete" })
    expect(await setup.manifest(job)).toMatchObject({ Status: "Success", Outcomes: [] })
  })
})

describe("Intune policy set coverage", () => {
  it("records policy sets as not read when the delegated token has only the Apps permission", async () => {
    const path = "/beta/deviceAppManagement/policySets"
    const setup = fixture(tenant(), { services: () => ({ services: INTUNE }), getToken: async () => jwt({ scp: "DeviceManagementApps.Read.All" }) })
    const job = await setup.run()
    expect(setup.requests.some((request) => request.path === path)).toBe(false)
    expect(job.status).toBe("Completed")
    const outcome = job.outcomes?.types.find((entry) => entry.folder === "PolicySets")
    expect(outcome).toMatchObject({ outcome: "skipped", cause: "permission", reason: expect.stringContaining("DeviceManagementConfiguration.Read.All") })
    const coverage = manifestCoverage(await setup.manifest(job))
    expect(coverage).toMatchObject({ coverage: "incomplete", notRead: ["PolicySets"], notReadReasons: { PolicySets: expect.stringContaining("DeviceManagementConfiguration.Read.All") } })
    expect(coverage.emptyTypes).not.toContain("PolicySets")
  })

  it("records a refused detail read as a coverage gap when token claims are unavailable", async () => {
    const path = "/beta/deviceAppManagement/policySets"
    const setup = fixture(tenant({
      [path]: { value: [{ id: "set", displayName: "Policy set" }] },
      [`${path}/set?$expand=items,assignments`]: refusal(403, "Forbidden", "Insufficient privileges to complete the operation."),
    }), { services: () => ({ services: INTUNE }) })
    const job = await setup.run()
    expect(job.status).toBe("Completed")
    expect(job.outcomes?.types.find((entry) => entry.folder === "PolicySets")).toMatchObject({ outcome: "failed", status: 403 })
    const { notReadReasons } = manifestCoverage(await setup.manifest(job))
    expect(notReadReasons?.PolicySets).toContain("HTTP 403")
    expect(notReadReasons?.PolicySets).not.toContain("Insufficient privileges to complete the operation")
  })

  it("reads policy sets with the Configuration write permission alone", async () => {
    const path = "/beta/deviceAppManagement/policySets"
    const setup = fixture(tenant({
      [path]: { value: [{ id: "set", displayName: "Policy set" }] },
      [`${path}/set?$expand=items,assignments`]: { id: "set", displayName: "Policy set", items: [], assignments: [] },
    }), { services: () => ({ services: INTUNE }), getToken: async () => jwt({ scp: "DeviceManagementConfiguration.ReadWrite.All" }) })
    const job = await setup.run()
    expect(job.outcomes?.types.find((entry) => entry.folder === "PolicySets")).toMatchObject({ outcome: "saved", saved: 1 })
    expect(await setup.files(job)).toContain("PolicySets/Policy set.json")
  })
})

describe("a run that stops before it finished", () => {
  it("records the outcomes in the manifest it leaves behind, with every unfinished type as not read, and hands them over once", async () => {
    const handed: RunOutcomes[] = []
    const finished: string[] = []
    // The sign-in is refused on an object read, after the run claimed its folder.
    const setup = fixture(tenant({ "/beta/deviceManagement/deviceManagementScripts/ps1?$expand=assignments": refusal(401, "InvalidAuthenticationToken", "Access token has expired or is not yet valid.") }), {
      services: () => ({ services: ALL }), concurrency: 1, onOutcomes: (outcomes) => handed.push(outcomes), onFinished: (job) => finished.push(job.id),
    })
    const job = await setup.run()
    expect(job.status).toBe("Failed")
    const metadata = await setup.manifest(job)
    expect(metadata).toMatchObject({ Status: "Failed", Coverage: "Incomplete", RunId: job.id, Error: "Microsoft Graph authentication failed (HTTP 401)." })
    const recorded = Object.fromEntries(metadata.Outcomes.map((entry: { Folder: string; Outcome: string }) => [entry.Folder, entry]))
    // Read before the stop: saved. Being read, or not reached: not read, with what the backup holds of it.
    expect(recorded.CompliancePolicies).toEqual({ Folder: "CompliancePolicies", Outcome: "saved", Saved: 1 })
    expect(recorded.PowerShellScripts).toEqual({ Folder: "PowerShellScripts", Outcome: "failed", Saved: 0, Error: "The backup stopped before this type was read in full." })
    expect(recorded.FederatedTokenValidationPolicy).toEqual({ Folder: "FederatedTokenValidationPolicy", Outcome: "notConfigured" })
    expect(job.outcomes).toMatchObject({ runId: job.id, status: "Failed", coverage: "incomplete" })
    expect(handed).toEqual([job.outcomes])
    expect(finished).toEqual([job.id])
    // A stopped backup is never imported, here or by release 0.5.x.
    const files = await exported(setup, job)
    expect(await answer(async () => reviewArchive(await zipped(files)))).toBe(INCOMPLETE)
    expect(await answer(() => reviewAsRelease05(files))).toBe(INCOMPLETE)
  })

  it("hands over no outcomes for a run that never got to choose what to read, and a failing listener changes nothing", async () => {
    const handed: RunOutcomes[] = []
    const refused = fixture(tenant(), { services: () => ({ services: INTUNE }), onOutcomes: (outcomes) => handed.push(outcomes), unattendedTokens: () => ({ mode: "app-only", graph: async () => "t", storage: async () => "t", excludedTypes: async () => { throw new Error("AADSTS700016: the Backup Reader was deleted") } }) })
    const stopped = await refused.run({ trigger: "scheduled" })
    expect(stopped.status).toBe("Failed")
    expect(stopped.outcomes).toBeUndefined()
    expect(handed).toEqual([])
    const throwing = fixture(tenant(), { services: () => ({ services: INTUNE }), onOutcomes: () => { throw new Error("store is full") } })
    const job = await throwing.run()
    expect(job).toMatchObject({ status: "Completed", coverage: "complete" })
  })
})

describe("a backup that crosses versions", () => {
  it("written by this version imports into release 0.5.x with its added fields, and those fields are all it added", async () => {
    const setup = fixture(tenant({ "/beta/deviceManagement/deviceManagementScripts": denied }), { services: () => ({ services: INTUNE }) })
    const job = await setup.run()
    const files = await exported(setup, job)
    const metadata = JSON.parse(files.get("metadata.json")!.toString())
    expect(Object.keys(metadata)).toEqual([
      "BackupDate", "BackupFolder", "StartTime", "EndTime", "CompletedAt", "Duration", "DurationSeconds", "ItemCounts", "Status", "RunbookVersion", "BackupFormat", "Source", "TenantId",
      "Trigger", "RunId", "Scope", "Failures", "SkippedTypes", "FailedTypes", "AuthMode", "Coverage", "Outcomes", "Items",
    ])
    expect(metadata.Coverage).toBe("Incomplete")
    // The compliance policy and the tenant-wide compliance settings; the scripts were denied.
    expect(reviewAsRelease05(files)).toEqual({ tenantId: TENANT, backupId: job.backupFolder, count: 2 })
    // The release counts only numbers in ItemCounts and only type folders in Items: nothing was added to either.
    expect(Object.values(metadata.ItemCounts).every((count) => typeof count === "number")).toBe(true)
    expect(Object.keys(metadata.Items).every((key) => RELEASE_FOLDERS.includes(key.split("/")[0]!))).toBe(true)
  })

  it("written by release 0.5.x imports here, and its coverage reads as not recorded instead of incomplete", async () => {
    const setup = fixture(tenant(), { services: () => ({ services: INTUNE }) })
    const job = await setup.run()
    // A manifest as the release writes it: the same fields, without the two this version adds.
    const files = await exported(setup, job, ({ Coverage: _coverage, Outcomes: _outcomes, ...release }) => release)
    const reviewed = await reviewArchive(await zipped(files))
    expect(reviewed).toMatchObject({ tenantId: TENANT, backupId: job.backupFolder, count: 3 })
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-import-")), [Buffer.alloc(32, 7)])
    await importArchive(store, reviewed)
    const imported = JSON.parse((await store.get(`tvlocal-${TENANT}`, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString())
    expect(imported).toMatchObject({ Status: "Success", Failures: 0, SourceTenantId: TENANT })
    expect(manifestCoverage(imported)).toEqual({ coverage: null, notRead: [] })
    // Retention and comparison read it as they did: every type it attempted is covered.
    expect(coveredFolders(imported).has("CompliancePolicies")).toBe(true)
  })

  it("that holds a type release 0.5.x does not know is refused there as a whole, not imported in part", async () => {
    const setup = fixture(tenant({ "/beta/policies/tokenLifetimePolicies": { value: [{ id: "tl1", displayName: "Lifetime" }] } }), { services: () => ({ services: ALL }) })
    const files = await exported(setup, await setup.run())
    expect(() => reviewAsRelease05(files)).toThrow("Unsupported backup item")
  })
})
