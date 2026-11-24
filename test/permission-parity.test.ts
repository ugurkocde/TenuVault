import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DESKTOP_APP_PERMISSIONS, setupHandoffText } from "../src/shared/app-registration"
import {
  DEFAULT_SETUP_CHOICE, graphPermissions, knownPermissions, READER_ALLOWED_ROLES, readerRequiredRoles, readerRoles, readerScriptArguments, requestedPermissions, SCRIPT_SERVICE, type PermissionChoice,
} from "../src/shared/services/manifest"
import { areaNeed, DEFAULT_SELECTION, MODULES, MODULE_BY_ID, type ModuleId } from "../src/shared/services/modules"
import { OPTIONAL_PERMISSIONS } from "../src/shared/services/optional-permissions"
import { readerView } from "../src/renderer/lib/backup-reader-view"
import type { BackupReaderStatus } from "../src/shared/ipc"
import { ARTIFACTS, currentBody, SCRIPT_AREAS, SCRIPT_SERVICES, writeArtifact } from "./permission-artifacts"

/**
 * Everything that lists permissions outside the permission manifest is compared with it here. A
 * difference fails: in the app's own lists, the handoff text, both setup scripts and the docs.
 *
 * The copies in the scripts and the docs are written from the manifest. After changing it, run
 *   UPDATE_PERMISSION_ARTIFACTS=1 npx vitest run test/permission-parity.test.ts
 * and review what changed in those files.
 */

const read = (file: string) => readFileSync(file, "utf8")
const desktopScript = read("resources/New-TenuVaultDesktopApp.ps1")
const readerScript = read("resources/New-TenuVaultBackupReader.ps1")
const permissionsPage = read("docs-site/src/content/docs/security/permissions.md")
const coveragePage = read("docs-site/src/content/docs/backups/coverage.md")
const registrationPage = read("docs-site/src/content/docs/getting-started/app-registration.md")
const readerPage = read("docs-site/src/content/docs/backups/backup-reader.md")

// These lists are written out so a change to the manifest that moves a default fails here.
const TODAY_GRAPH = [
  "User.Read", "Organization.Read.All", "GroupMember.Read.All", "Policy.Read.All",
  "DeviceManagementConfiguration.ReadWrite.All", "DeviceManagementApps.ReadWrite.All", "DeviceManagementServiceConfig.ReadWrite.All",
  "DeviceManagementScripts.ReadWrite.All", "DeviceManagementRBAC.ReadWrite.All", "DeviceManagementManagedDevices.Read.All",
]
const TODAY_READER = ["DeviceManagementApps.Read.All", "DeviceManagementConfiguration.Read.All", "DeviceManagementRBAC.Read.All", "DeviceManagementScripts.Read.All", "DeviceManagementServiceConfig.Read.All"]

