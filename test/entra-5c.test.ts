vi.hoisted(() => vi.stubGlobal("__TV_LAB_EXPANDED_ENTRA__", true))

import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { ENTRA_5C_TYPES as TYPES } from "../src/shared/intune/entra"
import { INTUNE_TYPES, restoreCapability, type Item } from "../src/shared/intune/registry"
import { readObject } from "../src/shared/intune/read"
import { compareBackups } from "../src/shared/intune/backup-changes"
import { sameSnapshot } from "../src/shared/intune/compare"
import { adminCenterLink } from "../src/shared/intune/admin-links"
import { buildRestorePlan, buildUpdatePlan } from "../src/shared/intune/restore-plan"
import { MODULE_BY_ID } from "../src/shared/services/modules"
import { backupTypeUse } from "../src/shared/services/backup-use"
import { runObservation } from "../src/shared/connection-health/observe"
import { compareObjects } from "../src/portal/app/api/detect-drifts/route"
import { fixture, scriptedGraph, refusal } from "./helpers/backup-fixture"
import { readEntraType, recorded, replay, type ReadFixture } from "./helpers/entra-5c"

const typeOf = (folder: string) => TYPES.find(type => type.folder === folder)!
const only = (...folders: string[]) => ({ excluded: INTUNE_TYPES.filter(type => !folders.includes(type.folder)).map(type => type.folder) })
const documented = (folder: string): ReadFixture => JSON.parse(readFileSync(new URL(`./fixtures/entra-5c/${folder}.documented.json`, import.meta.url), "utf8"))
const secretKey = /^(clientSecret|password|privateKey|sharedSecret|secretKey|tokenSeed|seed|tunnelKey|keyCredentials|passwordCredentials|secret|accessToken|refreshToken|clientAssertion|pfx|pkcs12|secretText|fileData)$/i
const secretValue = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|Bearer\s+[\w.-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|<RSAKeyValue>[\s\S]*<D>|data:application\/(?:x-pkcs12|pkcs12)/i
function scan(value: unknown): void {
  if (typeof value === "string") expect(value).not.toMatch(secretValue)
  if (!value || typeof value !== "object") return
  for (const [key, entry] of Object.entries(value)) { expect(key).not.toMatch(secretKey); scan(entry) }
}
const routes = (data: ReadFixture) => Object.fromEntries(Object.entries(data.responses).map(([path, answer]) => [decodeURIComponent(path), answer.status === 200 ? answer.body : refusal(answer.status, String((answer.body.error as Item)?.code), String((answer.body.error as Item)?.message))]))

describe("Entra configuration coverage closes every configuration area", () => {
  it("requires a registry type for every folder in all five configuration areas", () => {
    const areas = MODULE_BY_ID.get("entra")!.areas.filter(area => ["tenantSettings", "authentication", "externalIdentities", "roles", "governance"].includes(area.id))
    expect(areas).toHaveLength(5)
    for (const area of areas) for (const folder of area.folders) expect(INTUNE_TYPES.find(type => type.folder === folder), `${area.label}: ${folder}`).toBeDefined()
    expect(TYPES.map(type => type.folder).sort()).toEqual(areas.find(area => area.id === "governance")!.folders.slice().sort())
  })

  for (const type of TYPES) {
    it(`${type.folder}: replays the sanitized live response and scans every saved object`, async () => {
      const data = recorded(type.folder)
      const read = await readEntraType(type, replay(data, type))
      expect(read.outcome).toBe(data.outcome)
      expect(read.objects).toHaveLength(data.objectCount)
      if ("cause" in read) expect(read.cause).toBe(data.cause)
      read.objects.forEach(scan)
      expect(restoreCapability(type)).toBe(type.folder === "AccessPackageCatalogs" ? "create" : type.folder === "AccessReviewPolicy" ? "singleton" : "none")
      expect(() => buildRestorePlan(type, { id: "example" })).toThrow()
      expect(() => buildUpdatePlan(type, { id: "example" }, "example")).toThrow()
      expect(adminCenterLink(type.folder, "example")?.center).toBe("Entra")
      expect(backupTypeUse(type)).toEqual({ policyCount: true, compare: true, hygiene: false, auditService: undefined })
    })

    it(`${type.folder}: reads documented nonempty configuration through the engine and compares changes`, async () => {
      const setup = fixture(scriptedGraph(routes(documented(type.folder))))
      const job = await setup.run({ scope: only(type.folder) })
      expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "saved", saved: 1 }] })
      const files = (await setup.files(job)).filter(file => file.startsWith(type.folder + "/"))
      expect(files).toHaveLength(1)
      const object = (await setup.file(job, files[0]!))!
      scan(object)
      const after = { ...object, displayName: "Changed configuration" }
      expect(sameSnapshot(object, structuredClone(object))).toBe(true)
      expect(sameSnapshot(object, after)).toBe(false)
      expect(compareObjects(object, after).some(change => change.field === "displayName")).toBe(true)
      expect(runObservation(job.outcomes!).read).toContain(type.folder)
    })
  }
})

