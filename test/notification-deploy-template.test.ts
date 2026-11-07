import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { deployWatcherToAzureUrl, parseWatcherSetup } from "../src/shared/notifications/setup"

interface ArmResource {
  type: string
  name: string
  scope?: string
  condition?: string
  properties: Record<string, unknown>
}

const template = JSON.parse(readFileSync(new URL("../resources/notifications/azuredeploy.json", import.meta.url), "utf8")) as {
  parameters: Record<string, { type: string; defaultValue?: unknown; allowedValues?: unknown[] }>
  variables: Record<string, unknown>
  resources: ArmResource[]
  outputs: Record<string, { value: string }>
}
const runbook = readFileSync(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url), "utf8")
const setupScript = readFileSync(new URL("../resources/New-TenuVaultNotificationWatcher.ps1", import.meta.url), "utf8")

const READER = "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1"
const CONTRIBUTOR = "ba92f5b4-2d11-453d-a403-e96b0029c9fe"

describe("the watcher Deploy to Azure template", () => {
  it("deploys the same pieces the setup script creates", () => {
    const types = template.resources.map((resource) => resource.type)
    for (const type of [
      "Microsoft.Automation/automationAccounts",
      "Microsoft.Automation/automationAccounts/runbooks",
      "Microsoft.Automation/automationAccounts/schedules",
      "Microsoft.Automation/automationAccounts/jobSchedules",
      "Microsoft.Automation/automationAccounts/variables",
      "Microsoft.Authorization/roleAssignments",
      "Microsoft.Storage/storageAccounts/blobServices/containers",
      "microsoft.insights/actionGroups",
      "microsoft.insights/metricAlerts",
    ]) expect(types, type).toContain(type)
    const account = template.resources.find((resource) => resource.type === "Microsoft.Automation/automationAccounts") as unknown as { identity: { type: string } }
    expect(account.identity.type).toBe("SystemAssigned")
    // The script imports the runbook as classic PowerShell, not PowerShell 7.2.
    expect(setupScript).toContain("-Type PowerShell ")
    const runbookResource = template.resources.find((resource) => resource.type === "Microsoft.Automation/automationAccounts/runbooks")!
    expect(runbookResource.properties.runbookType).toBe("PowerShell")
    expect(template.parameters.runbookUri?.defaultValue).toBe("https://raw.githubusercontent.com/ugurkocde/TenuVault/main/resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1")
  })

  it("writes every Automation variable the runbook reads, secrets encrypted", () => {
    const read = [...new Set([...runbook.matchAll(/Get-TvAutomationVariable\s+"(TenuVault[A-Za-z]+)"/g)].map((match) => match[1]))]
    expect(read.length).toBeGreaterThanOrEqual(14)
    const written = JSON.stringify(template.resources.filter((resource) => resource.type === "Microsoft.Automation/automationAccounts/variables")) + JSON.stringify(template.variables)
    for (const name of read) expect(written, name).toContain(name)
    for (const secret of ["webhookUrl", "webhookSecret", "teamsWebhookUrl"]) expect(template.parameters[secret]?.type, secret).toBe("securestring")
    const encrypted = template.resources.filter((resource) => resource.type === "Microsoft.Automation/automationAccounts/variables" && resource.properties.isEncrypted === true)
    expect(encrypted.length).toBe(3)
    expect(JSON.stringify(encrypted)).toContain("TenuVaultTeamsWebhookUrl")
    expect(JSON.stringify(encrypted)).toContain("TenuVaultWebhookUrl")
    expect(JSON.stringify(encrypted)).toContain("TenuVaultWebhookSecret")
    // Automation string variables are stored quoted, like the cloud backup template writes them.
    expect(JSON.stringify(template.resources)).toContain("concat('\\\"'")
  })

  it("scopes storage roles to single containers, read for backups and write for state", () => {
    expect(template.variables.blobDataReaderRoleId).toBe(READER)
    expect(template.variables.blobDataContributorRoleId).toBe(CONTRIBUTOR)
    const assignments = template.resources.filter((resource) => resource.type === "Microsoft.Authorization/roleAssignments")
    const byRole = (guid: string) => assignments.filter((resource) => JSON.stringify(resource).includes(guid === READER ? "blobDataReaderRoleId" : "blobDataContributorRoleId"))
    expect(byRole(READER)).toHaveLength(1)
    expect(template.variables.backupContainer).toBe("intune-backups")
    expect(byRole(READER)[0]?.scope).toContain("variables('backupContainer')")
    expect(byRole(CONTRIBUTOR)).toHaveLength(2)
    expect(template.variables.stateContainer).toBe("tenuvault-notification-state")
    expect(template.variables.resultsContainer).toBe("tenuvault-backup-results")
    const contributorScopes = byRole(CONTRIBUTOR).map((resource) => resource.scope).join(" ")
    expect(contributorScopes).toContain("variables('stateContainer')")
    expect(contributorScopes).toContain("variables('resultsContainer')")
    const containers = template.resources.filter((resource) => resource.type === "Microsoft.Storage/storageAccounts/blobServices/containers")
    expect(JSON.stringify(containers)).toContain("variables('stateContainer')")
    expect(JSON.stringify(containers)).toContain("variables('resultsContainer')")
    for (const container of containers) expect(container.properties.publicAccess).toBe("None")
  })

  it("supports sub-hourly watcher schedules as hourly slots, like the script", () => {
    expect(template.parameters.scheduleIntervalMinutes?.allowedValues).toEqual([15, 20, 30, 60, 120, 180, 240])
    expect(template.variables.scheduleName).toBe("TenuVaultNotificationCheck")
    const schedules = JSON.stringify(template.resources.filter((resource) => resource.type.includes("schedules")))
    expect(schedules).toContain("variables('scheduleName')")
    expect(schedules).toContain("copyIndex")
    expect(schedules).toContain("dateTimeAdd")
  })

  it("creates the failure alert only with an address, on failed Automation jobs", () => {
    const group = template.resources.find((resource) => resource.type === "microsoft.insights/actionGroups")!
    const alert = template.resources.find((resource) => resource.type === "microsoft.insights/metricAlerts")!
    expect(group.condition).toContain("alertEmail")
    expect(alert.condition).toContain("alertEmail")
    const alertJson = JSON.stringify(alert)
    expect(alertJson).toContain("TotalJob")
    expect(alertJson).toContain("Failed")
  })

  it("hands back outputs the wizard can read, honestly ungranted", () => {
    expect(Object.keys(template.outputs)).toContain("managedIdentityPrincipalId")
    expect(Object.keys(template.outputs)).toContain("graphRolesToAssign")
    expect(String(template.variables.graphRoles)).toContain("DeviceManagementApps.Read.All")
    expect(String(template.variables.graphRoles)).toContain("AuditLog.Read.All")
    expect(String(template.variables.graphRoles)).toContain("Mail.Send")
    const paste = template.outputs.pasteIntoTenuVault?.value ?? ""
    for (const field of ["tenantId=", "subscriptionId=", "resourceGroup=", "automationAccount=", "storageAccount="]) expect(paste, field).toContain(field)
    // No ARM resource can assign Graph application roles, so the paste block must not claim them.
    expect(paste).toContain("graphRolesGranted=false")
    const example = [
      "tenantId=11111111-1111-4111-8111-111111111111",
      "subscriptionId=22222222-2222-4222-8222-222222222222",
      "resourceGroup=rg-tenuvault-backups",
      "automationAccount=aa-tenuvault-notifications",
      "storageAccount=tvbkp1234567890ab",
      "graphRolesGranted=false",
    ].join("\n")
    expect(parseWatcherSetup(example)?.graphRolesGranted).toBe(false)
  })

  it("points the Deploy to Azure button at the checked in template", () => {
    expect(deployWatcherToAzureUrl()).toBe(
      `https://portal.azure.com/#create/Microsoft.Template/uri/${encodeURIComponent("https://raw.githubusercontent.com/ugurkocde/TenuVault/main/resources/notifications/azuredeploy.json")}`,
    )
  })
})