/** The rows of the first Markdown table after a heading, as cells. */
function table(page: string, heading: string): string[][] {
  const rows = page.slice(page.indexOf(`\n${heading}\n`) + 1).split("\n").slice(1)
  const first = rows.findIndex((row) => row.startsWith("|"))
  const body = rows.slice(first).slice(0, rows.slice(first).findIndex((row) => !row.startsWith("|")))
  return body.slice(2).map((row) => row.split("|").slice(1, -1).map((cell) => cell.trim()))
}
const named = (cell: string) => /`([^`]+)`/.exec(cell)![1]!
const optional = (cell: string) => cell.includes("(optional")

describe("Copies written from the manifest", () => {
  it("lists the Apps area requirements in the setup scripts and explains policy set access in the docs", () => {
    const area = MODULE_BY_ID.get("intune")!.areas.find((entry) => entry.id === "apps")!
    const read = "DeviceManagementConfiguration.Read.All"
    const write = "DeviceManagementConfiguration.ReadWrite.All"
    const appsRow = (script: string) => script.split("\n").find((line) => line.includes("Service = 'Intune'; Area = 'Apps'"))!
    expect(appsRow(desktopScript)).toContain(`Backup = @('DeviceManagementApps.Read.All', '${read}'); Restore = @('DeviceManagementApps.ReadWrite.All', '${write}')`)
    expect(appsRow(readerScript)).toContain(`Roles = @('DeviceManagementApps.Read.All', '${read}')`)
    expect(areaNeed(area, "backup", "delegated")).toContainEqual([read, write])
    expect(areaNeed(area, "restore", "delegated")).toContainEqual([write])
    expect(permissionsPage).toContain(`Policy sets in **Apps and app protection** use \`${read}\` for backup and \`${write}\` for restore.`)
    expect(coveragePage.split("\n").find((line) => line.startsWith("| Policy sets |"))).toContain(`\`${read}\``)
  })

  it.each(ARTIFACTS.map((artifact) => [`${artifact.file} ${artifact.begin}`, artifact] as const))("%s is the manifest's text", (_name, artifact) => {
    if (process.env.UPDATE_PERMISSION_ARTIFACTS) writeArtifact(artifact)
    expect(currentBody(artifact)).toBe(artifact.body)
  })

  it("has one table per script and two in the docs, and no other copy in a script", () => {
    expect(ARTIFACTS.map((artifact) => artifact.file.split("/").at(-1))).toEqual(["New-TenuVaultDesktopApp.ps1", "New-TenuVaultBackupReader.ps1", "permissions.md", "backup-reader.md"])
    // Outside its table, a script names a permission only where an existing switch adds one.
    const outside = (script: string) => script.slice(0, script.indexOf("# BEGIN PERMISSION TABLE")) + script.slice(script.indexOf("# END PERMISSION TABLE"))
    const quoted = (script: string) => [...outside(script).matchAll(/\$\w+ \+= "([A-Za-z.-]+)"/g)].map((match) => match[1]!)
    expect(quoted(desktopScript)).toEqual(["Policy.ReadWrite.ConditionalAccess", "Policy.Read.All", "AuditLog.Read.All", "Mail.Send", "User.Read.All"])
    expect(quoted(readerScript)).toEqual(["DeviceManagementManagedDevices.Read.All", "Policy.Read.All"])
  })
})

describe("The default lists", () => {
  it("are today's, in the app, in the manifest and for the Backup Reader", () => {
    expect(DESKTOP_APP_PERMISSIONS.map((entry) => [entry.api, entry.appId, entry.permissions])).toEqual([
      ["Microsoft Graph", "00000003-0000-0000-c000-000000000000", TODAY_GRAPH],
      ["Azure Service Management", "797f4846-ba00-4fd7-ba43-dac1f8f63013", ["user_impersonation"]],
      ["Azure Storage", "e406a681-f3d4-42a8-90b6-c2b029497af1", ["user_impersonation"]],
    ])
    expect(DESKTOP_APP_PERMISSIONS.map(({ api, appId, permissions }) => ({ api, appId, permissions }))).toEqual(requestedPermissions(DEFAULT_SETUP_CHOICE, "delegated"))
    for (const entry of DESKTOP_APP_PERMISSIONS) expect(entry.purpose).toBeTruthy()
    expect(readerRoles()).toEqual(TODAY_READER)
    expect(readerRequiredRoles(DEFAULT_SELECTION)).toEqual(TODAY_READER)
  })

  it("are what the handoff text lists", () => {
    const text = setupHandoffText()
    for (const entry of DESKTOP_APP_PERMISSIONS) expect(text).toContain(`  ${entry.api}: ${entry.permissions.join(", ")}\n`)
    expect(text).toContain(`  Microsoft Graph: ${TODAY_GRAPH.join(", ")}\n`)
  })
})

describe("The setup in the app", () => {
  it("keeps no permission list of its own", () => {
    // Provisioning takes what to request, what it knows and what proves an approved registration from the manifest.
    const provisioning = read("src/main/auth/registration-provisioning.ts")
    expect(provisioning.match(/"[A-Za-z-]+(\.[A-Za-z]+)*\.(Read|ReadWrite|Send)(\.[A-Za-z]+)*"/g)).toBeNull()
    expect(provisioning).not.toContain("DeviceManagement")
    for (const call of ["requestedPermissions(options.choice ?? DEFAULT_SETUP_CHOICE, \"delegated\")", "knownPermissions(\"delegated\")", "showsApproval("]) expect(provisioning).toContain(call)
    const reader = read("src/main/auth/backup-reader.ts")
    expect(reader.match(/"[A-Za-z-]+(\.[A-Za-z]+)*\.(Read|ReadWrite)(\.[A-Za-z]+)*"/g)).toBeNull()
  })
})