describe("Governance completeness, ordering and exclusions", () => {
  it("reads nested expanded continuation pages before sorting resource roles and scopes", async () => {
    const type = typeOf("AccessPackageCatalogs")
    const next = "https://graph.microsoft.com/beta/identityGovernance/entitlementManagement/accessPackageCatalogs/example/accessPackageResources/resource/accessPackageResourceRoles?$skiptoken=more"
    const data = documented(type.folder)
    const resourceAnswer = Object.values(data.responses).find(answer => Array.isArray(answer.body.value) && (answer.body.value[0] as Item)?.originSystem)!
    const resource = (resourceAnswer.body.value as Item[])[0]!
    resource.accessPackageResourceRoles = [{ id: "b" }]
    resource["accessPackageResourceRoles@odata.nextLink"] = next
    data.responses[new URL(next).pathname + new URL(next).search] = { status: 200, body: { value: [{ id: "a" }] } }
    const result = await readEntraType(type, replay(data, type))
    expect(result.outcome).toBe("saved")
    expect((result.objects[0]!.resources as Item[])[0]!.roles).toEqual([{ id: "a" }, { id: "b" }])
    delete data.responses[new URL(next).pathname + new URL(next).search]
    await expect(readEntraType(type, replay(data, type))).rejects.toThrow("Fixture misses")
  })

  for (const type of TYPES) it(`${type.folder}: reordered object collections do not change stored fingerprints`, async () => {
    const snapshots = []
    for (const reverse of [false, true]) {
      const data = documented(type.folder)
      const shuffle = (value: unknown): void => {
        if (!value || typeof value !== "object") return
        if (Array.isArray(value)) { if (reverse) value.reverse(); value.forEach(shuffle); return }
        Object.values(value).forEach(shuffle)
      }
      // Approval stages and task execution sequence are ordered by their configuration, not response position.
      shuffle(data.responses)
      const setup = fixture(scriptedGraph(routes(data)))
      const job = await setup.run({ scope: only(type.folder) })
      expect(job.outcomes?.coverage).toBe("complete")
      snapshots.push((await setup.manifest(job)).Items)
    }
    expect(snapshots[0]).toEqual(snapshots[1])
    expect(compareBackups({ Status: "Success", Items: snapshots[0] }, { Status: "Success", Items: snapshots[1] })).toEqual([])
  })

  it("never counts an omitted expanded collection as covered", async () => {
    for (const folder of ["AccessPackages", "AccessPackageAssignmentPolicies", "TermsOfUseAgreements"]) {
      const type = typeOf(folder)
      const graph = replay(documented(folder), type)
      const get = graph.get
      graph.get = async path => { const object = await get(path); delete object[type.requiredCollections![0]!]; return object }
      await expect(readObject(type, "example", graph)).rejects.toThrow("did not return the expanded collection")
    }
  })

  it("keeps approval stages in their configured order", async () => {
    const type = typeOf("AccessPackageAssignmentPolicies")
    const graph = replay(documented(type.folder), type)
    const get = graph.get
    graph.get = async path => ({ ...await get(path), requestApprovalSettings: { stages: [{ durationBeforeAutomaticDenial: "P7D" }, { durationBeforeAutomaticDenial: "P14D" }] } })
    const object = await readObject(type, "example", graph)
    expect((object.requestApprovalSettings as Item).stages).toEqual([{ durationBeforeAutomaticDenial: "P7D" }, { durationBeforeAutomaticDenial: "P14D" }])
  })

  it("strips injected credentials recursively but preserves public certificates and task token placeholders", async () => {
    for (const type of TYPES) {
      const graph = replay(documented(type.folder), type)
      const get = graph.get
      graph.get = async path => ({ ...await get(path), nested: [{ clientSecret: "fixture", privateKey: "fixture", enabled: true }], publicCertificate: "-----BEGIN CERTIFICATE-----\nUFVCTElD\n-----END CERTIFICATE-----", argument: "{{user.id}}" })
      const object = await readObject(type, "example", graph)
      scan(object)
      expect(object.nested).toEqual([{ enabled: true }])
      expect(object.publicCertificate).toContain("BEGIN CERTIFICATE")
      expect(object.argument).toBe("{{user.id}}")
    }
  })

  it("stores terms metadata without PDFs, workflow history or review instances", async () => {
    for (const [folder, omitted] of [["TermsOfUseAgreements", "acceptances"], ["LifecycleWorkflows", "versions"], ["AccessReviewDefinitions", "instances"]]) {
      const type = typeOf(folder!)
      const graph = replay(documented(folder!), type)
      const get = graph.get
      graph.get = async path => ({ ...await get(path), [omitted!]: [{ id: "history" }] })
      const object = await readObject(type, "example", graph)
      expect(object).not.toHaveProperty(omitted!)
      scan(object)
      if (folder === "TermsOfUseAgreements") expect(object.files).toEqual(expect.arrayContaining([expect.objectContaining({ fileName: "terms-en.pdf" })]))
    }
  })

  it("fails visibly on oversized terms JSON", async () => {
    const type = typeOf("TermsOfUseAgreements")
    await expect(readObject(type, "example", { get: async () => ({ id: "example", files: [], displayName: "x".repeat(1024 * 1024) }), list: async () => [] })).rejects.toThrow("byte limit")
  })

  for (const folder of ["LifecycleWorkflows", "LifecycleWorkflowCustomTaskExtensions", "LifecycleWorkflowSettings"]) it(`${folder}: only its exact own-list license refusal means unavailable`, async () => {
    const type = typeOf(folder)
    const answer = recorded(folder).responses[`/v1.0/${type.path}`]!
    const error = answer.body.error as Item
    const unavailable = refusal(403, String(error.code), String(error.message))
    const setup = fixture(scriptedGraph({ [`/v1.0/${type.path}`]: unavailable }))
    const job = await setup.run({ scope: only(folder) })
    expect(job.outcomes).toMatchObject({ coverage: "incomplete", types: [{ outcome: "skipped", cause: "license" }] })
    expect(runObservation(job.outcomes!).refused).toEqual([expect.objectContaining({ folder, cause: "license" })])
    const changed = fixture(scriptedGraph({ [`/v1.0/${type.path}`]: refusal(403, "DifferentCode", String(error.message)) }))
    const changedJob = await changed.run({ scope: only(folder) })
    expect(changedJob.outcomes?.types[0]).toMatchObject({ outcome: "failed" })
    expect(runObservation(changedJob.outcomes!).refused).toEqual([])
    if (!type.singleton) {
      const detail = fixture(scriptedGraph({ ...routes(documented(folder)), [`/v1.0/${type.path}/example`]: unavailable }))
      expect((await detail.run({ scope: only(folder) })).outcomes?.types[0]).toMatchObject({ outcome: "failed" })
    }
  })

  for (const status of [403, 404]) it(`keeps refused resource and reference sub-reads (${status}) incomplete`, async () => {
    for (const folder of ["AccessPackageCatalogs", "AccessPackages", "ConnectedOrganizations"]) {
      const type = typeOf(folder)
      const data = documented(folder)
      const extra = type.extras![0]!
      const path = `/${type.apiVersion}/${extra.path("example")}`
      const setup = fixture(scriptedGraph({ ...routes(data), [path]: refusal(status, "Denied", "Sub-read failed") }))
      const job = await setup.run({ scope: only(folder) })
      expect(job.outcomes?.coverage).toBe("incomplete")
      expect(job.outcomes?.types[0]?.outcome).not.toBe("saved")
      expect(job.outcomes?.types[0]?.outcome).not.toBe("notConfigured")
      expect((await setup.files(job)).some(file => file.startsWith(folder + "/"))).toBe(false)
    }
  })
})

