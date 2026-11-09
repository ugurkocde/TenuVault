import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { COMPLIANCE_SETTING_KEYS, COMPLIANCE_SETTINGS_ID } from "../src/shared/intune/compliance-settings"
import { PLAIN_CLOUD_RUNBOOK, cloudRunbookNeedsUpgrade, cloudStatusBlobName, parseCloudStatus } from "../src/shared/cloud-backup"

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))

const runbook = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url), "utf8")
const setup = readFileSync(new URL("../resources/New-TenuVaultCloudBackup.ps1", import.meta.url), "utf8")
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
    for (const sealing of ['"TVAZ1`n"', "HKDF", "AesGcm", "tenuvault-azure-backup-v1", "tenuvault-recovery-key", "vault.azure.net", "application/octet-stream"]) {
      expect(runbook, sealing).not.toContain(sealing)
    }
    expect(runbook).not.toMatch(/Get-TvRequiredVariable "TenuVaultKeyVault"/)
    expect(runbook).not.toMatch(/Set-TvSealedBlob|Protect-TvAzureBlob|Get-TvRecoveryMasterKey/)
    // Every backup container write goes through one helper, as JSON.
    expect(runbook.match(/Invoke-TvHttp -Uri \$target\.Uri -Token \$Token -Method "Put"/g)).toHaveLength(1)
    expect(runbook).toContain('-BodyBytes ([Text.Encoding]::UTF8.GetBytes($Body)) -ContentType "application/json"')
    expect(runbook).toContain('headers["If-None-Match"] = "*"')
  })

  it("carries the first plain runbook version, which the app does not flag for upgrade", () => {
    const version = /\$script:RunbookVersion = "([^"]+)"/.exec(runbook)?.[1]
    expect(version).toBe(PLAIN_CLOUD_RUNBOOK)
    expect(cloudRunbookNeedsUpgrade(version!)).toBe(false)
    expect(cloudRunbookNeedsUpgrade("1.1.0")).toBe(true)
    expect(cloudRunbookNeedsUpgrade("1.0.0")).toBe(true)
    expect(cloudRunbookNeedsUpgrade("0.9.9")).toBe(true)
    expect(cloudRunbookNeedsUpgrade("1.10.0")).toBe(false)
    expect(cloudRunbookNeedsUpgrade("2.0.0")).toBe(false)
    expect(cloudRunbookNeedsUpgrade("")).toBe(false)
    expect(cloudRunbookNeedsUpgrade("desktop")).toBe(false)
  })

  it.runIf(Boolean(pwsh))("puts only plain JSON blobs during a run, records early failures and never calls Key Vault", () => {
    const script = fileURLToPath(new URL("./fixtures/cloud-backup/plain-run.ps1", import.meta.url))
    const [run, failed] = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { calls: Array<{ uri: string; method: string; contentType: string | null; ifNoneMatch: string | null; body: string | null }>; error?: string | null })
    for (const scenario of [run!, failed!]) {
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
    expect(metadata).toMatchObject({ Status: "Success", RunbookVersion: PLAIN_CLOUD_RUNBOOK, Source: "TenuVault Cloud Backup", TenantId: "11111111-2222-3333-4444-555555555555" })
    const status = JSON.parse(puts.find((call) => call.uri.endsWith("/cloud-backup-status-11111111.json"))!.body!)
    expect(parseCloudStatus(status, "11111111-2222-3333-4444-555555555555")).toMatchObject({ lastStatus: "Success", runbookVersion: PLAIN_CLOUD_RUNBOOK })
    // A run that fails before any backup write still records why, in the status blob and the note.
    expect(failed!.error).toContain("managed identity token")
    const failedStatus = failed!.calls.find((call) => call.method === "Put" && call.uri.endsWith("/cloud-backup-status-11111111.json"))
    expect(parseCloudStatus(JSON.parse(failedStatus!.body!), "11111111-2222-3333-4444-555555555555")).toMatchObject({ lastStatus: "Failed" })
    expect(failed!.calls.some((call) => call.method === "Put" && call.uri.includes("/tenuvault-backup-results/cloud-backup-outcomes/run-"))).toBe(true)
    expect(failed!.calls.some((call) => call.uri.includes("/intune-backups/backup-"))).toBe(false)
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
    const removal = setup.indexOf("-Name $legacyKeyVaultVariable | Out-Null")
    expect(removal).toBeGreaterThan(setup.indexOf('Set-TenuVaultAutomationVariable -Name "TenuVaultAppOnlyExcluded-$tenantKey"'))
    expect(setup).toContain("Publish-AzAutomationRunbook")
    // -Remove deletes it too and, like a rerun, names the old vault before it is gone.
    expect(setup).toContain("foreach ($name in @($variableNames) + $legacyKeyVaultVariable)")
    const removeMode = setup.slice(setup.indexOf("if ($Remove) {\n    $account"), setup.indexOf("# Resource group and Automation account"))
    expect(removeMode.indexOf("$legacyKeyVaults = Get-TenuVaultLegacyKeyVaults")).toBeLessThan(removeMode.indexOf("Remove-AzAutomationVariable"))
    expect(removeMode).toContain("Write-TenuVaultLegacyKeyVaultNote $legacyKeyVaults")
    expect(setup).toContain('-ResourceType "Microsoft.KeyVault/vaults"')
    expect(setup).toContain('$_.Name -like "kv-tenuvault-*"')
    expect(setup).toContain("Delete it once no setup uses it")
    expect(setup).toContain("open in TenuVault with it")
  })

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
    const text = JSON.stringify(template)
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
