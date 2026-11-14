import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { createSelfSignedCertificate } from "../src/main/auth/certificate"
import { knownPermissions, readerRoles, readerScriptArguments, type PermissionChoice } from "../src/shared/services/manifest"

const readerScript = readFileSync(new URL("../resources/New-TenuVaultBackupReader.ps1", import.meta.url), "utf8")
const storageScript = readFileSync(new URL("../resources/New-TenuVaultStorage.ps1", import.meta.url), "utf8")

const override = process.env.TENUVAULT_TEST_POWERSHELL
const powershell = override || ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", join(homedir(), ".local/bin/pwsh")].find(existsSync)

// What the script granted before services could be chosen, written out so a change to the
// permission manifest that moves the default fails here.
const FIVE = ["DeviceManagementApps.Read.All", "DeviceManagementConfiguration.Read.All", "DeviceManagementRBAC.Read.All", "DeviceManagementScripts.Read.All", "DeviceManagementServiceConfig.Read.All"]
const DEVICE_INVENTORY_ROLE = "DeviceManagementManagedDevices.Read.All"
const CONDITIONAL_ACCESS_ROLE = "Policy.Read.All"

/** Script parameters as the harness takes them, from a command line such as " -Services Intune,Entra -IncludeDeviceCategories". */
const parameters = (commandLine: string): Record<string, unknown> =>
  Object.fromEntries([...commandLine.matchAll(/-(\w+)(?: ([^-\s]\S*))?/g)].map((match) => [match[1]!, match[2] ? match[2].split(",") : true]))