describe("Optional permissions and restore access", () => {
  it("are permissions the manifest knows, included by default or added with a setup switch", () => {
    const known = knownPermissions("delegated")[0]!.permissions
    for (const entry of OPTIONAL_PERMISSIONS) {
      for (const permission of entry.permissions) expect(known, permission).toContain(permission)
      if (!entry.setupSwitch) {
        for (const permission of entry.permissions) expect(TODAY_GRAPH).toContain(permission)
        continue
      }
      expect(desktopScript).toContain(`[switch]$${entry.setupSwitch.slice(1)}`)
      // The switch's block in the script adds exactly these permissions.
      const block = desktopScript.slice(desktopScript.indexOf(`if ($${entry.setupSwitch.slice(1)}) {`))
      for (const permission of entry.permissions) expect(block.slice(0, block.indexOf("\n}")), `${entry.setupSwitch} ${permission}`).toContain(`$optional += "${permission}"`)
    }
    // Every permission a switch adds belongs to an optional permission or to Conditional Access restore.
    const switched = [...desktopScript.matchAll(/\$optional \+= "([A-Za-z.]+)"/g)].map((match) => match[1]!)
    const restore = MODULE_BY_ID.get("conditionalAccess")!.restoreAccess!
    expect(new Set(switched)).toEqual(new Set([...OPTIONAL_PERMISSIONS.flatMap((entry) => entry.setupSwitch ? entry.permissions : []), ...restore.permissions.map((permission) => permission.name), "Policy.Read.All"]))
  })

  it("names for Conditional Access restore what the manifest adds for it, behind the switch the script has", () => {
    const module = MODULE_BY_ID.get("conditionalAccess")!
    const backup = graphPermissions({ conditionalAccess: { access: "backup" } }, "delegated")
    const added = graphPermissions({ conditionalAccess: { access: "restore" } }, "delegated").filter((permission) => !backup.includes(permission))
    expect(module.restoreAccess!.permissions.map((permission) => permission.name)).toEqual(added)
    expect(desktopScript).toContain(`[switch]$${module.restoreAccess!.newSetupSwitch.slice(1)}`)
  })
})

