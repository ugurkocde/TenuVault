import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { INTUNE_TYPES, typeForFolder } from "../src/shared/intune/registry"
import { listSnapshot } from "../src/shared/intune/read"
import { comparableSnapshot } from "../src/shared/intune/compare"
import { COMPLIANCE_SETTING_KEYS, COMPLIANCE_SETTINGS_ID } from "../src/shared/intune/compliance-settings"
import { PLAIN_CLOUD_RUNBOOK, cloudRunbookNeedsUpgrade, cloudStatusBlobName, parseCloudStatus } from "../src/shared/cloud-backup"
import { resolveBackupOwnership } from "../src/shared/backup-ownership"
import { BACKUP_OWNER_FILE } from "../src/shared/constants"
import { OTHER_TENANT_BACKUP, readOwnedBackup } from "../src/portal/lib/policies/backup-owner"

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))

const runbook = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url), "utf8")
const RUNBOOK_VERSION = /\$script:RunbookVersion = "([^"]+)"/.exec(runbook)?.[1]
const setup = readFileSync(new URL("../resources/New-TenuVaultCloudBackup.ps1", import.meta.url), "utf8")
type RunCall = { uri: string; method: string; contentType: string | null; ifNoneMatch: string | null; body: string | null }
type Run = { calls: RunCall[]; error?: string | null; output?: string[] }
let plainRuns: Run[] | undefined
/** The scenarios of the plain-run fixture: a full run, an early failure, a failed manifest, and two runs with change reports on. */
function runPlainFixture(): Run[] {
  const script = fileURLToPath(new URL("./fixtures/cloud-backup/plain-run.ps1", import.meta.url))
  plainRuns ??= execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Run)
  return plainRuns
}
const TENANT = "11111111-2222-3333-4444-555555555555"
const BACKUP_CONTAINER_URL = "https://stcontoso.blob.core.windows.net/intune-backups/"
/** The blobs a run wrote to the backup container, by blob name, as a reader of the container sees them. */
function writtenBlobs(run: Run): Map<string, string> {
  return new Map(run.calls.filter((call) => call.method === "Put" && call.uri.startsWith(BACKUP_CONTAINER_URL))
    .map((call) => [decodeURIComponent(call.uri.slice(BACKUP_CONTAINER_URL.length)), call.body!]))
}
const read = (blobs: Map<string, string>) => async (name: string) => blobs.has(name) ? new Response(blobs.get(name)!, { status: 200, headers: { "content-type": "application/json" } }) : new Response(null, { status: 404 })
const folderOf = (blobs: Map<string, string>) => [...blobs.keys()].find((name) => name.endsWith(`/${BACKUP_OWNER_FILE}`))!.split("/")[0]!

const template = JSON.parse(readFileSync(new URL("../resources/cloud-backup/azuredeploy.json", import.meta.url), "utf8")) as {
  parameters: Record<string, unknown>
  resources: Array<{ type: string }>
  outputs: Record<string, unknown>
}

