import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildSetupAlerts, parseWatcherSetup, setupState, setupWatchNeeds, watcherSetupCommand } from "../src/shared/notifications/setup"

const TENANT = "11111111-1111-4111-8111-111111111111"

describe("the recommended setup alerts", () => {
  it("builds backup problems, risky changes and Conditional Access alerts from the default choices", () => {
    const alerts = buildSetupAlerts({ backups: true, riskyChanges: true, conditionalAccess: true })
    expect(alerts.map((alert) => alert.title)).toEqual([
      "Backup and restore problems",
      "Deletions and removed assignments",
      "Conditional Access changes",
    ])
    expect(alerts[0]).toMatchObject({
      eventTypes: ["backup.failed", "backup.warning", "backup.missed", "restore.failed", "restore.partial"],
      minSeverity: "info",
      delivery: "digest",
      conditions: null,
    })
    // Successful backups are noise and stay out of the one-click setup.
    expect(alerts[0]!.eventTypes).not.toContain("backup.succeeded")
    expect(alerts[1]).toMatchObject({
      eventTypes: ["intune.change", "entra.change"],
      delivery: "each",
      conditions: { changeTypes: ["deleted", "unassigned"] },
    })
    expect(alerts[2]).toMatchObject({ eventTypes: ["entra.change"], delivery: "each", conditions: null })
  })

  it("builds only what was picked, and nothing when nothing was picked", () => {
    expect(buildSetupAlerts({ backups: true, riskyChanges: false, conditionalAccess: false }).map((alert) => alert.title)).toEqual(["Backup and restore problems"])
    expect(buildSetupAlerts({ backups: false, riskyChanges: false, conditionalAccess: false })).toEqual([])
    expect(setupWatchNeeds({ backups: true, riskyChanges: false, conditionalAccess: false })).toEqual({ intune: false, conditionalAccess: false })
    expect(setupWatchNeeds({ backups: false, riskyChanges: true, conditionalAccess: false })).toEqual({ intune: true, conditionalAccess: true })
    expect(setupWatchNeeds({ backups: false, riskyChanges: false, conditionalAccess: true })).toEqual({ intune: false, conditionalAccess: true })
  })
})

describe("setup state", () => {
  const channel = { id: "c1", enabled: true }
  const rule = { enabled: true, channelIds: ["c1"], eventTypes: ["backup.failed"] }

  it("reports a fresh tenant as not set up, with the missing steps in order", () => {
    const state = setupState({ channels: [], rules: [], auditWatch: null })
    expect(state.complete).toBe(false)
    expect(state.hasDestination).toBe(false)
    expect(state.hasWorkingAlert).toBe(false)
    expect(state.missing).toEqual(["destination", "alert"])
  })

  it("needs an enabled alert that sends to an enabled channel, not just records", () => {
    expect(setupState({ channels: [{ ...channel, enabled: false }], rules: [rule], auditWatch: null }).hasWorkingAlert).toBe(false)
    expect(setupState({ channels: [channel], rules: [{ ...rule, enabled: false }], auditWatch: null }).hasWorkingAlert).toBe(false)
    expect(setupState({ channels: [channel], rules: [{ ...rule, channelIds: ["gone"] }], auditWatch: null }).hasWorkingAlert).toBe(false)
    const done = setupState({ channels: [channel], rules: [rule], auditWatch: null })
    expect(done.hasWorkingAlert).toBe(true)
    expect(done.complete).toBe(true)
    expect(done.missing).toEqual([])
  })

  it("reports change watching only for the services a working alert listens to", () => {
    const changeRule = { enabled: true, channelIds: ["c1"], eventTypes: ["intune.change"] }
    const state = setupState({ channels: [channel], rules: [changeRule], auditWatch: { enabled: false, conditionalAccess: { enabled: true }, externalWatcher: false } })
    expect(state.watching).toEqual({ intune: false, conditionalAccess: null })
    expect(state.missing).toEqual(["intune-watching"])
    expect(state.complete).toBe(false)
    // An Azure watcher that owns the tenant counts as watching, whoever polls.
    const azure = setupState({ channels: [channel], rules: [changeRule], auditWatch: { enabled: false, conditionalAccess: { enabled: false }, externalWatcher: true } })
    expect(azure.watching.intune).toBe(true)
    expect(azure.azureWatcher).toBe(true)
    expect(azure.complete).toBe(true)
  })
})