describe("New-TenuVaultBackupReader.ps1", () => {
  it("has no write permission anywhere, and adds the device inventory and Conditional Access ones only on request", () => {
    expect(readerScript).not.toMatch(/'[A-Za-z.-]+\.ReadWrite[A-Za-z.]*'/)
    expect(readerScript).toContain(`if ($IncludeDeviceCategories -and $roles -notcontains "${DEVICE_INVENTORY_ROLE}") { $roles += "${DEVICE_INVENTORY_ROLE}" }`)
    expect(readerScript).toContain(`if ($IncludeConditionalAccess -and $roles -notcontains "${CONDITIONAL_ACCESS_ROLE}") { $roles += "${CONDITIONAL_ACCESS_ROLE}" }`)
  })

  it("checks the services and areas before it connects to Microsoft Graph", () => {
    expect(readerScript.indexOf("# END PERMISSION TABLE")).toBeLessThan(readerScript.indexOf("Connect-MgGraph @connectParams"))
    expect(readerScript.indexOf("which belongs to a service that is not in -Services")).toBeLessThan(readerScript.indexOf("Connect-MgGraph @connectParams"))
  })

  it("tells a list that was passed empty from one that was left out, before it connects to Microsoft Graph", () => {
    const check = "if ($PSBoundParameters.ContainsKey($name) -and -not $PSBoundParameters[$name]) { throw \"-$name was given without a value."
    expect(readerScript).toContain(check)
    expect(readerScript.indexOf(check)).toBeLessThan(readerScript.indexOf("Connect-MgGraph @connectParams"))
  })

  describe.runIf(Boolean(powershell))("run against stand-ins for the Microsoft Graph commands", () => {
    function run(args: Record<string, unknown> = {}, state: { existing?: boolean; assigned?: string[] } = {}) {
      const dir = mkdtempSync(join(tmpdir(), "reader-script-"))
      try {
        const file = (name: string) => join(dir, name)
        writeFileSync(file("reader.cer"), createSelfSignedCertificate("TenuVault Backup Reader (TEST)", 365, new Date()).certificatePem)
        writeFileSync(file("arguments.json"), JSON.stringify({ CertificatePath: file("reader.cer"), ...args }))
        writeFileSync(file("state.json"), JSON.stringify({ offered: knownPermissions("application")[0]!.permissions, existing: false, assigned: [], ...state }))
        const result = spawnSync(powershell!, ["-NoProfile", "-NonInteractive", "-File", resolve("test/fixtures/backup-reader/reader-harness.ps1"), "-Script", resolve("resources/New-TenuVaultBackupReader.ps1"), "-ArgumentsFile", file("arguments.json"), "-StateFile", file("state.json"), "-OutputFile", file("calls.json")], { encoding: "utf8", timeout: 60_000 })
        const calls = existsSync(file("calls.json")) ? (JSON.parse(readFileSync(file("calls.json"), "utf8").replace(/^\uFEFF/, "")) as { Name: string; Value: unknown }[]) : []
        const named = (name: string) => calls.filter((call) => call.Name === name).map((call) => call.Value)
        const roles = (values: unknown) => (values as string[]).map((id) => id.replace("role/", ""))
        return { code: result.status, text: result.stdout + result.stderr, calls, declared: roles(named("create")[0] ?? named("update")[0] ?? []), granted: roles(named("grant")), removed: (named("remove") as string[]).map((id) => id.replace("assignment/", "")) }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it.each([resolve("resources/New-TenuVaultBackupReader.ps1"), resolve("test/fixtures/backup-reader/reader-harness.ps1")])("parses %s with no edition-specific syntax", (file) => {
      const result = spawnSync(powershell!, ["-NoProfile", "-File", resolve("test/fixtures/app-registration/parse-script.ps1"), "-Script", file], { encoding: "utf8" })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(0)
    })

    it("grants exactly the five Intune read permissions without parameters, in the order it always has", () => {
      const result = run()
      expect(result.code, result.text).toBe(0)
      expect(result.declared).toEqual(FIVE)
      expect(result.granted).toEqual(FIVE)
      expect(readerRoles()).toEqual(FIVE)
    }, 90_000)

    it.each([
      [{ IncludeDeviceCategories: true }, [...FIVE, DEVICE_INVENTORY_ROLE]],
      [{ IncludeConditionalAccess: true }, [...FIVE, CONDITIONAL_ACCESS_ROLE]],
      [{ IncludeDeviceCategories: true, IncludeConditionalAccess: true }, [...FIVE, DEVICE_INVENTORY_ROLE, CONDITIONAL_ACCESS_ROLE]],
    ])("keeps the existing switches working: %j", (switches, expected) => {
      const result = run(switches)
      expect(result.code, result.text).toBe(0)
      expect(result.declared).toEqual(expected)
      expect(result.granted).toEqual(expected)
    }, 90_000)

    it.each<[string, PermissionChoice]>([
      ["Entra ID alone", { entra: { access: "backup" } }],
      ["Defender alone", { defender: { access: "backup" } }],
      ["Conditional Access alone", { conditionalAccess: { access: "backup" } }],
      ["Intune and Entra ID with two opt-in areas", { intune: { access: "backup" }, entra: { access: "backup", areas: ["groups", "applications"] } }],
      ["every service with every area", { intune: { access: "backup", areas: ["devices"] }, conditionalAccess: { access: "backup" }, entra: { access: "backup", areas: ["groups", "usersAndDevices", "applications"] }, defender: { access: "backup" } }],
    ])("grants what the permission manifest names for %s, from the command the app shows", (_name, choice) => {
      const expected = [...readerRoles(choice)]
      // The command the Backup Reader card builds for a reader with these roles asks for the same roles again.
      const result = run(parameters(readerScriptArguments(expected)))
      expect(result.code, result.text).toBe(0)
      expect([...result.declared].sort()).toEqual([...expected].sort())
      expect([...result.granted].sort()).toEqual([...expected].sort())
      expect(result.declared.some((role) => role.includes("ReadWrite"))).toBe(false)
      // Without the device inventory switch, the roles come in the manifest's own order.
      if (!choice.intune?.areas) expect(result.declared).toEqual(expected)
    }, 90_000)

    it("sets an existing reader to exactly the chosen services: it grants what is missing and removes the rest", () => {
      const entra = [...readerRoles({ entra: { access: "backup" } })]
      const result = run({ Services: ["Entra"] }, { existing: true, assigned: [...FIVE, "Policy.Read.All"] })
      expect(result.code, result.text).toBe(0)
      expect(result.declared).toEqual(entra)
      expect(result.removed).toEqual(FIVE)
      expect(result.granted).toEqual(entra.filter((role) => role !== "Policy.Read.All"))
      expect(result.text).toContain("Removing DeviceManagementApps.Read.All because the services and areas of this run do not need it.")
    }, 90_000)

    it.each([
      [{ Services: [] }, "Services"],
      [{ Areas: [] }, "Areas"],
      [{ Services: ["Entra"], Areas: [] }, "Areas"],
    ])("refuses a list that was passed empty, which is not the default, before it signs in: %j", (args, parameter) => {
      const result = run(args)
      expect(result.code).toBe(1)
      expect(result.text).toContain(`-${parameter} was given without a value. Name at least one, or leave -${parameter} out. Nothing was changed.`)
      expect(result.calls).toEqual([])
    }, 90_000)

    it("refuses an area whose service was not chosen, before it signs in", () => {
      const result = run({ Areas: ["Groups"] })
      expect(result.code).toBe(1)
      expect(result.text).toContain("-Areas names Groups, which belongs to a service that is not in -Services. Nothing was changed.")
      expect(result.calls).toEqual([])
    }, 90_000)
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
    // First setup has no existing certificates: the mapping must stay an empty array, never a
    // one-element list holding an empty entry, or Graph can reject the KeyCredentials list.
    expect(readerScript).toContain("$existing = @($keys | ForEach-Object {")
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
    expect(storageScript).toContain("New-AzRoleAssignment -ObjectId $reader.Id -RoleDefinitionId $role.Id -Scope $containerScope")
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