describe("Invoke-TenuVaultBackup.ps1 type table", () => {
  it("covers every desktop registry type with the same folder, path and read shape", () => {
    for (const type of INTUNE_TYPES) {
      const row = runbook.split("\n").find((line) => line.includes(`Folder = '${type.folder}'`))
      expect(row, type.folder).toBeTruthy()
      expect(row).toContain(`Path = '${type.path}'`)
      expect(row).toContain(`NameKey = '${type.nameKey}'`)
      expect(row).toContain(type.expand ? `Expand = '${type.expand}'` : "Expand = $null")
      expect(row).toContain(type.select ? `Select = '${type.select}'` : "Select = $null")
      expect(row).toContain(type.listQuery ? `ListQuery = '${type.listQuery}'` : "ListQuery = $null")
      expect(row).toContain(`AssignmentsFormerlyExpanded = $${type.assignmentsFormerlyExpanded === true ? "true" : "false"}`)
      if (type.listOnly) expect(row).toContain("ListOnly = $true")
      else expect(row).not.toContain("ListOnly")
      if (type.inventory) expect(row).toContain("Inventory = $true")
      else expect(row).not.toContain("Inventory")
      if (type.keep) expect(row).toContain(`Keep = @(${type.keep.map((key) => `'${key}'`).join(",")})`)
      else expect(row).not.toContain("Keep =")
      for (const extra of type.extras ?? []) {
        expect(row, `${type.folder}/${extra.property}`).toContain(`Property = '${extra.property}'`)
        expect(row).toContain(`Template = '${extra.path("{id}")}'`)
        if (extra.each) expect(row).toContain(`Template = '${extra.each.path("{id}", "{entryId}")}'`)
      }
    }
    expect([...runbook.matchAll(/Folder = '/g)]).toHaveLength(INTUNE_TYPES.length)
  })

  it("mirrors the singleton, the built-in skips and the masked OMA-URI rule", () => {
    const singleton = INTUNE_TYPES.find((type) => type.singleton)!
    expect(singleton.singleton?.id).toBe(COMPLIANCE_SETTINGS_ID)
    for (const key of COMPLIANCE_SETTING_KEYS) expect(runbook).toContain(`'${key}'`)
    for (const skipped of ["Remediations", "AppCategories", "ScopeTags", "RoleDefinitions"]) {
      expect(runbook).toContain(`"${skipped}"`)
      expect(INTUNE_TYPES.find((type) => type.folder === skipped)?.skip).toBeTypeOf("function")
    }
    expect(runbook).toContain("getOmaSettingPlainTextValue")
    expect(runbook).toContain('Set-TvProp $setting "value" "****"')
    expect(runbook).toContain("MaskedSecretItems")
  })
})

describe("Invoke-TenuVaultBackup.ps1 format", () => {
  it("writes plain JSON and never reads Key Vault or the recovery key", () => {
    // The legacy envelope is only recognised, so a sealed earlier backup is skipped, never opened.
    expect(runbook.match(/"TVAZ1`n"/g)).toHaveLength(1)
    expect(runbook).toMatch(/function Test-TvSealedBlob \{[^}]*"TVAZ1`n"/)
    for (const sealing of ["HKDF", "AesGcm", "Decrypt(", "tenuvault-azure-backup-v1", "tenuvault-recovery-key", "vault.azure.net", "application/octet-stream"]) {
      expect(runbook, sealing).not.toContain(sealing)
    }
    expect(runbook).not.toMatch(/Get-TvRequiredVariable "TenuVaultKeyVault"/)
    expect(runbook).not.toMatch(/Set-TvSealedBlob|Protect-TvAzureBlob|Get-TvRecoveryMasterKey/)
    // Every backup container write goes through one helper, as JSON.
    expect(runbook.match(/Invoke-TvHttp -Uri \$target\.Uri -Token \$Token -Method "Put"/g)).toHaveLength(1)
    expect(runbook).toContain('-BodyBytes ([Text.Encoding]::UTF8.GetBytes($Body)) -ContentType "application/json"')
    expect(runbook).toContain('headers["If-None-Match"] = "*"')
  })

  it("carries a plain runbook version, which the app does not flag for upgrade", () => {
    const version = RUNBOOK_VERSION
    // 1.3.0 adds change reports on top of the first plain runbook, 1.2.0; 1.4.0 records how a run started.
    expect(version).toBe("1.4.0")
    expect(PLAIN_CLOUD_RUNBOOK).toBe("1.2.0")
    expect(cloudRunbookNeedsUpgrade(version!)).toBe(false)
    expect(cloudRunbookNeedsUpgrade("1.1.0")).toBe(true)
    expect(cloudRunbookNeedsUpgrade("1.0.0")).toBe(true)
    expect(cloudRunbookNeedsUpgrade("0.9.9")).toBe(true)
    expect(cloudRunbookNeedsUpgrade("1.10.0")).toBe(false)
    expect(cloudRunbookNeedsUpgrade("2.0.0")).toBe(false)
    expect(cloudRunbookNeedsUpgrade("")).toBe(false)
    expect(cloudRunbookNeedsUpgrade("desktop")).toBe(false)
  })

  it.runIf(Boolean(pwsh))("records a run started by hand as manual, keeps scheduled runs and older schedule links scheduled", () => {
    const path = fileURLToPath(new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url))
    const trigger = (passed: string, marker: string | null) => execFileSync(pwsh!, ["-NoProfile", "-Command", [
      `. '${path.replace(/'/g, "''")}' -LibraryOnly -TenantKey 11111111`,
      marker === null ? "" : `[Environment]::SetEnvironmentVariable('TenuVaultScheduleSetsTrigger-11111111', '${marker}')`,
      `[Console]::Out.Write((Get-TvRunTrigger '${passed}'))`,
    ].join("\n")], { encoding: "utf8", timeout: 60_000 })
    // A setup from 1.4.0 on: its schedule link passes Scheduled, and a start by hand passes nothing.
    expect(trigger("Scheduled", "true")).toBe("scheduled")
    expect(trigger("", "true")).toBe("manual")
    expect(trigger("Manual", "true")).toBe("manual")
    // An older setup's link passes only TENANTKEY and no marker exists: every run stays scheduled.
    expect(trigger("", null)).toBe("scheduled")
    expect(trigger("manual", null)).toBe("manual")
    expect(trigger("bogus", "true")).toBe("manual")
    // The run records it as the backup's Trigger and passes it to the change report.
    expect(runbook).toContain("$runTrigger = Get-TvRunTrigger $Trigger")
    expect(runbook.match(/Trigger += \$runTrigger|Trigger = \$runTrigger/g)).toHaveLength(2)
    expect(runbook).toContain("-RunTrigger $runTrigger")
    expect(runbook).not.toContain('Trigger        = "scheduled"')
    expect(runbook).not.toContain('Trigger = "scheduled"; RunId')
  }, 60_000)

  it("links the schedule with TRIGGER and marks the link only once it is made", () => {
    expect(setup).toContain('-Parameters @{ TenantKey = $tenantKey; Trigger = "Scheduled" }')
    const link = setup.indexOf('Trigger = "Scheduled"')
    const marker = setup.indexOf('Set-TenuVaultAutomationVariable -Name "TenuVaultScheduleSetsTrigger-$tenantKey" -Value "true"')
    expect(marker).toBeGreaterThan(link)
    // -Remove deletes the marker with the tenant's other variables.
    expect(setup).toContain('"TenuVaultScheduleSetsTrigger-$tenantKey"\n)')
    const resources = template.resources as unknown as Array<{ type: string; name: string; dependsOn?: string[]; properties: Record<string, unknown> }>
    const jobSchedule = resources.find((resource) => resource.type === "Microsoft.Automation/automationAccounts/jobSchedules")!
    expect(jobSchedule.properties.parameters).toEqual({ TenantKey: "[variables('tenantKey')]", Trigger: "Scheduled" })
    const markerVariable = resources.find((resource) => resource.type === "Microsoft.Automation/automationAccounts/variables" && resource.name.includes("TenuVaultScheduleSetsTrigger-"))!
    expect(markerVariable.properties.value).toBe('"true"')
    // Never without the link: a redeploy whose link fails (Azure refuses to reuse a job schedule) writes no marker.
    expect(markerVariable.dependsOn).toEqual(["[resourceId('Microsoft.Automation/automationAccounts/jobSchedules', parameters('automationAccountName'), guid(variables('scheduleName'), variables('runbookName')))]"])
  })

  it.runIf(Boolean(pwsh))("never lets the optional change report fail a backup, and says when a backup with warnings gets none", () => {
    const [, , , reportFails, warnings] = runPlainFixture()
    // The report step meets an unexpected error: the backup is still recorded as a success.
    expect(reportFails!.error).toBeNull()
    expect(reportFails!.output).toContain("No change report was made: storage listing is unavailable")
    const status = reportFails!.calls.filter((call) => call.method === "Put" && call.uri.endsWith("/cloud-backup-status-11111111.json")).map((call) => JSON.parse(call.body!).LastStatus)
    expect(status).toEqual(["Success"])
    // A backup with warnings gets no report, and the job output says so.
    expect(warnings!.error).toBeNull()
    expect(warnings!.output).toContain("No change report: the backup completed with warnings.")
    expect(warnings!.calls.some((call) => call.uri.includes("comp=list"))).toBe(false)
  }, 60_000)

  it.runIf(Boolean(pwsh))("puts only plain JSON blobs during a run, records early failures and never calls Key Vault", () => {
    const [run, failed, claimed] = runPlainFixture()
    for (const scenario of [run!, failed!, claimed!]) {
      expect(scenario.calls.some((call) => call.uri.includes("vault.azure.net"))).toBe(false)
      const puts = scenario.calls.filter((call) => call.method === "Put")
      expect(puts.length).toBeGreaterThan(0)
      for (const put of puts) {
        expect(put.contentType, put.uri).toBe("application/json")
        expect(put.body!.startsWith("TVAZ1")).toBe(false)
        expect(() => JSON.parse(put.body!), put.uri).not.toThrow()
      }
    }
    const puts = run!.calls.filter((call) => call.method === "Put")
    const backup = "https://stcontoso.blob.core.windows.net/intune-backups/"
    const names = puts.map((call) => call.uri.replace(/backup-\d{4}-\d{2}-\d{2}-\d{6}/, "backup-<time>"))
    expect(names).toEqual(expect.arrayContaining([
      `${backup}backup-<time>/.tenuvault-owner.json`,
      `${backup}backup-<time>/DeviceConfigurations/Baseline%20Wi-Fi.json`,
      `${backup}backup-<time>/metadata.json`,
      `${backup}cloud-backup-status-11111111.json`,
    ]))
    // The claim comes first and is create-only; the policy file is the Graph object as read.
    expect(names[0]).toBe(`${backup}backup-<time>/.tenuvault-owner.json`)
    expect(puts[0]!.ifNoneMatch).toBe("*")
    const policy = JSON.parse(puts.find((call) => call.uri.includes("/DeviceConfigurations/"))!.body!)
    expect(policy).toMatchObject({ id: "cfg-1", displayName: "Baseline Wi-Fi" })
    expect(policy["@odata.context"]).toBeUndefined()
    const metadata = JSON.parse(puts.find((call) => call.uri.endsWith("/metadata.json"))!.body!)
    expect(metadata).toMatchObject({ Status: "Success", RunbookVersion: RUNBOOK_VERSION, Source: "TenuVault Cloud Backup", TenantId: "11111111-2222-3333-4444-555555555555" })
    const status = JSON.parse(puts.find((call) => call.uri.endsWith("/cloud-backup-status-11111111.json"))!.body!)
    expect(parseCloudStatus(status, "11111111-2222-3333-4444-555555555555")).toMatchObject({ lastStatus: "Success", runbookVersion: RUNBOOK_VERSION })
    // A run that fails before any backup write still records why, in the status blob and the note.
    expect(failed!.error).toContain("managed identity token")
    const failedStatus = failed!.calls.find((call) => call.method === "Put" && call.uri.endsWith("/cloud-backup-status-11111111.json"))
    expect(parseCloudStatus(JSON.parse(failedStatus!.body!), "11111111-2222-3333-4444-555555555555")).toMatchObject({ lastStatus: "Failed" })
    expect(failed!.calls.some((call) => call.method === "Put" && call.uri.includes("/tenuvault-backup-results/cloud-backup-outcomes/run-"))).toBe(true)
    expect(failed!.calls.some((call) => call.uri.includes("/intune-backups/backup-"))).toBe(false)
  }, 60_000)

  it.runIf(Boolean(pwsh))("saves a list-only type from its list entry, with the desktop snapshot and fingerprint", () => {
    const [run] = runPlainFixture()
    // No detail GET for the device: the list entry is the snapshot.
    expect(run!.calls.some((call) => call.uri.includes("windowsAutopilotDeviceIdentities/"))).toBe(false)
    const type = typeForFolder("AutopilotDevices")!
    const listed = { id: "ap-1", serialNumber: "SN-0001", manufacturer: "Contoso", model: "Laptop 7", groupTag: "Sales", displayName: null, userPrincipalName: "", lastContactedDateTime: "2026-11-01T10:00:00Z", enrollmentState: "enrolled", deviceAccountPassword: "secret", productKey: "PK-1", managedDeviceId: "md-1" }
    const expected = listSnapshot(type, listed)
    const put = run!.calls.find((call) => call.method === "Put" && call.uri.includes("/AutopilotDevices/"))!
    expect(put.uri).toContain("/AutopilotDevices/SN-0001.json")
    const saved = JSON.parse(put.body!)
    expect(saved).toEqual(expected)
    for (const left of ["deviceAccountPassword", "productKey", "managedDeviceId", "lastContactedDateTime", "enrollmentState"]) expect(saved).not.toHaveProperty(left)
    const metadata = JSON.parse(run!.calls.find((call) => call.method === "Put" && call.uri.endsWith("/metadata.json"))!.body!)
    const desktopHash = createHash("sha256").update(JSON.stringify(comparableSnapshot(expected))).digest("base64").slice(0, 22)
    expect(metadata.Items["AutopilotDevices/ap-1"].hash).toBe(desktopHash)
    // Devices are counted under their own folder, not as policies.
    expect(metadata.ItemCounts).toMatchObject({ AutopilotDevices: 1, DeviceConfigurations: 1, CompliancePolicySettings: 1, TotalPolicies: 2 })
  }, 60_000)

  it.runIf(Boolean(pwsh))("leaves the tenant evidence the app's ownership check needs, in complete, failed and in-flight backups", async () => {
    const [run, , claimed] = runPlainFixture()
    for (const scenario of [run!, claimed!]) {
      const blobs = writtenBlobs(scenario)
      const folder = folderOf(blobs)
      const manifest = JSON.parse(blobs.get(`${folder}/metadata.json`)!)
      const marker = JSON.parse(blobs.get(`${folder}/${BACKUP_OWNER_FILE}`)!)
      expect(typeof manifest.TenantId).toBe("string")
      expect(typeof marker.TenantId).toBe("string")
      expect(manifest.RunId).toBe(marker.RunId)
      // Restore, revert and recreate go through this check: owned by the manifest's tenant, refused for any other.
      const owned = await readOwnedBackup(read(blobs), folder, TENANT.toUpperCase(), "stcontoso")
      expect(owned).toMatchObject({ ok: true, owned: true, metadata: { TenantId: TENANT, Source: "TenuVault Cloud Backup" } })
      expect(await readOwnedBackup(read(blobs), folder, "99999999-2222-3333-4444-555555555555", "stcontoso")).toEqual({ ok: false, status: 403, error: OTHER_TENANT_BACKUP })
      const resolved = await resolveBackupOwnership(async (file) => {
        const body = blobs.get(`${folder}/${file}`)
        return body === undefined ? { kind: "missing" } : { kind: "found", value: JSON.parse(body) }
      }, TENANT)
      expect(resolved.owner).toMatchObject({ kind: "owned", source: "manifest", tenantId: TENANT, runId: manifest.RunId })
    }
    expect(JSON.parse(writtenBlobs(claimed!).get(`${folderOf(writtenBlobs(claimed!))}/metadata.json`)!)).toMatchObject({ Status: "Failed", Error: "HTTP 401" })
    // While a run is still writing, before metadata.json exists, the claim alone places the folder.
    const inFlight = writtenBlobs(run!)
    const folder = folderOf(inFlight)
    inFlight.delete(`${folder}/metadata.json`)
    const resolved = await resolveBackupOwnership(async (file) => {
      const body = inFlight.get(`${folder}/${file}`)
      return body === undefined ? { kind: "missing" } : { kind: "found", value: JSON.parse(body) }
    }, TENANT)
    expect(resolved.owner).toMatchObject({ kind: "owned", source: "marker", tenantId: TENANT })
    expect(await readOwnedBackup(read(inFlight), folder, TENANT, "stcontoso")).toMatchObject({ ok: true, owned: true, metadata: null })
  }, 60_000)

  it("writes the desktop manifest shape and the per tenant status blob", () => {
    for (const field of ["BackupDate", "BackupFolder", "StartTime", "EndTime", "Duration", "DurationSeconds", "ItemCounts", "Status", "RunbookVersion", "BackupFormat", "Source", "TenantId", "Trigger", "RunId", "Scope", "Failures", "SkippedTypes", "FailedTypes", "AuthMode", "Items"]) {
      expect(runbook, field).toContain(field)
    }
    expect(runbook).toContain('"TenuVault Cloud Backup"')
    expect(runbook).toContain(".tenuvault-owner.json")
    expect(cloudStatusBlobName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("cloud-backup-status-aaaaaaaa.json")
    expect(runbook).toContain('$script:StatusBlobPrefix = "cloud-backup-status-"')
  })

  it("hashes with the desktop parser and ordinal key order, not ConvertFrom-Json dates or culture sort", () => {
    expect(runbook).toContain("System.Text.Json.JsonDocument")
    expect(runbook).toContain("[StringComparer]::Ordinal")
  })

  it("reads with a managed identity and deletes nothing", () => {
    expect(runbook).toContain("IDENTITY_ENDPOINT")
    expect(runbook).toContain("https://graph.microsoft.com/beta")
    expect(runbook).not.toMatch(/Method\s+"(Delete|Post|Patch)"/)
    expect(runbook).not.toMatch(/Get-AutomationVariable -Name \$Name/)
  })
})

describe("New-TenuVaultCloudBackup.ps1", () => {
  it("grants only the read roles, behind the same device inventory decision", () => {
    for (const role of ["DeviceManagementConfiguration.Read.All", "DeviceManagementApps.Read.All", "DeviceManagementServiceConfig.Read.All", "DeviceManagementScripts.Read.All", "DeviceManagementRBAC.Read.All"]) {
      expect(setup).toContain(`"${role}"`)
    }
    expect(setup).toContain('if ($IncludeDeviceCategories) { $graphRoleNames += "DeviceManagementManagedDevices.Read.All" }')
    // AppRoleAssignment.ReadWrite.All is the Global Administrator's own delegated scope for
    // granting; no DeviceManagement write role may ever be assigned to the identity.
    expect(setup).not.toMatch(/DeviceManagement\w*\.ReadWrite/)
    expect(setup).toContain("DeviceCategories,DeviceCleanupRules")
  })

  it("creates no Key Vault, asks for no recovery key and refuses to guess about alerting", () => {
    for (const keyVault of ["Read-Host", "-AsSecureString", "Az.KeyVault", "New-AzKeyVault", "Set-AzKeyVaultSecret", "Get-AzKeyVaultSecret", "Key Vault Secrets", "tenuvault-recovery-key", "$KeyVaultName", "keyVault="]) {
      expect(setup, keyVault).not.toContain(keyVault)
    }
    expect(setup).not.toMatch(/\[string\]\$RecoveryKey/)
    expect(setup).not.toContain('Set-TenuVaultAutomationVariable -Name "TenuVaultKeyVault')
    expect(setup).toContain("-NoFailureAlert")
    expect(setup).toContain("Decide how failed cloud backups will be noticed")
  })

  it("upgrades an older setup in place and names its Key Vault for deletion", () => {
    expect(setup).toContain('$legacyKeyVaultVariable = "TenuVaultKeyVault-$tenantKey"')
    // A rerun drops the variable the runbook no longer reads, after the current variables are written.
    const removal = setup.indexOf("Remove-TenuVaultLegacyKeyVaultVariable -Runbook $runbook")
    expect(removal).toBeGreaterThan(setup.indexOf('Set-TenuVaultAutomationVariable -Name "TenuVaultAppOnlyExcluded-$tenantKey"'))
    expect(removal).toBeGreaterThan(setup.indexOf("$runbook = Publish-TenuVaultRunbook"))
    expect(setup).toContain("Publish-AzAutomationRunbook")
    // -Remove deletes it too and, like a rerun, names the old vault before it is gone.
    expect(setup).toContain("foreach ($name in @($variableNames) + $legacyKeyVaultVariable)")
    expect(setup).toContain("if ($Remove) {\n    Remove-TenuVaultCloudBackupSetup\n    return\n}")
    const removeMode = setup.slice(setup.indexOf("function Remove-TenuVaultCloudBackupSetup"), setup.indexOf("function Assert-TenuVaultAuthorizationActions"))
    expect(removeMode.indexOf("$legacyKeyVaults = Get-TenuVaultLegacyKeyVaults")).toBeLessThan(removeMode.indexOf("Remove-AzAutomationVariable"))
    expect(removeMode).toContain("Write-TenuVaultLegacyKeyVaultNote $legacyKeyVaults")
    expect(setup).toContain('-ResourceType "Microsoft.KeyVault/vaults"')
    expect(setup).toContain('$_.Name -like "kv-tenuvault-*"')
    expect(setup).toContain("TenuVault setup in this or any other Automation account still has a TenuVaultKeyVault variable")
    expect(setup).toContain("open in TenuVault with it")
    // The variable goes only when the published runbook, read back from Azure, no longer reads it.
    expect(setup).toContain("-Slot Published -OutputFolder $folder")
    expect(setup).toContain('$plainRunbookVersion = "1.2.0"')
    expect(setup).toContain('-Force -Confirm:$false | Out-Null\n    Publish-AzAutomationRunbook')
  })

  type SetupScenario = { scenario: string; plain: boolean; reason: string | null; error: string | null; actions: string[]; legacyVariableKept: boolean; changeReport?: string | null; changeReportActors?: string | null; tenantName?: string | null; variables: string[]; schedule: boolean; link: boolean; output: string[] }
  let setupScenarios: Map<string, SetupScenario> | undefined
  const setupRun = (name: string) => {
    if (!setupScenarios) {
      const script = fileURLToPath(new URL("./fixtures/cloud-backup/setup-upgrade.ps1", import.meta.url))
      const lines = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).split(/\r?\n/).filter((line) => line.startsWith("{"))
      setupScenarios = new Map(lines.map((line) => JSON.parse(line) as SetupScenario).map((run) => [run.scenario, run]))
    }
    return setupScenarios.get(name)!
  }
  const DELETE_ADVICE = "Delete the vault once no"

  it.runIf(Boolean(pwsh))("keeps the change report level and actors on a rerun without their parameters, and sets them when passed", () => {
    // An upgrade with a command that does not carry the change report choice keeps it.
    expect(setupRun("rerun-keeps-report")).toMatchObject({ error: null, changeReport: "names", changeReportActors: "false", tenantName: "Contoso" })
    // An empty -TenantName clears the saved name to the tenant id, never to an empty value.
    expect(setupRun("rerun-sets-report")).toMatchObject({ error: null, changeReport: "full", changeReportActors: "true", tenantName: "11111111-2222-3333-4444-555555555555" })
    expect(setup).toContain('$changeReportPassed = $PSBoundParameters.ContainsKey("ChangeReport")')
    expect(setup).toContain('$changeReportActorsPassed = $PSBoundParameters.ContainsKey("ChangeReportWithoutActors")')
  }, 60_000)

  it.runIf(Boolean(pwsh))("removes the Key Vault variable only when the published runbook reads back as plain", () => {
    const approved = setupRun("approved")
    expect(approved).toMatchObject({ plain: true, legacyVariableKept: false, error: null })
    // The import is told not to prompt again after the one approval, and the result is read back from the Published slot.
    expect(approved.actions).toEqual(["import confirm=False", "publish", "export Published", "remove TenuVaultKeyVault-11111111"])
    expect(approved.output.join(" ")).toContain(DELETE_ADVICE)
    for (const [name, reason] of [
      ["outer-declined", "the runbook import and publish was not approved"],
      // The import's own prompt declined with an older draft present: that draft is what got published.
      ["import-declined", "the published runbook is still version 1.1.0, older than 1.2.0"],
      ["published-older", "the published runbook is still version 1.1.0, older than 1.2.0"],
    ] as const) {
      const run = setupRun(name)
      expect(run, name).toMatchObject({ plain: false, reason, legacyVariableKept: true })
      expect(run.output, name).toContain(`Kept 'TenuVaultKeyVault-11111111': ${reason}. Run this script again to finish the upgrade.`)
      expect(run.output.join(" "), name).toContain(`Keep Key Vault kv-tenuvault-abc123: ${reason}`)
      expect(run.output.join(" "), name).not.toContain(DELETE_ADVICE)
    }
    expect(setupRun("outer-declined").actions).toEqual([])
    // A publish that throws stops the run before any variable changes.
    expect(setupRun("publish-throws")).toMatchObject({ error: "Publishing the runbook failed.", legacyVariableKept: true })
    expect(setupRun("publish-throws").actions).toEqual(["import confirm=False", "publish"])
  }, 60_000)

  it.runIf(Boolean(pwsh))("advises deleting the vault after -Remove only when the tenant's setup is gone", () => {
    const complete = setupRun("remove-complete")
    expect(complete).toMatchObject({ schedule: false, link: false, legacyVariableKept: false, variables: [] })
    expect(complete.output).toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
    expect(complete.output.join(" ")).toContain(DELETE_ADVICE)
    for (const name of ["remove-whatif", "remove-variable-declined"]) {
      const run = setupRun(name)
      expect(run.output.join(" "), name).toContain("were not fully removed. Still in place:")
      expect(run.output.join(" "), name).toContain("Keep Key Vault kv-tenuvault-abc123: this tenant's cloud backup setup was not fully removed")
      expect(run.output.join(" "), name).not.toContain(DELETE_ADVICE)
      expect(run.output, name).not.toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
    }
    // -WhatIf changes nothing; a declined variable is named as left in place.
    expect(setupRun("remove-whatif")).toMatchObject({ actions: [], schedule: true, link: true, legacyVariableKept: true })
    expect(setupRun("remove-variable-declined").output.join(" ")).toContain("Still in place: variable 'TenuVaultScope-11111111'.")
  }, 60_000)

  it.runIf(Boolean(pwsh))("treats a failed -Remove lookup as unverified, not as removed", () => {
    // -WhatIf removes nothing, and every lookup fails with a transport error instead of "not found".
    const run = setupRun("remove-whatif-lookups-fail")
    expect(run).toMatchObject({ schedule: true, link: true, legacyVariableKept: true })
    const text = run.output.join(" ")
    expect(text).toContain("The removal could not be verified. Could not check: the link of 'Invoke-TenuVaultBackup' to 'TenuVaultBackup-11111111' (The SSL connection could not be established.); schedule 'TenuVaultBackup-11111111'")
    expect(text).toContain("variable 'TenuVaultKeyVault-11111111' (The SSL connection could not be established.)")
    expect(text).toContain("Keep Key Vault kv-tenuvault-abc123: the removal of this tenant's cloud backup setup could not be verified")
    expect(text).not.toContain("removed.")
    expect(text).not.toContain(DELETE_ADVICE)
    // A real "not found" still counts as gone.
    expect(setupRun("remove-complete").output.join(" ")).not.toContain("could not be verified")
  }, 60_000)

  it.runIf(Boolean(pwsh))("decides variable absence from one complete list, not from a by-name read the client reports as not found", () => {
    // Az.Automation turns a 403 or 500 on one variable into ResourceNotFoundException. The list still shows the variable.
    const declined = setupRun("remove-scope-read-403-declined")
    expect(declined.variables).toEqual(["TenuVaultScope-11111111"])
    expect(declined.output.join(" ")).toContain("were not fully removed. Still in place: variable 'TenuVaultScope-11111111'.")
    expect(declined.output.join(" ")).toContain("Keep Key Vault kv-tenuvault-abc123: this tenant's cloud backup setup was not fully removed")
    expect(declined.output.join(" ")).not.toContain(DELETE_ADVICE)
    expect(declined.output).not.toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
    // The same misreport during removal does not skip the variable: the list says it exists, so it is removed and verified gone.
    const served = setupRun("remove-scope-read-500")
    expect(served.actions).toContain("remove TenuVaultScope-11111111")
    expect(served.variables).toEqual([])
    expect(served.output).toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
    // The upgrade finds the vault variable through the list too, so it is removed rather than left behind unnoticed.
    const upgrade = setupRun("upgrade-vault-read-translated")
    expect(upgrade).toMatchObject({ plain: true, legacyVariableKept: false })
    expect(upgrade.actions).toContain("remove TenuVaultKeyVault-11111111")
    // A failing list leaves every variable unknown: never removed, never advice.
    const listFails = setupRun("remove-list-fails")
    const text = listFails.output.join(" ")
    expect(text).toContain("The removal could not be verified. Could not check: variable 'TenuVaultTenantId-11111111' (The SSL connection could not be established.)")
    expect(text).toContain("variable 'TenuVaultKeyVault-11111111' (The SSL connection could not be established.)")
    expect(text).toContain("Keep Key Vault kv-tenuvault-abc123: the removal of this tenant's cloud backup setup could not be verified")
    expect(text).not.toContain(DELETE_ADVICE)
    expect(listFails.output).not.toContain("Cloud backup schedule and variables for tenant 11111111-2222-3333-4444-555555555555 removed.")
  }, 60_000)

  it.runIf(Boolean(pwsh))("keeps the vault while another tenant in the Automation account still has its variable, or when that cannot be checked", () => {
    for (const name of ["upgrade-tenant-b-remains", "remove-tenant-b-remains"]) {
      const run = setupRun(name)
      const text = run.output.join(" ")
      expect(run.variables, name).toContain("TenuVaultKeyVault-22222222")
      expect(run.variables, name).not.toContain("TenuVaultKeyVault-11111111")
      expect(text, name).toContain("Keep Key Vault kv-tenuvault-abc123: tenant key(s) 22222222 in Automation account 'aa-tenuvault' still have a TenuVaultKeyVault variable; run this script for those tenants too")
      expect(text, name).not.toContain(DELETE_ADVICE)
    }
    expect(setupRun("upgrade-tenant-b-remains").plain).toBe(true)
    // A failing variable list: the upgrade keeps the vault variable, and the vault, because nothing can be called absent.
    const upgradeListFails = setupRun("upgrade-list-fails")
    expect(upgradeListFails.legacyVariableKept).toBe(true)
    expect(upgradeListFails.output.join(" ")).toContain("Kept 'TenuVaultKeyVault-11111111' if it exists: the Automation account's variables could not be listed (The SSL connection could not be established.)")
    expect(upgradeListFails.output.join(" ")).toContain("Keep Key Vault kv-tenuvault-abc123: the variables of Automation account 'aa-tenuvault' could not be read to check which setups still use it")
    expect(upgradeListFails.output.join(" ")).not.toContain(DELETE_ADVICE)
    // With no TenuVaultKeyVault variable left, the advice stays neutral: it never claims the vault is unused elsewhere.
    const advice = setupRun("approved").output.join(" ")
    expect(advice).toContain("no tenant in Automation account 'aa-tenuvault' still has a TenuVaultKeyVault variable")
    expect(advice).toContain("Delete the vault once no TenuVault setup in this or any other Automation account still has a TenuVaultKeyVault variable")
    expect(advice).not.toContain("is no longer read")
  }, 60_000)

  it("scopes the writer role to the container without delete and prints the paste block", () => {
    expect(setup).toContain('"TenuVault Backup Writer"')
    // Az.Resources 10 exposes Permissions instead of flattened role Actions/DataActions.
    expect(setup).toContain("PSObject.Properties.Name -contains 'Permissions'")
    expect(setup).toContain("$definition.Permissions.Add($permission)")
    expect(setup).toContain("foreach ($permission in $role.Permissions)")
    expect(setup).not.toMatch(/\$extra = @\(\$role\.DataActions/)
    expect(setup).toContain("New-AzRoleAssignment -ObjectId $ObjectId -RoleDefinitionId $RoleDefinitionId")
    expect(setup).toContain("-RoleDefinitionId ([string]$role.Id)")
    // Storage may live outside the Automation resource group; check role access there before writes.
    expect(setup).toContain("$storageGroupScope = ($storageAccount.Id -split '/providers/')[0]")
    expect(setup).toContain("Assert-TenuVaultAuthorizationActions -Scope $storageGroupScope")
    expect(setup.indexOf("Assert-TenuVaultAuthorizationActions -Scope $storageGroupScope")).toBeLessThan(setup.indexOf("New-AzResourceGroup"))
    expect(setup).toContain("Microsoft.Authorization/roleAssignments/write")
    expect(setup).toContain("Microsoft.Authorization/roleDefinitions/write")
    expect(setup).not.toContain("blobs/delete")
    expect(setup).toContain("containers/$backupContainer")
    // The runbook parses with System.Text.Json, which the default 5.1 runtime lacks.
    expect(setup).toContain("-Type PowerShell72")
    expect(setup).toContain("--- TenuVault cloud backup setup (paste into TenuVault) ---")
    expect(setup).toContain("tenantKey=$tenantKey")
  })
})

describe("azuredeploy.json", () => {
  it("creates the same pieces and hands the paste block back, without pretending to grant Graph roles", () => {
    const types = template.resources.map((resource) => resource.type)
    for (const type of [
      "Microsoft.Automation/automationAccounts",
      "Microsoft.Automation/automationAccounts/runbooks",
      "Microsoft.Automation/automationAccounts/schedules",
      "Microsoft.Automation/automationAccounts/jobSchedules",
      "Microsoft.Authorization/roleDefinitions",
    ]) expect(types, type).toContain(type)
    const runbookResource = template.resources.find((resource) => resource.type === "Microsoft.Automation/automationAccounts/runbooks") as unknown as { properties: { runbookType: string } }
    expect(runbookResource.properties.runbookType).toBe("PowerShell72")
    expect(Object.keys(template.outputs)).toContain("pasteIntoTenuVault")
    const paste = (template.outputs.pasteIntoTenuVault as { value: string }).value
    expect(paste).toContain("time=")
    expect(paste).toContain("substring(parameters('scheduleStartTime'), 11, 5)")
    expect(Object.keys(template.outputs)).toContain("graphRolesToAssign")
  })

  it("creates no Key Vault, secret or vault role and takes no recovery key", () => {
    expect(template.resources.filter((resource) => resource.type.startsWith("Microsoft.KeyVault/"))).toEqual([])
    expect(Object.keys(template.parameters)).not.toContain("recoveryKey")
    expect(Object.keys(template.parameters)).not.toContain("keyVaultName")
    expect(Object.values(template.parameters).map((parameter) => (parameter as { type: string }).type)).not.toContain("securestring")
    // The description may name the old vault for upgrades; nothing the template deploys or outputs does.
    const text = JSON.stringify({ ...template, metadata: undefined })
    for (const keyVault of ["keyVault", "TenuVaultKeyVault", "tenuvault-recovery-key", "keyVaultSecretsUserRoleId", "4633458b-17de-408a-b874-0445c86b69e6"]) {
      expect(text, keyVault).not.toContain(keyVault)
    }
    // The vault assignment is gone; the two writer assignments on the containers remain.
    expect(template.resources.filter((resource) => resource.type === "Microsoft.Authorization/roleAssignments")).toHaveLength(2)
  })

  it("lets the identity leave result notes in the watcher's container with the same write-only role", () => {
    const resources = template.resources as unknown as Array<{ type: string; name: string; scope?: string; properties: Record<string, unknown> }>
    const container = resources.find((resource) => resource.type === "Microsoft.Storage/storageAccounts/blobServices/containers")!
    expect(container.name).toContain("variables('outcomeContainer')")
    expect(container.properties.publicAccess).toBe("None")
    expect((template as unknown as { variables: Record<string, string> }).variables.outcomeContainer).toBe("tenuvault-backup-results")
    const assignments = resources.filter((resource) => resource.type === "Microsoft.Authorization/roleAssignments" && resource.scope?.includes("variables('outcomeContainer')"))
    expect(assignments).toHaveLength(1)
    // The writer role it uses never allows delete.
    expect(String(assignments[0]!.properties.roleDefinitionId)).toContain("variables('writerRoleName')")
    const role = resources.find((resource) => resource.type === "Microsoft.Authorization/roleDefinitions")!
    expect(JSON.stringify((role.properties as { permissions: unknown }).permissions)).not.toContain("delete")
  })
})