describe("the Azure watcher setup command", () => {
  it("fills in everything the app already knows and asks for the failure alert", () => {
    const command = watcherSetupCommand({
      tenantId: TENANT,
      storageAccount: "tvbkp1234567890ab",
      resourceGroup: "rg-tenuvault-backups",
      location: "westeurope",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      alertEmail: "ops@contoso.com",
      includeConditionalAccess: true,
    })
    expect(command).toBe(
      `./New-TenuVaultNotificationWatcher.ps1 -TenantId ${TENANT} -StorageAccountName tvbkp1234567890ab -ResourceGroupName rg-tenuvault-backups -Location westeurope -SubscriptionId 22222222-2222-4222-8222-222222222222 -AlertEmail ops@contoso.com -GrantGraphRoles -IncludeConditionalAccess`,
    )
  })

  it("leaves a visible placeholder instead of guessing a failure-alert address, and never carries a secret", () => {
    const command = watcherSetupCommand({ tenantId: TENANT, storageAccount: "tvbkp1234567890ab", includeConditionalAccess: false })
    expect(command).toContain("-AlertEmail <failure-alert-email>")
    expect(command).not.toContain("-IncludeConditionalAccess")
    expect(command).not.toContain("Webhook")
    expect(command).not.toContain("Teams")
  })

  it("quotes values that need it for PowerShell", () => {
    const command = watcherSetupCommand({ tenantId: TENANT, storageAccount: "tvbkp1234567890ab", resourceGroup: "rg o'brien", includeConditionalAccess: false })
    expect(command).toContain(`-ResourceGroupName 'rg o''brien'`)
  })
})

describe("the watcher setup paste-back block", () => {
  const block = [
    "--- TenuVault notification watcher setup (paste into TenuVault) ---",
    `tenantId=${TENANT}`,
    "storageAccount=tvbkp1234567890ab",
    "automationAccount=aa-tenuvault-notifications",
    "resourceGroup=rg-tenuvault-backups",
    "subscriptionId=22222222-2222-4222-8222-222222222222",
    "graphRolesGranted=true",
  ].join("\n")

  it("parses the block the setup script prints", () => {
    expect(parseWatcherSetup(block)).toEqual({
      tenantId: TENANT,
      storageAccount: "tvbkp1234567890ab",
      automationAccount: "aa-tenuvault-notifications",
      resourceGroup: "rg-tenuvault-backups",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      graphRolesGranted: true,
    })
  })

  it("keeps an ungranted setup visible instead of calling it done", () => {
    expect(parseWatcherSetup(block.replace("graphRolesGranted=true", "graphRolesGranted=false"))?.graphRolesGranted).toBe(false)
  })

  it("matches the block the watcher setup script prints", () => {
    const script = readFileSync(new URL("../resources/New-TenuVaultNotificationWatcher.ps1", import.meta.url), "utf8")
    expect(script).toContain("--- TenuVault notification watcher setup (paste into TenuVault) ---")
    for (const field of ["tenantId=$TenantId", "subscriptionId=$($context.Subscription.Id)", "resourceGroup=$ResourceGroupName", "automationAccount=$AutomationAccountName", "storageAccount=$StorageAccountName", "graphRolesGranted=$(([bool]$consentReceipt)"]) {
      expect(script).toContain(field)
    }
    // Only a real run prints it: a WhatIf dry run must not hand over to a watcher it did not create.
    expect(script).toContain("if (-not $WhatIfPreference)")
  })

  it("rejects text that cannot be a watcher setup", () => {
    expect(parseWatcherSetup("hello")).toBeNull()
    expect(parseWatcherSetup(block.replace(TENANT, "not-a-guid"))).toBeNull()
    expect(parseWatcherSetup(block.replace("tvbkp1234567890ab", "Not A Storage Name"))).toBeNull()
    expect(parseWatcherSetup(block.replace("automationAccount=aa-tenuvault-notifications\n", ""))).toBeNull()
  })
})