describe("Governance per-type budgets", () => {
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 10_000 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve))
    expect(predicate()).toBe(true)
  }
  const intune = {
    "/beta/deviceManagement/deviceConfigurations": { value: [{ id: "intune", displayName: "Intune policy" }] },
    "/beta/deviceManagement/deviceConfigurations/intune?$expand=assignments": { id: "intune", displayName: "Intune policy" },
  }
  it("caps combined list, detail and sub-read GETs and continues Intune", async () => {
    const type = typeOf("AccessPackageCatalogs")
    const setup = fixture(async request => {
      const url = new URL(request.url)
      if (!url.pathname.includes(type.path)) return scriptedGraph(intune)(request)
      if (url.pathname.endsWith(type.path)) return Response.json({ value: [{ id: "example" }] })
      if (url.pathname.endsWith("/accessPackageResources")) return Response.json({ value: [], "@odata.nextLink": `https://graph.microsoft.com/beta/${type.path}/example/accessPackageResources?$skiptoken=${Number(url.searchParams.get("$skiptoken") ?? 0) + 1}` })
      return Response.json({ id: url.pathname.split("/").pop() })
    })
    const job = await setup.run({ scope: only(type.folder, "DeviceConfigurations") })
    expect(setup.requests.filter(request => request.path.includes(type.path))).toHaveLength(500)
    expect(job.outcomes?.types.find(entry => entry.folder === type.folder)).toMatchObject({ outcome: "failed", error: expect.stringContaining("request budget") })
    expect(job.outcomes?.types.find(entry => entry.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved", saved: 1 })
    expect(job.outcomes?.coverage).toBe("incomplete")
  }, 20_000)

  it("cancels a pending Governance read with the backup", async () => {
    const type = typeOf("AccessPackageCatalogs")
    let signal: AbortSignal | undefined
    const setup = fixture(async request => {
      if (!new URL(request.url).pathname.includes(type.path)) return scriptedGraph(intune)(request)
      signal = request.signal
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
    })
    const pending = setup.run({ scope: only(type.folder, "DeviceConfigurations") })
    await until(() => !!signal)
    setup.engine.cancel(setup.engine.liveRuns("11111111-1111-1111-1111-111111111111")[0]!)
    const job = await pending
    expect(job.status).toBe("Cancelled")
    expect(signal?.aborted).toBe(true)
  })

  it("interrupts throttled object fan-out at the type deadline without ending the run", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    try {
      const type = typeOf("AccessPackageCatalogs")
      const setup = fixture(async request => {
        const url = new URL(request.url)
        if (!url.pathname.includes(type.path)) return scriptedGraph(intune)(request)
        if (url.pathname.endsWith(type.path)) return Response.json({ value: [{ id: "example" }] })
        return refusal(429, "TooManyRequests", "Throttled", { "Retry-After": "60" })()
      })
      const pending = setup.run({ scope: only(type.folder, "DeviceConfigurations") })
      await until(() => setup.requests.some(request => request.path.endsWith(type.path + "/example")))
      await vi.advanceTimersByTimeAsync(120_000)
      const job = await pending
      expect(job.outcomes?.types.find(entry => entry.folder === type.folder)).toMatchObject({ outcome: "failed", error: expect.stringContaining("time budget") })
      expect(job.outcomes?.types.find(entry => entry.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved", saved: 1 })
      expect(job.exception).toBeUndefined()
    } finally { vi.useRealTimers() }
  })
})
