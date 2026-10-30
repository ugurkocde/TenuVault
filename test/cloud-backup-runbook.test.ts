import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { COMPLIANCE_SETTING_KEYS, COMPLIANCE_SETTINGS_ID } from "../src/shared/intune/compliance-settings"
import { cloudStatusBlobName } from "../src/shared/cloud-backup"

const runbook = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url), "utf8")
const setup = readFileSync(new URL("../resources/New-TenuVaultCloudBackup.ps1", import.meta.url), "utf8")
const azureSeal = readFileSync(new URL("../src/main/storage/azure-seal.ts", import.meta.url), "utf8")
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
  it("seals with the same TVAZ1 envelope as the desktop app", () => {
    expect(azureSeal).toContain("'tenuvault-azure-backup-v1'")
    expect(runbook).toContain('"tenuvault-azure-backup-v1"')
    expect(runbook).toContain('"TVAZ1`n"')
    expect(runbook).toContain("HKDF")
    expect(runbook).toContain("AesGcm")
    expect(runbook).toContain("tenuvault-recovery-key")
    // Every storage write goes through the sealed path; no plaintext PUT helper exists.
    expect(runbook.match(/Invoke-TvHttp -Uri \$target\.Uri -Token \$Token -Method "Put"/g)).toHaveLength(1)
    expect(runbook).toContain('headers["If-None-Match"] = "*"')
  })

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
    // Single-argument AesGcm ctor: the Automation 7.2 runtime (.NET 6) lacks the tag size one.
    expect(runbook).toContain("[Security.Cryptography.AesGcm]::new($key)")
    expect(runbook).not.toContain("AesGcm]::new($key, 16)")
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

  it("keeps the recovery key off the command line and refuses to guess about alerting", () => {
    expect(setup).toContain("Read-Host")
    expect(setup).toContain("-AsSecureString")
    expect(setup).not.toMatch(/\[string\]\$RecoveryKey/)
    expect(setup).toContain("-NoFailureAlert")
    expect(setup).toContain("Decide how failed cloud backups will be noticed")
  })

  it("scopes the writer role to the container without delete and prints the paste block", () => {
    expect(setup).toContain('"TenuVault Backup Writer"')
    expect(setup).not.toContain("blobs/delete")
    expect(setup).toContain("containers/$backupContainer")
    // The runbook needs the .NET HKDF and AesGcm types, which the default 5.1 runtime lacks.
    expect(setup).toContain("-Type PowerShell72")
    expect(setup).toContain("Key Vault Secrets User")
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
      "Microsoft.KeyVault/vaults",
      "Microsoft.KeyVault/vaults/secrets",
      "Microsoft.Authorization/roleDefinitions",
    ]) expect(types, type).toContain(type)
    const runbookResource = template.resources.find((resource) => resource.type === "Microsoft.Automation/automationAccounts/runbooks") as unknown as { properties: { runbookType: string } }
    expect(runbookResource.properties.runbookType).toBe("PowerShell72")
    expect((template.parameters.recoveryKey as { type: string }).type).toBe("securestring")
    expect(Object.keys(template.outputs)).toContain("pasteIntoTenuVault")
    const paste = (template.outputs.pasteIntoTenuVault as { value: string }).value
    expect(paste).toContain("time=")
    expect(paste).toContain("substring(parameters('scheduleStartTime'), 11, 5)")
    expect(Object.keys(template.outputs)).toContain("graphRolesToAssign")
  })
})
