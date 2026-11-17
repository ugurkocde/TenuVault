import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ENTRA_DIRECTORY_TYPES as TYPES, DIRECTORY_SCHEMAS, DIRECTORY_EXTRA_SCHEMAS, directoryExtraSnapshot } from "../src/shared/intune/entra-directory"
import { INTUNE_TYPES, restoreCapability, type Item } from "../src/shared/intune/registry"
import { listPath, listSnapshot } from "../src/shared/intune/read"
import { captureLarge } from "../src/main/backup/large"
import { largeFiles } from "../src/main/backup/large-files"
import { sameSnapshot } from "../src/shared/intune/compare"
import { backupTypeUse } from "../src/shared/services/backup-use"
import { adminCenterLink } from "../src/shared/intune/admin-links"
import { LEGACY_FOLDERS } from "../src/shared/intune/scope"
import { disabledFolders } from "../src/shared/services/modules"
import { fixture, scriptedGraph, refusal } from "./helpers/backup-fixture"
import { LARGE_BACKUP_CONTAINER, backupBlobName } from "../src/shared/backup-storage"
import { indexPath, relationPath } from "../src/shared/large-backup"
import { buildRestorePlan, buildUpdatePlan } from "../src/shared/intune/restore-plan"

const id = "00000000-0000-4000-8000-000000000001"
const id2 = "00000000-0000-4000-8000-000000000002"
const only = (...folders: string[]) => ({ excluded: INTUNE_TYPES.filter(type => !folders.includes(type.folder)).map(type => type.folder) })
const secrets = { secretText: "client-secret", password: "credential", privateKey: "-----BEGIN PRIVATE KEY-----" }
function scan(value: unknown): void {
  if (typeof value === "string") expect(value).not.toMatch(/client-secret|credential|-----BEGIN .*PRIVATE KEY-----|Bearer\s|eyJ[\w-]+\.[\w-]+\.[\w-]+/)
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(/^(secretText|password|privateKey|clientSecret|accessToken|refreshToken|passwordProfile|authenticationMethods|signInActivity|key)$/i)
    scan(child)
  }
}
async function capture(type = TYPES[1]!, options: { relationError?: number; object?: Item; lateError?: boolean; managerStatus?: number } = {}) {
  const files = new Map<string, any>()
  const index = await captureLarge({ type, signal: new AbortController().signal, saved: () => {}, put: async (name, body) => { files.set(name, JSON.parse(body)) }, reader: { get: async () => { throw Object.assign(new Error("Missing manager"), { status: options.managerStatus ?? 404 }) }, list: async () => { throw new Error("Must stream") } }, pages: async function* (path) {
    if (path === listPath(type)) { yield [options.object ?? { id, displayName: "Example", assignedLicenses: [] }, { id: id2, displayName: "Example", assignedLicenses: [] }]; return }
    if (options.relationError && path.includes(id + "/members")) {
      if (options.lateError) yield [{ id: id2 }]
      throw Object.assign(new Error("Refused"), { status: options.relationError })
    }
    if (path.includes("/members")) { yield [{ id: id2 }, { id }]; return }
    yield []
  } })
  return { files, index }
}

