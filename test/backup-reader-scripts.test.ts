import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEVICE_INVENTORY_ROLE, READER_REQUIRED_ROLES } from "../src/main/auth/backup-reader"

const readerScript = readFileSync(new URL("../resources/New-TenuVaultBackupReader.ps1", import.meta.url), "utf8")
const storageScript = readFileSync(new URL("../resources/New-TenuVaultStorage.ps1", import.meta.url), "utf8")

/** The quoted names in the script's $roles array. */
function scriptRoles(): string[] {
  const block = /\$roles = @\(([\s\S]*?)\)/.exec(readerScript)![1]!
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
}

describe("New-TenuVaultBackupReader.ps1", () => {
  it("grants exactly the read permissions the app requires, and the device inventory one only on request", () => {
    expect(scriptRoles().sort()).toEqual([...READER_REQUIRED_ROLES].sort())
    expect(readerScript).toContain(`if ($IncludeDeviceCategories) { $roles += "${DEVICE_INVENTORY_ROLE}" }`)
    expect(scriptRoles().some((role) => role.includes("ReadWrite"))).toBe(false)
  })

  it("removes any other permission granted to the reader", () => {
    expect(readerScript).toContain("Remove-MgServicePrincipalAppRoleAssignment")
    expect(readerScript).toContain("$keep = $assignment.ResourceId -eq $graph.Id -and ($wanted.Id -contains $assignment.AppRoleId)")
  })

  it("uses certificates only: it never creates a client secret and refuses a file with a private key", () => {
    expect(readerScript).not.toMatch(/Add-MgApplicationPassword|PasswordCredential\s*=/)
    expect(readerScript).toContain("$certificate.HasPrivateKey")
    expect(readerScript).toContain('Type        = "AsymmetricX509Cert"')
  })

  it("keeps existing certificates when adding one, for renewals and further computers", () => {
    expect(readerScript).toContain("Update-MgApplication -ApplicationId $app.Id -KeyCredentials @(@($existing) + $new)")
    // Graph refuses a list that changes an existing certificate (KeyNotUpdatable), and only a read that
    // selects keyCredentials returns their key bytes. Verified against a lab tenant.
    expect(readerScript).toContain('Get-MgApplication -ApplicationId $app.Id -Property "keyCredentials"')
    for (const property of ["CustomKeyIdentifier", "EndDateTime", "Key ", "KeyId", "StartDateTime"]) expect(readerScript).toContain(`            ${property}`)
    expect(readerScript).toContain("if ($keys | Where-Object { -not $_.Key })")
  })

  it("recognizes a certificate that is already uploaded by its bytes", () => {
    expect(readerScript).toContain("[Convert]::ToBase64String($_.Key) -eq $raw")
  })

  it("validates the certificate before connecting to Microsoft Graph", () => {
    expect(readerScript.indexOf("$certificate.NotAfter -le (Get-Date)")).toBeLessThan(readerScript.indexOf("Connect-MgGraph"))
  })
})

describe("New-TenuVaultStorage.ps1 -BackupReaderAppId", () => {
  const role = /\$dataActions = @\(([\s\S]*?)\)/.exec(storageScript)![1]!

  it("lets the reader read and write blobs but never delete them", () => {
    expect(role).toContain("blobs/read")
    expect(role).toContain("blobs/write")
    expect(role).not.toMatch(/delete|deleteBlobVersion|containers\/write/i)
    expect(storageScript).toContain("$definition.Actions = @()")
  })

  it("assigns the role on the backup container only", () => {
    expect(storageScript).toContain('$containerScope = "$($account.Id)/blobServices/default/containers/$container"')
    expect(storageScript).toContain("New-AzRoleAssignment -ObjectId $reader.Id -RoleDefinitionName $roleName -Scope $containerScope")
  })

  it("creates the container, since the reader cannot", () => {
    expect(storageScript).toContain("New-AzRmStorageContainer -ResourceGroupName $ResourceGroupName -StorageAccountName $StorageAccountName -Name $container")
  })

  it("turns on versioning and ages out previous versions only, never current backups", () => {
    expect(storageScript).toContain("-IsVersioningEnabled $true")
    expect(storageScript).toContain("Add-AzStorageAccountManagementPolicyAction -BlobVersionAction Delete")
    expect(storageScript).not.toContain("-BaseBlobAction Delete")
  })

  it("refuses to reuse a custom role that allows more than writing backups", () => {
    expect(storageScript).toContain("allows more than writing backups")
  })
})
