import { readFileSync, writeFileSync } from "node:fs"
import { MODULES, MODULE_BY_ID, type ModuleId, type PermissionArea } from "../src/shared/services/modules"
import { areaPermissions, DESKTOP_BASE_PERMISSIONS, DEFAULT_READER_CHOICE, DEFAULT_SETUP_CHOICE, REQUEST_ORDER, SCRIPT_SERVICE, scriptArea } from "../src/shared/services/manifest"

/**
 * The copies of the permission manifest that live outside TypeScript: the permission table inside
 * each setup script and the permission tables in the docs. Each copy sits between two marker lines
 * and is written from the manifest, so test/permission-parity.test.ts can compare it text for text.
 *
 * After a change to the manifest, write the copies again with:
 *   UPDATE_PERMISSION_ARTIFACTS=1 npx vitest run test/permission-parity.test.ts
 */

const list = (values: readonly string[]) => `@(${values.map((value) => `'${value}'`).join(", ")})`
const rows = (row: (id: ModuleId, area: PermissionArea) => string | undefined) =>
  REQUEST_ORDER.flatMap((id) => MODULE_BY_ID.get(id)!.areas.flatMap((area) => row(id, area) ?? [])).join("\n")

/** The table inside New-TenuVaultDesktopApp.ps1: delegated permissions per service and area. */
export function desktopScriptTable(): string {
  return [
    `$basePermissions = ${list(DESKTOP_BASE_PERMISSIONS)}`,
    `$defaultServices = ${list(REQUEST_ORDER.filter((id) => DEFAULT_SETUP_CHOICE[id]).map((id) => SCRIPT_SERVICE[id]))}`,
    `$defaultRestoreAccess = ${list(REQUEST_ORDER.filter((id) => DEFAULT_SETUP_CHOICE[id]?.access === "restore").map((id) => SCRIPT_SERVICE[id]))}`,
    "$permissionTable = @(",
    rows((id, area) => `    @{ Service = '${SCRIPT_SERVICE[id]}'; Area = '${scriptArea(area.id)}'; OptIn = $${Boolean(area.optIn)}; Backup = ${list(areaPermissions(area, "backup", "delegated"))}; Restore = ${list(areaPermissions(area, "restore", "delegated"))} }`),
    ")",
  ].join("\n")
}

/**
 * The table inside New-TenuVaultBackupReader.ps1: application permissions per service and area. An
 * area the reader only gets on request has a switch of its own in the script and is not in the table.
 */
export function readerScriptTable(): string {
  return [
    `$defaultServices = ${list(REQUEST_ORDER.filter((id) => DEFAULT_READER_CHOICE[id]).map((id) => SCRIPT_SERVICE[id]))}`,
    "$permissionTable = @(",
    rows((id, area) => (area.appOnlyOptIn ? undefined : `    @{ Service = '${SCRIPT_SERVICE[id]}'; Area = '${scriptArea(area.id)}'; OptIn = $${Boolean(area.optIn)}; Roles = ${list(areaPermissions(area, "backup", "application"))} }`)),
    ")",
  ].join("\n")
}

const code = (values: readonly string[]) => (values.length ? values.map((value) => `\`${value}\``).join(", ") : "None")

/** What the restore access of an area adds to its backup permissions. */
const restoreAdds = (area: PermissionArea) => {
  const backup = areaPermissions(area, "backup", "delegated")
  return areaPermissions(area, "restore", "delegated").filter((permission) => !backup.includes(permission))
}

/** The docs table of a service's delegated permissions: what backup asks for per area, and what restore adds. */
export function delegatedDocsTable(id: ModuleId): string {
  const module = MODULE_BY_ID.get(id)!
  return [
    "| Area | Backup | Restore adds |",
    "| --- | --- | --- |",
    ...module.areas.map((area) => `| ${area.label}${area.optIn ? " (only when you turn the area on)" : ""} | ${code(areaPermissions(area, "backup", "delegated"))} | ${code(restoreAdds(area))} |`),
  ].join("\n")
}

/** The docs table of a service's Backup Reader permissions per area. */
export function readerDocsTable(id: ModuleId): string {
  const module = MODULE_BY_ID.get(id)!
  return [
    "| Area | Application permissions |",
    "| --- | --- |",
    ...module.areas.map((area) => `| ${area.label}${area.optIn ? " (only with `-Areas`)" : ""} | ${code(areaPermissions(area, "backup", "application"))} |`),
  ].join("\n")
}

export interface Artifact {
  file: string
  begin: string
  end: string
  body: string
}

const script = (file: string, body: string): Artifact => ({ file, begin: "# BEGIN PERMISSION TABLE", end: "# END PERMISSION TABLE", body })
const docs = (file: string, name: string, body: string): Artifact => ({ file, begin: `<!-- permissions:${name}:begin -->`, end: `<!-- permissions:${name}:end -->`, body })

export const ARTIFACTS: readonly Artifact[] = [
  script("resources/New-TenuVaultDesktopApp.ps1", desktopScriptTable()),
  script("resources/New-TenuVaultBackupReader.ps1", readerScriptTable()),
  docs("docs-site/src/content/docs/security/permissions.md", "entra", delegatedDocsTable("entra")),
  docs("docs-site/src/content/docs/security/permissions.md", "defender", delegatedDocsTable("defender")),
  docs("docs-site/src/content/docs/backups/backup-reader.md", "entra", readerDocsTable("entra")),
  docs("docs-site/src/content/docs/backups/backup-reader.md", "defender", readerDocsTable("defender")),
]

/** Where an artifact's body starts and ends in its file; undefined when a marker line is missing. */
function span(artifact: Artifact, text: string): { start: number; stop: number } | undefined {
  const begin = text.indexOf(`${artifact.begin}\n`)
  const stop = text.indexOf(artifact.end, begin)
  return begin < 0 || stop < 0 ? undefined : { start: begin + artifact.begin.length + 1, stop }
}

/** The text between an artifact's marker lines, without the markers; undefined when they are missing. */
export function currentBody(artifact: Artifact, text = readFileSync(artifact.file, "utf8")): string | undefined {
  const found = span(artifact, text)
  // The end marker has to start a line of its own, or the body would run into it.
  return found && text.slice(found.start, found.stop).endsWith("\n") ? text.slice(found.start, found.stop - 1) : undefined
}

/** Writes an artifact's body between its marker lines. */
export function writeArtifact(artifact: Artifact): void {
  const text = readFileSync(artifact.file, "utf8")
  const found = span(artifact, text)
  if (!found) throw new Error(`${artifact.file} has no ${artifact.begin} and ${artifact.end} lines.`)
  writeFileSync(artifact.file, `${text.slice(0, found.start)}${artifact.body}\n${text.slice(found.stop)}`)
}

/** Every service a script or docs page may name, in the order of the services list. */
export const SCRIPT_SERVICES = MODULES.map((module) => SCRIPT_SERVICE[module.id])

/** Every opt-in area a script may name. */
export const SCRIPT_AREAS = MODULES.flatMap((module) => module.areas.filter((area) => area.optIn).map((area) => scriptArea(area.id)))
