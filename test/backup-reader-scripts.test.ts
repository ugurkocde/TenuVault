import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { createSelfSignedCertificate } from "../src/main/auth/certificate"
import { knownPermissions, READER_ALLOWED_ROLES, readerRoles, readerScriptArguments, type PermissionChoice } from "../src/shared/services/manifest"

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

    const READER_APP = "44444444-4444-4444-8444-444444444444"
    const ENTRA = [...readerRoles({ entra: { access: "backup" } })]
    it.each<[string, string[]]>([
      ["one Entra ID permission alone", ["Domain.Read.All"]],
      ["Intune and one directory permission next to it", [...FIVE, "Directory.Read.All"]],
      ["Intune and Entra ID short of one permission", [...FIVE, ...ENTRA.filter((role) => role !== "Agreement.Read.All")]],
      ["the device inventory permission without the rest of Intune", [DEVICE_INVENTORY_ROLE, CONDITIONAL_ACCESS_ROLE]],
      ["no permission at all", []],
    ])("renews a reader that holds %s without changing its permissions, from the command the app shows", (_name, held) => {
      const command = readerScriptArguments(held)
      expect(command).toContain(" -Permissions ")
      // A renewal: the reader exists and holds exactly these permissions.
      const renewal = run({ AppId: READER_APP, ...parameters(command) }, { existing: true, assigned: held })
      expect(renewal.code, renewal.text).toBe(0)
      expect(renewal.declared).toEqual([...held].sort())
      expect(renewal.granted).toEqual([])
      expect(renewal.removed).toEqual([])
      expect(renewal.text).not.toContain("Removing")
      expect(renewal.calls.filter((call) => call.Name === "certificate")).toHaveLength(1)
      // The same command on a new app registration grants exactly these permissions, and no default on top.
      const fresh = run(parameters(command))
      expect(fresh.code, fresh.text).toBe(0)
      expect(fresh.declared).toEqual([...held].sort())
      expect(fresh.granted).toEqual([...held].sort())
    }, 90_000)

    it("sets a reader that drifted back to exactly the permissions it is given, and says why it removes one", () => {
      const result = run({ AppId: READER_APP, Permissions: ["Domain.Read.All", CONDITIONAL_ACCESS_ROLE] }, { existing: true, assigned: [...FIVE, CONDITIONAL_ACCESS_ROLE] })
      expect(result.code, result.text).toBe(0)
      expect(result.declared).toEqual(["Domain.Read.All", CONDITIONAL_ACCESS_ROLE])
      expect(result.granted).toEqual(["Domain.Read.All"])
      expect(result.removed).toEqual(FIVE)
      expect(result.text).toContain("Removing DeviceManagementApps.Read.All because -Permissions does not name it.")
      expect(result.text).toContain("Run the script again with DeviceManagementApps.Read.All in -Permissions to keep it.")
    }, 90_000)

    it("accepts every permission a Backup Reader may hold for -Permissions, and still adds what a switch asks for", () => {
      const all = run({ Permissions: [...READER_ALLOWED_ROLES] })
      expect(all.code, all.text).toBe(0)
      expect(all.declared).toEqual([...READER_ALLOWED_ROLES].sort())
      expect(all.declared.some((role) => role.includes("ReadWrite"))).toBe(false)
      const switched = run({ Permissions: ["Domain.Read.All"], IncludeConditionalAccess: true })
      expect(switched.code, switched.text).toBe(0)
      expect(switched.declared).toEqual(["Domain.Read.All", CONDITIONAL_ACCESS_ROLE])
    }, 90_000)

    it.each([
      [{ Permissions: ["Mail.Read"] }, "-Permissions names Mail.Read, which is not a read permission a Backup Reader may hold. Nothing was changed."],
      [{ Permissions: [CONDITIONAL_ACCESS_ROLE, "DeviceManagementApps.ReadWrite.All"] }, "-Permissions names DeviceManagementApps.ReadWrite.All, which is not a read permission a Backup Reader may hold. Nothing was changed."],
      [{ Permissions: [CONDITIONAL_ACCESS_ROLE, "Policy.ReadWrite.ConditionalAccess"] }, "-Permissions names Policy.ReadWrite.ConditionalAccess, which is not a read permission a Backup Reader may hold. Nothing was changed."],
      [{ Permissions: [CONDITIONAL_ACCESS_ROLE], Services: ["Entra"] }, "-Permissions names the reader's permissions one by one and cannot be combined with -Services or -Areas. Nothing was changed."],
      [{ Permissions: ["None", CONDITIONAL_ACCESS_ROLE] }, "-Permissions None cannot be combined with a permission. Nothing was changed."],
      [{ Permissions: [] }, "-Permissions was given without a value. Name at least one, or leave -Permissions out. Nothing was changed."],
    ])("refuses -Permissions it cannot grant as a read-only reader, before it signs in: %j", (args, message) => {
      const result = run(args, { existing: true, assigned: FIVE })
      expect(result.code).toBe(1)
      expect(result.text).toContain(message)
      expect(result.calls).toEqual([])
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

    it("says why it removes the Conditional Access permission: the services when -Services was passed, the switch when it was not", () => {
      const assigned = [...FIVE, CONDITIONAL_ACCESS_ROLE]
      const switchOnly = "Removing Policy.Read.All because -IncludeConditionalAccess was not given."
      // The reader was set up for Intune and Entra ID, and is now set to Intune alone.
      const named = run({ Services: ["Intune"] }, { existing: true, assigned })
      expect(named.code, named.text).toBe(0)
      expect(named.removed).toEqual([CONDITIONAL_ACCESS_ROLE])
      const text = named.text.replace(/\s+/g, " ")
      expect(text).toContain("Removing Policy.Read.All because no service in -Services needs it and -IncludeConditionalAccess was not given.")
      expect(text).toContain("Run the script again with ConditionalAccess or Entra in -Services, or with -IncludeConditionalAccess, to keep it.")
      expect(text).not.toContain(switchOnly)
      // Without -Services the switch is the only way the reader gets it, as before.
      const plain = run({}, { existing: true, assigned })
      expect(plain.removed).toEqual([CONDITIONAL_ACCESS_ROLE])
      expect(plain.text.replace(/\s+/g, " ")).toContain(`${switchOnly} Every computer using this reader must verify it again in TenuVault. Run the script again with -IncludeConditionalAccess to keep it.`)
      // A service that reads Entra policies keeps it, and so does the switch.
      for (const args of [{ Services: ["Intune", "ConditionalAccess"] }, { Services: ["Intune"], IncludeConditionalAccess: true }]) {
        const kept = run(args, { existing: true, assigned })
        expect(kept.removed, JSON.stringify(args)).toEqual([])
        expect(kept.text).not.toContain("Removing")
      }
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