describe("Directory inventory", () => {
  for (const type of TYPES) {
    it(`${type.folder}: stores a sanitized live shape with a closed allowlist and no restore path`, async () => {
      const data = JSON.parse(readFileSync(new URL(`./fixtures/entra-directory/${type.folder}.json`, import.meta.url), "utf8"))
      const source = { ...(data.samples.object ?? { id }), ...secrets, unexpected: "private", id: type.folder === "OAuth2PermissionGrants" ? "A".repeat(44) : id }
      // Every retained nested value has an explicit schema, even if Graph adds new properties.
      for (const key of ["passwordCredentials", "keyCredentials"]) if (type.keep?.includes(key)) source[key] = [{ keyId: id, displayName: "Example", ...secrets, key: "private certificate" }]
      const snapshot = listSnapshot(type, source)
      expect(Object.keys(snapshot).every(key => key in DIRECTORY_SCHEMAS[type.folder as keyof typeof DIRECTORY_SCHEMAS])).toBe(true)
      scan(snapshot)
      expect(snapshot).not.toHaveProperty("unexpected")
      expect(source.secretText).toBe("client-secret")
      for (const [property, sample] of Object.entries(data.samples)) if (property !== "object" && property in DIRECTORY_EXTRA_SCHEMAS) scan(directoryExtraSnapshot(property, { ...(sample as Item), ...secrets }))
      expect(restoreCapability(type)).toBe("none")
      expect(() => buildRestorePlan(type, snapshot)).toThrow()
      expect(() => buildUpdatePlan(type, snapshot, id)).toThrow()
      expect(adminCenterLink(type.folder, id)?.center).toBe("Entra")
      expect(backupTypeUse(type)).toEqual({ policyCount: false, compare: true, hygiene: false, auditService: undefined })
      expect(sameSnapshot(snapshot, structuredClone(snapshot))).toBe(true)
      expect(sameSnapshot(snapshot, { ...snapshot, displayName: "Changed" })).toBe(false)
      expect(type.volume).toBe("large")
      expect(disabledFolders({ services: ["entra"] })).toContain(type.folder)
      expect(LEGACY_FOLDERS).not.toContain(type.folder)
    })
    it(`${type.folder}: streams the live response shape into ID-named snapshots and relationship shards`, async () => {
      const data = JSON.parse(readFileSync(new URL(`./fixtures/entra-directory/${type.folder}.json`, import.meta.url), "utf8"))
      const object = { ...(data.samples.object ?? { id }), id: type.folder === "OAuth2PermissionGrants" ? "A".repeat(44) : id }
      const files = new Map<string, Item>()
      const index = await captureLarge({ type, signal: new AbortController().signal, saved: () => {}, put: async (name, body) => { files.set(name, JSON.parse(body)) }, reader: { get: async () => ({ id: id2, displayName: "Excluded relationship name" }), list: async () => { throw new Error("Must stream") } }, pages: async function* (path) {
        if (path === listPath(type)) { yield [object]; return }
        const property = path.split("?")[0]!.split("/").at(-1)!
        if (data.samples[property]) yield [{ ...data.samples[property], id: id2 }]
        else yield []
      } })
      expect(index).toMatchObject({ count: 1, complete: true })
      const saved = files.get(`${type.folder}/${object.id}.json`)!
      scan(saved)
      expect(JSON.stringify([...files.values()])).not.toContain("Excluded relationship name")
      for (const [name, value] of files) { expect(name).not.toContain("Example"); scan(value) }
    })
    it(`${type.folder}: refuses a personal value as an object ID before any file is saved`, async () => {
      await expect(capture(type, { object: { id: "person@example.test", displayName: "Example" } })).rejects.toThrow("unsafe object ID")
      await expect(capture(type, { object: { id: "personalName", displayName: "Example" } })).rejects.toThrow("unsafe object ID")
    })
  }
  it("keeps only allowlisted properties at every nested level and refuses credential values", () => {
    const type = TYPES.find(type => type.folder === "Applications")!
    const snapshot = listSnapshot(type, { id, web: { redirectUris: ["https://example.test"], ...secrets, implicitGrantSettings: { enableIdTokenIssuance: true, ...secrets } }, api: { oauth2PermissionScopes: [{ id, value: "Example", ...secrets }] }, optionalClaims: { idToken: [{ name: "Example", additionalProperties: ["Example"], ...secrets }] } })
    scan(snapshot)
    expect(() => listSnapshot(type, { id, description: secrets.privateKey })).toThrow("refused credential")
    expect(() => listSnapshot(type, { id, displayName: { nested: "Unexpected" } })).toThrow("unexpected shape")
    expect(() => listSnapshot(type, { id, web: "Unexpected" })).toThrow("unexpected shape")
    expect(() => listSnapshot(type, { id, "appRoles@odata.nextLink": "https://graph.microsoft.com/v1.0/next", appRoles: [] })).toThrow("not read in full")
  })
  it("sorts member IDs and marks a complete collection explicitly", async () => {
    const { index, files } = await capture()
    expect(index).toMatchObject({ complete: true, count: 2 })
    expect(files.get(`Groups/${id}.json`).members).toMatchObject({ count: 2, shards: 1, complete: true })
    expect(files.get(relationPath("Groups", id, "members", 0))).toEqual([id, id2])
    const metadata = { LargeItems: { Groups: index }, Items: {} }
    const exported = []
    for await (const file of largeFiles(metadata, async name => files.get(name))) exported.push(file.name)
    expect(exported).toContain(`Groups/${id2}.json`)
    const before = files.get(`Groups/${id}.json`)
    const after = (await capture()).files.get(`Groups/${id}.json`)
    expect(sameSnapshot(before, after)).toBe(true)
    expect(sameSnapshot(before, { ...after, members: { ...after.members, hash: "changed" } })).toBe(false)
  })
  it.each([403, 404])("retains a refused group's parent and continues the type after HTTP %i", async status => {
    const { index, files } = await capture(undefined, { relationError: status, lateError: true })
    expect(index).toMatchObject({ complete: false, count: 2 })
    expect(files.get(`Groups/${id}.json`).members).toEqual({ complete: false })
    expect(files.get(`Groups/${id2}.json`).members).toMatchObject({ complete: true, count: 2 })
    expect(files.get(indexPath("Groups", 0))).toHaveLength(2)
  })
  it("ends a type on an expired relationship continuation", async () => {
    await expect(capture(undefined, { relationError: 410, lateError: true })).rejects.toThrow("Refused")
  })
  it("records expanded manager IDs and complete absence without a manager GET", async () => {
    const { index, files } = await capture(TYPES[0])
    const withManager = listSnapshot(TYPES[0]!, { id, manager: { id: id2, displayName: "Excluded profile" } })
    expect(withManager.manager).toEqual({ id: id2, complete: true })
    expect(() => listSnapshot(TYPES[0]!, { id, manager: { id: "personalName" } })).toThrow("Invalid directory manager")
    expect(index.complete).toBe(true)
    expect(files.get(`Users/${id}.json`).manager).toEqual({ id: null, complete: true })

  })
  it("does not select Microsoft-owned enterprise apps", () => {
    const type = TYPES.find(type => type.folder === "ServicePrincipals")!
    expect(listPath(type)).toContain("$filter=appOwnerOrganizationId")
    expect(type.skip?.({ appOwnerOrganizationId: "f8cdef31-a31e-4b4a-93e4-5f571e91255a" })).toBeTruthy()
    expect(type.skip?.({ appOwnerOrganizationId: id })).toBeUndefined()
  })
  it("never publishes Graph error text or codes that echo a directory profile", async () => {
    const type = TYPES[1]!
    const setup = fixture(scriptedGraph({ [`/v1.0/${decodeURIComponent(listPath(type))}`]: refusal(400, "SyntheticProfileName", "SyntheticProfileName profile@example.test") }), { services: () => ({ services: ["entra"], areas: { entra: ["groups"] } }) })
    const job = await setup.run({ scope: only("Groups") })
    expect(job.coverage).toBe("incomplete")
    expect(JSON.stringify(job)).not.toMatch(/SyntheticProfileName|profile@example.test/)
  })
  it("records incomplete relationship coverage through the engine without ending the next group", async () => {
    const type = TYPES[1]!
    const routes: Record<string, unknown> = { [`/v1.0/${decodeURIComponent(listPath(type))}`]: { value: [{ id, displayName: "Synthetic private profile" }, { id: id2, displayName: "Synthetic private profile" }] } }
    for (const object of [id, id2]) for (const extra of type.extras!) routes[extra.path(object).startsWith("https:") ? extra.path(object).replace("https://graph.microsoft.com", "") : `/v1.0/${extra.path(object)}`] = { value: [] }
    routes[`/beta/groups/${id}/members?$select=id&$top=999`] = refusal(403, "Authorization_RequestDenied", "Hidden membership")
    const setup = fixture(scriptedGraph(routes), { services: () => ({ services: ["entra"], areas: { entra: ["groups"] } }) })
    const job = await setup.run({ scope: only("Groups") })
    expect(job.coverage).toBe("incomplete")
    expect(job.results?.types[0]).toMatchObject({ folder: "Groups", saved: 2, failed: 1 })
    const metadata = JSON.parse((await setup.store.get(setup.account, LARGE_BACKUP_CONTAINER, backupBlobName(`${job.backupFolder}/metadata.json`))).data.toString())
    expect(metadata.LargeItems.Groups).toMatchObject({ count: 2, complete: false })
    expect(metadata.ItemCounts.TotalPolicies).toBe(0)
    expect(JSON.stringify(job.log)).not.toContain("Synthetic private profile")
  })
})
