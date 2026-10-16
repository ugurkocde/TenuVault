import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const storageScript = readFileSync(new URL("../resources/New-TenuVaultStorage.ps1", import.meta.url), "utf8")
const desktopScript = readFileSync(new URL("../resources/New-TenuVaultDesktopApp.ps1", import.meta.url), "utf8")
const createStoragePage = readFileSync(
  new URL("../docs-site/src/content/docs/getting-started/create-storage-account.md", import.meta.url),
  "utf8",
)

describe("New-TenuVaultStorage.ps1", () => {
  it("assigns both roles TenuVault needs to the admin group, not to an individual", () => {
    expect(storageScript).toContain("[Parameter(Mandatory)][string]$AdminGroupId")
    expect(storageScript).toContain('"Reader", "Storage Blob Data Contributor"')
    expect(storageScript).toContain("New-AzRoleAssignment -ObjectId $AdminGroupId")
    // Existing assignments are detected so a rerun stays a no-op.
    expect(storageScript).toContain("Get-AzRoleAssignment -ObjectId $AdminGroupId")
  })

  it("hardens the account the way the docs promise", () => {
    for (const setting of [
      'MinimumTlsVersion     = "TLS1_2"',
      "AllowBlobPublicAccess = $false",
      "AllowSharedKeyAccess  = $false",
      "EnableHttpsTrafficOnly = $true",
      "StorageV2",
      "Enable-AzStorageBlobDeleteRetentionPolicy",
      "Enable-AzStorageContainerDeleteRetentionPolicy",
      "-RetentionDays 7",
    ]) {
      expect(storageScript).toContain(setting)
    }
    expect(createStoragePage).toContain("New-TenuVaultStorage.ps1")
    // Update-AzStorageBlobServiceProperty has no retention parameters; the Enable cmdlets are the supported call.
    expect(storageScript).not.toContain("Update-AzStorageBlobServiceProperty")
  })

  it("adds firewall addresses before switching the default action to deny", () => {
    const addAt = storageScript.indexOf("Add-AzStorageAccountNetworkRule")
    const denyAt = storageScript.indexOf("-DefaultAction Deny -Bypass AzureServices")
    expect(addAt).toBeGreaterThan(0)
    expect(denyAt).toBeGreaterThan(addAt)
    // Azure rejects private, IPv6 and /31 or /32 rules; the script refuses them up front.
    expect(storageScript).toContain("AddressFamily")
    expect(storageScript).toContain("$prefix -gt 30")
    expect(storageScript).toContain("PublicNetworkAccess")
  })

  it("warns at runtime that PIM eligible assignments do not satisfy scheduled backups", () => {
    // The warning must be printed when the script runs, not only sit in comment help.
    expect(storageScript).toContain('Write-Host "active: a PIM eligible assignment that nobody activated makes scheduled backups fail."')
    expect(storageScript).toContain("Firewall:")
    expect(storageScript).toContain("open to all networks")
  })

  it("derives the default account name with APIs that exist in Windows PowerShell 5.1", () => {
    expect(storageScript).not.toContain("HashData")
    expect(storageScript).not.toContain("ToHexString")
    expect(storageScript).toContain("ComputeHash")
  })

  it("validates the group id and firewall addresses before connecting to Azure", () => {
    const validationAt = storageScript.indexOf("TryParse")
    const connectAt = storageScript.indexOf("Connect-AzAccount")
    expect(validationAt).toBeGreaterThan(0)
    expect(connectAt).toBeGreaterThan(validationAt)
  })

  it("stops cleanly under WhatIf instead of dereferencing a missing account", () => {
    expect(storageScript).toContain("if (-not $account) {")
    expect(storageScript).toContain("What if: nothing was changed.")
  })

  it("keeps the firewall open unless addresses are explicitly named", () => {
    const firewallAt = storageScript.indexOf("if ($AllowIpAddresses)")
    const denyAt = storageScript.indexOf("-DefaultAction Deny")
    expect(firewallAt).toBeGreaterThan(0)
    expect(denyAt).toBeGreaterThan(firewallAt)
  })
})

describe("New-TenuVaultDesktopApp.ps1", () => {
  it("no longer mentions an Automation account the desktop app does not use", () => {
    expect(desktopScript).not.toContain("Automation Contributor")
    expect(desktopScript).not.toContain("Azure Automation")
    expect(desktopScript).toContain("New-TenuVaultStorage.ps1")
  })

  it("names the Connect tenant button the app shows", () => {
    expect(desktopScript).toContain("TenuVault > Tenants > Connect tenant")
    expect(desktopScript).not.toContain("Add tenant")
  })

  it("installs and imports every Graph module at the Microsoft.Graph.Authentication version", () => {
    expect(desktopScript).toContain("Install-Module $module -RequiredVersion $graphVersion")
    expect(desktopScript).toContain("Import-Module $module -RequiredVersion $graphVersion")
    expect(desktopScript).toContain("Open a new PowerShell window and run the script again.")
    expect(desktopScript.indexOf("Import-Module $module -RequiredVersion $graphVersion")).toBeLessThan(desktopScript.indexOf("Connect-MgGraph"))
    expect(desktopScript).toContain(`Get-Module -Name "Microsoft.Graph.*" | Where-Object Version -ne $graphVersion`)
    expect(desktopScript.indexOf("is already loaded in this PowerShell session")).toBeLessThan(desktopScript.indexOf("Install-Module $module -RequiredVersion $graphVersion"))
    expect(desktopScript).toContain("Check that the PowerShell Gallery is reachable")
  })
})