describe("The Backup Reader", () => {
  it("may hold exactly the application permissions of the manifest, all of them read-only", () => {
    const everything: PermissionChoice = Object.fromEntries(MODULES.map((module) => [module.id, { access: "backup", areas: module.areas.filter((area) => area.optIn || area.appOnlyOptIn).map((area) => area.id) }]))
    expect([...READER_ALLOWED_ROLES].sort()).toEqual([...readerRoles(everything)].sort())
    expect([...READER_ALLOWED_ROLES].sort()).toEqual([...new Set(MODULES.flatMap((module) => module.areas.flatMap((area) => areaNeed(area, "backup", "application").map((group) => group[0]!))))].sort())
    for (const role of READER_ALLOWED_ROLES) expect(role).toMatch(/\.Read(Basic)?(\.|$)/)
  })

  it("shows a command on its card that asks the script for the roles the reader has, for every combination of services and areas", () => {
    const status = (verifiedRoles: string[]): BackupReaderStatus => ({
      tenantId: "t", clientId: "c", state: "verified", certificatePem: "", thumbprintSha256: "", thumbprint: "", certificateName: "", notAfter: "2099-01-01T00:00:00Z",
      verifiedRoles, verifiedAt: null, exportedCertificate: null, lastTest: null, lastRun: null, excludedTypes: [], roleChange: null, renewalPending: false,
    })
    // What the script grants for a command line, by the rules its parameter block and its table implement.
    const scriptRoles = (commandLine: string) => {
      const value = (name: string) => new RegExp(`-${name} (\\S+)`).exec(commandLine)?.[1]?.split(",")
      const services = value("Services") ?? ["Intune"]
      const areas = value("Areas") ?? []
      const choice: PermissionChoice = Object.fromEntries(MODULES.filter((module) => services.includes(SCRIPT_SERVICE[module.id])).map((module) => [module.id, { access: "backup", areas: module.areas.filter((area) => area.optIn && areas.includes(area.id.charAt(0).toUpperCase() + area.id.slice(1))).map((area) => area.id) }]))
      // -Permissions names the roles themselves, in place of the services and areas.
      const base = value("Permissions")?.filter((role) => role !== "None") ?? readerRoles(choice)
      return new Set([...base, ...(commandLine.includes("-IncludeDeviceCategories") ? ["DeviceManagementManagedDevices.Read.All"] : []), ...(commandLine.includes("-IncludeConditionalAccess") ? ["Policy.Read.All"] : [])])
    }
    const commandFor = (roles: string[]) => {
      const command = readerView({ supported: true, available: true, reader: status(roles), services: ["intune"], setupArguments: "" }).command
      expect(command.startsWith("./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer> -AppId c")).toBe(true)
      expect(command.slice(command.indexOf("-AppId c") + 8)).toBe(readerScriptArguments(roles))
      return command
    }
    let checked = 0
    let partial = 0
    const entraAreas = MODULE_BY_ID.get("entra")!.areas.filter((area) => area.optIn).map((area) => area.id)
    for (let mask = 1; mask < 1 << MODULES.length; mask++) for (let areaMask = 0; areaMask < 1 << entraAreas.length; areaMask++) for (const devices of [false, true]) {
      const on = MODULES.filter((_, position) => mask & (1 << position)).map((module) => module.id)
      if (!on.includes("entra") && areaMask) continue
      if (!on.includes("intune") && devices) continue
      const areasOf = (id: ModuleId) => (id === "entra" ? entraAreas.filter((_, position) => areaMask & (1 << position)) : id === "intune" && devices ? ["devices"] : [])
      const roles = [...readerRoles(Object.fromEntries(on.map((id) => [id, { access: "backup" as const, areas: areasOf(id) }])))]
      const command = commandFor(roles)
      expect(scriptRoles(command), command).toEqual(new Set(roles))
      // Whole services and areas are named as such, as before.
      expect(command).not.toContain("-Permissions")
      checked++
      // Partial coverage: the same reader short of any one of its roles, and with any one role it
      // may hold on top. Verification accepts such sets, so the command has to reproduce them too.
      const others = [...READER_ALLOWED_ROLES].filter((role) => !roles.includes(role))
      for (const set of [...roles.map((left) => roles.filter((role) => role !== left)), ...others.map((extra) => [...roles, extra])]) {
        expect(scriptRoles(commandFor(set)), `${on.join("+")} as ${set.join(" ")}`).toEqual(new Set(set))
        partial++
      }
    }
    expect(checked).toBe(29)
    expect(partial).toBe(29 * READER_ALLOWED_ROLES.size)
    // The sets a renewal used to change: one role of a service, a role next to Intune, and Entra ID short of one role.
    const five = [...readerRoles()]
    const entra = [...readerRoles({ entra: { access: "backup" } })]
    for (const set of [["Agreement.Read.All"], [...five, "Directory.Read.All"], [...five, ...entra.slice(0, -1)], []]) {
      const command = commandFor(set)
      expect(command).toContain(" -Permissions ")
      expect(scriptRoles(command), command).toEqual(new Set(set))
    }
  })

  it("accepts for -Permissions exactly the roles a reader may hold: its table and the device inventory one", () => {
    const table = currentBody(ARTIFACTS.find((artifact) => artifact.file.endsWith("New-TenuVaultBackupReader.ps1"))!)!
    const tableRoles = [...table.matchAll(/Roles = @\(([^)]*)\)/g)].flatMap((match) => match[1]!.split(",").map((value) => value.trim().replace(/'/g, "")))
    // The script takes the accepted names from its table, and adds the one its own switch grants.
    expect(readerScript).toContain('$allowedPermissions = @($permissionTable | ForEach-Object { $_.Roles }) + "DeviceManagementManagedDevices.Read.All"')
    expect(new Set([...tableRoles, "DeviceManagementManagedDevices.Read.All"])).toEqual(new Set(READER_ALLOWED_ROLES))
    expect(readerScript).toContain("if ($allowedPermissions -notcontains $name) { throw")
    // It is checked before the script connects, like the services and areas.
    expect(readerScript.indexOf("$allowedPermissions -notcontains $name")).toBeLessThan(readerScript.indexOf("Connect-MgGraph @connectParams"))
  })
})

describe("The parameters of the setup scripts", () => {
  const validated = (script: string, parameter: string) => new RegExp(`\\[ValidateSet\\(([^)]*)\\)\\]\\[string\\[\\]\\]\\$${parameter}\\b`).exec(script)?.[1]?.split(",").map((value) => value.trim().replace(/'/g, ""))

  it("name the services and the opt-in areas of the manifest", () => {
    expect(SCRIPT_SERVICES).toEqual(["Intune", "ConditionalAccess", "Entra"])
    for (const script of [desktopScript, readerScript]) {
      expect(validated(script, "Services")).toEqual(SCRIPT_SERVICES)
      expect(validated(script, "Areas")).toEqual(SCRIPT_AREAS)
    }
    expect(validated(desktopScript, "RestoreAccess")).toEqual([...SCRIPT_SERVICES, "None"])
    // The Backup Reader never restores, so its script has no such parameter.
    expect(readerScript).not.toContain("RestoreAccess")
  })

  it("are in the docs, with every value", () => {
    const row = (page: string, parameter: string) => page.split("\n").find((line) => line.startsWith(`| \`-${parameter}\``))
    for (const service of SCRIPT_SERVICES) expect(row(registrationPage, "Services"), service).toContain(`\`${service}\``)
    for (const area of SCRIPT_AREAS) expect(row(registrationPage, "Areas"), area).toContain(`\`${area}\``)
    expect(row(registrationPage, "RestoreAccess")).toContain("`None`")
    for (const parameter of ["-Services", "-Areas", "-Permissions"]) expect(readerPage).toContain(`\`${parameter}\``)
  })
})

describe("The docs permission tables", () => {
  it("list the default delegated permissions in order, and every optional one the manifest knows", () => {
    const rows = table(permissionsPage, "### Microsoft Graph")
    expect(rows.filter((row) => !optional(row[0]!)).map((row) => named(row[0]!))).toEqual(TODAY_GRAPH)
    const optionalRows = rows.filter((row) => optional(row[0]!)).map((row) => named(row[0]!))
    const known = knownPermissions("delegated")[0]!.permissions
    for (const permission of optionalRows) expect(known, permission).toContain(permission)
    for (const permission of [...OPTIONAL_PERMISSIONS.flatMap((entry) => entry.setupSwitch ? entry.permissions : []), ...MODULE_BY_ID.get("conditionalAccess")!.restoreAccess!.permissions.map((entry) => entry.name)]) expect(optionalRows, permission).toContain(permission)
    for (const api of ["Azure Service Management", "Azure Storage"]) expect(table(permissionsPage, `### ${api}`).map((row) => named(row[0]!))).toEqual(["user_impersonation"])
  })

  it("list the default permissions per API on the setup page, and count them in the manual steps", () => {
    const rows = table(registrationPage, "### Delegated permissions")
    expect(rows.map((row) => [row[0], named(row[1]!)])).toEqual(DESKTOP_APP_PERMISSIONS.flatMap((entry) => entry.permissions.map((permission) => [entry.api, permission])))
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]
    expect(registrationPage).toContain(`add the ${words[TODAY_GRAPH.length]} Graph permissions listed in`)
  })

  it("list the Backup Reader's Intune permissions, the two optional ones, and the same names on the permissions page", () => {
    const rows = table(readerPage, "### Permissions")
    expect(rows.filter((row) => !optional(row[0]!)).map((row) => named(row[0]!)).sort()).toEqual(TODAY_READER)
    expect(rows.filter((row) => optional(row[0]!)).map((row) => named(row[0]!))).toEqual(["DeviceManagementManagedDevices.Read.All", "Policy.Read.All"])
    for (const row of rows) expect(READER_ALLOWED_ROLES.has(named(row[0]!)), row[0]).toBe(true)
    const paragraph = permissionsPage.split("\n").find((line) => line.startsWith("The app registration above never changes."))!
    const inParagraph = [...paragraph.matchAll(/`([A-Za-z]+\.Read\.All)`/g)].map((match) => match[1]!)
    expect([...inParagraph].sort()).toEqual([...TODAY_READER, "DeviceManagementManagedDevices.Read.All", "Policy.Read.All"].sort())
  })
})
