import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { BASE_PERMISSIONS } from "../src/shared/services/manifest"
import { MODULES, MODULE_BY_ID, type Need, type SignInMode } from "../src/shared/services/modules"
import { OPTIONAL_PERMISSIONS } from "../src/shared/services/optional-permissions"

/**
 * test/fixtures/permission-verification.json records how every permission in the manifest was
 * checked against Microsoft's own data and the lab tenant. These tests hold the manifest to it: a
 * permission that is not recorded for the sign-in mode it is listed under fails here, so nobody can
 * add one without looking it up.
 */

interface Entry { permission: string; asked: boolean; model: string; index: string; status: string }
type Recorded = Entry[] | "unsupported"
interface Part { service: string; area: string; folders: string[]; read: string[]; write: string[]; live: string; backup: Record<SignInMode, Recorded>; restore: Record<SignInMode, Recorded> }
const record = JSON.parse(readFileSync(new URL("./fixtures/permission-verification.json", import.meta.url), "utf8")) as {
  permissions: Record<string, Record<SignInMode, string | null>>
  parts: Part[]
  leftOut: { service: string; folder: string; path: string; reason: string }[]
  statuses: Record<string, string>
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MODES: readonly SignInMode[] = ["delegated", "application"]

/** Every permission the manifest names, with the sign-in modes it names it for. */
function named(): Map<string, Set<SignInMode>> {
  const names = new Map<string, Set<SignInMode>>()
  const use = (name: string, mode: SignInMode) => names.set(name, (names.get(name) ?? new Set()).add(mode))
  for (const module of MODULES) for (const area of module.areas) for (const part of area.parts) for (const access of ["backup", "restore"] as const) for (const mode of MODES) {
    const needed = part[access][mode]
    if (needed !== "unsupported") for (const group of needed) for (const name of group) use(name, mode)
  }
  for (const name of BASE_PERMISSIONS) use(name, "delegated")
  for (const entry of OPTIONAL_PERMISSIONS) for (const name of entry.permissions) use(name, "delegated")
  return names
}

/** A need as the record writes it: each group's permissions in order, the first one marked as asked for. */
const shape = (needed: Need) => (needed === "unsupported" ? "unsupported" : needed.flatMap((group) => group.map((permission, position) => `${permission}${position === 0 ? " (asked)" : ""}`)))
const recorded = (entries: Recorded) => (entries === "unsupported" ? "unsupported" : entries.map((entry) => `${entry.permission}${entry.asked ? " (asked)" : ""}`))

describe("The record of checked permissions", () => {
  it("has an identifier from Microsoft's permissions reference for every permission, for each sign-in mode the manifest names it under", () => {
    const names = named()
    expect(names.size).toBeGreaterThan(100)
    for (const [name, modes] of names) for (const mode of modes) expect(record.permissions[name]?.[mode], `${name} as a ${mode} permission`).toMatch(GUID)
    // Nothing is recorded that the manifest no longer names.
    expect(Object.keys(record.permissions).sort()).toEqual([...names.keys()].sort())
    for (const [name, ids] of Object.entries(record.permissions)) for (const mode of MODES) expect(Boolean(ids[mode]), `${name} ${mode}`).toBe(names.get(name)!.has(mode))
  })

  it("covers every folder of Entra ID and Defender with exactly the permissions the manifest gives it", () => {
    const parts = (["entra", "defender"] as const).flatMap((id) => MODULE_BY_ID.get(id)!.areas.flatMap((area) => area.parts.map((part) => ({ service: id, area: area.id, part }))))
    expect(record.parts.map((part) => `${part.service}/${part.area}/${part.folders.join(",")}`)).toEqual(parts.map(({ service, area, part }) => `${service}/${area}/${part.folders.join(",")}`))
    parts.forEach(({ part }, position) => {
      const entry = record.parts[position]!
      for (const access of ["backup", "restore"] as const) for (const mode of MODES) expect(recorded(entry[access][mode]), `${entry.folders[0]} ${access} ${mode}`).toEqual(shape(part[access][mode]))
      // Each part names the requests its permissions were looked up for.
      expect(entry.read.length, entry.folders[0]).toBeGreaterThan(0)
      expect(entry.write.length > 0, entry.folders[0]).toBe(part.restore.delegated !== "unsupported")
    })
  })

  it("marks what could not be confirmed, and that is one permission", () => {
    const entries = record.parts.flatMap((part) => (["backup", "restore"] as const).flatMap((access) => MODES.flatMap((mode) => {
      const list = part[access][mode]
      return list === "unsupported" ? [] : list.map((entry) => ({ ...entry, where: `${part.folders[0]} ${access} ${mode}` }))
    })))
    for (const entry of entries) expect(Object.keys(record.statuses), entry.where).toContain(entry.status)
    // The one permission TenuVault asks for that Microsoft does not document for the sign-in mode: its
    // pages list only APIConnectors.ReadWrite.All, which a backup must not ask for. The lab tenant named
    // APIConnectors.Read.All as enough for app-only access; for a signed-in admin that is not shown.
    expect(entries.filter((entry) => entry.status === "unconfirmed").map((entry) => `${entry.where} ${entry.permission}`)).toEqual(["ApiConnectors backup delegated APIConnectors.Read.All"])
    // A permission that is only implied is never the one asked for, and one confirmed live is always a read.
    for (const entry of entries.filter((candidate) => candidate.status === "implied")) expect(entry.asked, entry.where).toBe(false)
    for (const entry of entries.filter((candidate) => candidate.status === "confirmed live")) expect(entry.where).toContain(" backup ")
    // Restore entries use Microsoft's listing; union lab tokens do not isolate delegated minimum permissions.
    for (const entry of entries.filter((candidate) => candidate.where.includes(" restore "))) expect(entry.status, `${entry.where} ${entry.permission}`).toBe("confirmed")
  })

  it("names the types of the research that stay out, and none of them has a folder", () => {
    expect(record.leftOut.map((entry) => entry.folder)).toEqual(["ServicePrincipalCreationPolicies", "EntraUxSetting", "DirectoryRoleAccessReviewPolicy", "FeatureRolloutPolicies", "OnPremAuthenticationPolicies", "AppProxyConnectorGroups", "DefenderCloudScopes", "DefenderContentRepositories"])
    const folders = new Set(MODULES.flatMap((module) => module.areas.flatMap((area) => area.folders)))
    for (const entry of record.leftOut) expect(folders.has(entry.folder), entry.folder).toBe(false)
  })

  it("matches the identifier the app shows for adding Conditional Access restore", () => {
    for (const permission of MODULE_BY_ID.get("conditionalAccess")!.restoreAccess!.permissions) expect(record.permissions[permission.name]!.delegated).toBe(permission.id)
  })
})
