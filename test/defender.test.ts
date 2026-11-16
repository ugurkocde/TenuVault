import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { DEFENDER_TYPES as TYPES } from "../src/shared/intune/defender"
import { INTUNE_TYPES, restoreCapability, type Item } from "../src/shared/intune/registry"
import { graphVersion, listPath, readObject } from "../src/shared/intune/read"
import { MODULE_BY_ID, moduleForFolder } from "../src/shared/services/modules"
import { backupTypeUse } from "../src/shared/services/backup-use"
import { adminCenterLink } from "../src/shared/intune/admin-links"
import { buildRestorePlan, buildUpdatePlan } from "../src/shared/intune/restore-plan"
import { sameSnapshot } from "../src/shared/intune/compare"
import { compareObjects } from "../src/portal/app/api/detect-drifts/route"
import { compareBackups } from "../src/shared/intune/backup-changes"
import { GraphSession } from "../src/main/backup/graph-session"
import { NetworkCircuit } from "../src/main/backup/engine"
import { fixture, scriptedGraph, refusal, TENANT } from "./helpers/backup-fixture"
import { readDefenderType, recorded, replay, type DefenderFixture } from "./helpers/defender"

const typeOf = (folder: string) => TYPES.find(type => type.folder === folder)!
const only = (...folders: string[]) => ({ excluded: INTUNE_TYPES.filter(type => !folders.includes(type.folder)).map(type => type.folder) })
const routes = (data: DefenderFixture) => Object.fromEntries(Object.entries(data.responses).map(([path, answer]) => [decodeURIComponent(path), () => typeof answer.body === "string" ? new Response(answer.body, { status: answer.status, headers: answer.headers }) : Response.json(structuredClone(answer.body), { status: answer.status, headers: answer.headers })]))
const secrets = /^(clientSecret|password|privateKey|sharedSecret|secretKey|tokenSeed|seed|tunnelKey|keyCredentials|passwordCredentials|secret|accessToken|refreshToken|clientAssertion|pfx|pkcs12|secretText|deploymentAccessKey)$/i
function scan(value: unknown): void {
  if (typeof value === "string") expect(value).not.toMatch(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|Bearer\s+[\w.-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|<RSAKeyValue>[\s\S]*<D>|data:application\/(?:x-pkcs12|pkcs12)/i)
  if (!value || typeof value !== "object") return
  for (const [key, entry] of Object.entries(value)) { expect(key).not.toMatch(secrets); scan(entry) }
}

it("requires every Entra and Defender manifest folder except the named pending directory types", () => {
  const pending = ["Groups", "Users", "EntraDevices", "OrgContacts", "Applications", "ServicePrincipals", "OAuth2PermissionGrants"]
  const missing = (["entra", "defender"] as const).flatMap(id => MODULE_BY_ID.get(id)!.areas.flatMap(area => area.folders)).filter(folder => !INTUNE_TYPES.some(type => type.folder === folder))
  expect(missing.sort()).toEqual(pending.sort())
  expect(TYPES.map(type => type.folder).sort()).toEqual(MODULE_BY_ID.get("defender")!.areas.flatMap(area => area.folders).sort())
})

for (const type of TYPES) describe(type.folder, () => {
  it("replays its recorded live answer through the production reader", async () => {
    const data = recorded(type.folder)
    const result = await readDefenderType(type, replay(data, type))
    expect(result.outcome).toBe(data.outcome)
    expect(result.objects).toHaveLength(data.objectCount)
    if ("cause" in result) expect(result.cause).toBe(data.cause)
    result.objects.forEach(scan)
  })
  it("saves documented configuration, compares it and refuses every restore", async () => {
    const setup = fixture(scriptedGraph(routes(recorded(type.folder, true))))
    const job = await setup.run({ scope: only(type.folder) })
    expect(job.outcomes).toMatchObject({ coverage: "complete", types: [{ outcome: "saved", saved: 1 }] })
    const files = (await setup.files(job)).filter(file => file.startsWith(type.folder + "/"))
    expect(files).toHaveLength(1)
    const object = (await setup.file(job, files[0]!))!
    scan(object)
    expect(sameSnapshot(object, structuredClone(object))).toBe(true)
    const changed = { ...object, isEnabled: !(object.isEnabled ?? false) }
    expect(sameSnapshot(object, changed)).toBe(false)
    expect(compareObjects(object, changed).some(change => change.field === "isEnabled")).toBe(true)
    expect(restoreCapability(type)).toBe("none")
    expect(() => buildRestorePlan(type, object)).toThrow()
    expect(() => buildUpdatePlan(type, object, "example")).toThrow()
    expect(moduleForFolder(type.folder)?.module.id).toBe("defender")
    expect(adminCenterLink(type.folder, "example")).toMatchObject({ center: "Defender", url: "https://security.microsoft.com", exact: false })
    expect(backupTypeUse(type)).toEqual({ policyCount: true, compare: true, hygiene: false, auditService: undefined })
    expect(setup.requests.every(request => !/getDeploymentAccessKey|\/report(?:\/|$)|\/runs(?:\/|$)/i.test(request.path))).toBe(true)
    expect(type.secrets).toBeUndefined()
  })
  it("strips credentials recursively and personal references on both stored read paths", async () => {
    const data = recorded(type.folder, true)
    for (const answer of Object.values(data.responses)) {
      if (typeof answer.body !== "object") continue
      const entries = Array.isArray(answer.body.value) ? answer.body.value as Item[] : [answer.body]
      for (const item of entries) Object.assign(item, { nested: [{ password: "fixture", privateKey: "fixture", enabled: true }], createdBy: { id: "person", displayName: "Private Person", email: "private@example.test" }, principal: { id: "person", displayName: "Private Person", mail: "private@example.test" } })
    }
    const result = await readDefenderType(type, replay(data, type))
    expect(result.objects).toHaveLength(1)
    for (const object of result.objects) {
      scan(object)
      expect(JSON.stringify(object)).not.toContain("Private Person")
      expect(JSON.stringify(object)).not.toContain("private@example.test")
    }
  })
})

describe("tenant-owned stable configuration", () => {
  for (const type of TYPES.filter(type => type.filter)) it(`${type.folder}: preserves the tenant filter on every page and refuses global list and detail content`, async () => {
    const first = `https://graph.microsoft.com/${graphVersion(type)}/${type.path}`
    const sent: URL[] = []
    const session = new GraphSession((async input => {
      const url = new URL(String(input)); sent.push(url)
      return Response.json(url.searchParams.has("$skiptoken") ? { value: [{ id: "global", source: "global" }] } : { value: [{ id: "tenant", source: "tenant" }], "@odata.nextLink": first + "?$skiptoken=second" })
    }) as typeof fetch, async () => "fixture", new NetworkCircuit(10), { service: "defender", isolated: true })
    const listed = await session.list(`https://graph.microsoft.com/${graphVersion(type)}/${listPath(type)}`, { filter: type.filter })
    expect(sent).toHaveLength(2)
    expect(sent.every(url => url.searchParams.get("$filter") === "source eq 'tenant'")).toBe(true)
    expect(listed.filter(item => !type.skip?.(item as Item)).map(item => item.id)).toEqual(["tenant"])
    await expect(readObject(type, "global", { get: async () => ({ id: "global", source: "global" }), list: async () => [] })).rejects.toThrow("non-tenant")
  })

  it("stores only tenant Secure Score state, omitting catalog, default state, people and update time", async () => {
    const type = typeOf("DefenderSecureScoreControlStates")
    const result = await readDefenderType(type, replay(recorded(type.folder, true), type))
    expect(result.objects[0]).toEqual({ id: "example", controlStateUpdates: [{ state: "Ignored", comment: "Accepted risk", assignedTo: { id: "00000000-0000-4000-8000-000000000001" }, updatedBy: { id: "00000000-0000-4000-8000-000000000001" } }] })
    expect(type.skip?.({ controlStateUpdates: [{ state: "Default" }] })).toBeTruthy()
    expect(type.skip?.({ controlStateUpdates: [] })).toBeTruthy()
    expect(() => type.skip?.({ id: "unread" })).toThrow("did not return")
  })

  it("does not store campaign reports, generated schedules or detection run state", async () => {
    for (const folder of ["DefenderCustomDetectionRules", "DefenderAttackSimulations", "DefenderAttackSimulationAutomations", "DefenderAttackSimulationTrainingCampaigns", "DefenderIdentitySensors"]) {
      const snapshots: Item[] = []
      const manifests = []
      for (const day of ["01", "02"]) {
        const data = recorded(folder, true)
        for (const answer of Object.values(data.responses)) if (typeof answer.body === "object" && answer.body.id === "example") {
          if (folder === "DefenderIdentitySensors") Object.assign(answer.body, { healthStatus: day, serviceStatus: day })
          else if (folder === "DefenderCustomDetectionRules") Object.assign(answer.body, { status: day, lastRunDetails: { run: day } })
          else Object.assign(answer.body, { status: day, lastRunDetails: { run: day }, lastRunDateTime: day, nextRunDateTime: day, report: { total: day }, runs: [{ id: day }] })
          if (folder === "DefenderCustomDetectionRules") answer.body.schedule = { period: "24H", nextRunDateTime: day }
        }
        const setup = fixture(scriptedGraph(routes(data)))
        const job = await setup.run({ scope: only(folder) })
        expect(job.outcomes?.coverage).toBe("complete")
        const file = (await setup.files(job)).find(file => file.startsWith(folder + "/"))!
        snapshots.push((await setup.file(job, file)) as Item)
        manifests.push((await setup.manifest(job)).Items)
      }
      expect(sameSnapshot(...snapshots as [Item, Item])).toBe(true)
      expect(compareObjects(snapshots[0]!, snapshots[1]!)).toEqual([])
      expect(compareBackups({ Status: "Success", Items: manifests[0] }, { Status: "Success", Items: manifests[1] })).toEqual([])
    }
  })

  it("keeps configured reporting mailboxes and reviewers by ID only", async () => {
    const type = typeOf("DefenderEmailSubmissionPolicies")
    const result = await readDefenderType(type, replay(recorded(type.folder, true), type))
    expect(result.objects[0]).toMatchObject({ customizedReportRecipientEmailAddress: "reporting@example.test", customizedNotificationSenderEmailAddress: "notifications@example.test", policyReviewers: [{ id: "00000000-0000-4000-8000-000000000001" }] })
  })

  it("sorts unordered object and ID sets but retains workbook document order", async () => {
    for (const type of TYPES) {
      if (type.folder === "DefenderWorkbooks") continue
      const objects: Item[] = []
      for (const reverse of [false, true]) {
        const data = recorded(type.folder, true)
        const shuffle = (value: unknown): void => {
          if (!value || typeof value !== "object") return
          if (Array.isArray(value)) { if (reverse) value.reverse(); value.forEach(shuffle) }
          else Object.values(value).forEach(shuffle)
        }
        shuffle(data.responses)
        objects.push((await readDefenderType(type, replay(data, type))).objects[0]!)
      }
      expect(sameSnapshot(...objects as [Item, Item]), type.folder).toBe(true)
    }
    const type = typeOf("DefenderWorkbooks")
    const result = await readDefenderType(type, replay(recorded(type.folder, true), type))
    expect((result.objects[0]!.content as Item).items).toEqual([{ type: "text", text: "First" }, { type: "text", text: "Second" }])
    await expect(readObject(type, "example", { get: async () => ({ id: "example" }), list: async () => [] })).rejects.toThrow("workbook content")
  })
})

describe("endpoint refusal and throttle isolation", () => {
  const intune = { "/beta/deviceManagement/deviceConfigurations": { value: [{ id: "intune", displayName: "Intune policy" }] }, "/beta/deviceManagement/deviceConfigurations/intune?$expand=assignments": { id: "intune", displayName: "Intune policy" } }
  for (const type of TYPES.filter(type => type.unavailable?.length)) it(`${type.folder}: declares only its own recorded availability refusal`, async () => {
    const data = recorded(type.folder)
    const setup = fixture(scriptedGraph({ ...intune, ...routes(data) }))
    const job = await setup.run({ scope: only(type.folder, "DeviceConfigurations") })
    expect(job.outcomes?.types.find(entry => entry.folder === type.folder)).toMatchObject({ outcome: "skipped", cause: "license" })
    expect(job.outcomes?.types.find(entry => entry.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved" })
    const pattern = type.unavailable![0]!
    for (const code of [pattern.code, "DifferentCode"]) {
      if (type.singleton && code === pattern.code) continue
      const root = `/${graphVersion(type)}/${type.path}`
      const ownList = code !== pattern.code
      const setup = fixture(scriptedGraph({ ...routes(recorded(type.folder, true)), [root + (ownList || type.singleton ? "" : "/example")]: refusal(pattern.status, code!, pattern.message!) }))
      const job = await setup.run({ scope: only(type.folder) })
      expect(job.outcomes?.types[0]?.outcome).toBe("failed")
    }
  })

  it("does not refresh or end the admin sign-in for the recorded submission 401 HTML page", async () => {
    const getToken = vi.fn(async (request: unknown) => { if ((request as { fresh?: boolean }).fresh) throw new Error("Sign-in must not refresh"); return "fixture" })
    const path = "/beta/security/threatSubmission/emailThreatSubmissionPolicies"
    const setup = fixture(scriptedGraph({ ...intune, [path]: () => new Response("<html>Access is denied due to invalid credentials.</html>", { status: 401, headers: { "content-type": "text/html" } }) }), { getToken })
    const job = await setup.run({ scope: only("DefenderEmailSubmissionPolicies", "DeviceConfigurations") })
    expect(job.outcomes?.types.find(entry => entry.folder === "DefenderEmailSubmissionPolicies")).toMatchObject({ outcome: "skipped", cause: "permission" })
    expect(job.outcomes?.types.find(entry => entry.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved" })
    expect(setup.requests.filter(request => request.path === path)).toHaveLength(1)
    expect(getToken.mock.calls.every(([request]) => !(request as { fresh?: boolean }).fresh)).toBe(true)
  })

  it.each(["DefenderRoleDefinitions", "DefenderRoleAssignments", "DefenderCustomDetectionRules"])("keeps the recorded %s permission answer separate", async folder => {
    const type = typeOf(folder)
    const setup = fixture(scriptedGraph({ ...intune, [`/${graphVersion(type)}/${type.path}`]: refusal(403, folder.includes("Role") ? "UnknownError" : "Forbidden", folder.includes("Role") ? "" : "Missing application roles. API required roles: CustomDetection.ReadWrite.All, CustomDetection.Read.All") }))
    const job = await setup.run({ scope: only(folder, "DeviceConfigurations") })
    expect(job.outcomes?.types.find(entry => entry.folder === folder)).toMatchObject({ outcome: "skipped", cause: "permission" })
    expect(job.outcomes?.types.find(entry => entry.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved" })
  })

  it("ends only the type on a failed sub-read and never writes or claims the parent", async () => {
    const type = typeOf("DefenderCaseTypeConfigurations")
    const setup = fixture(scriptedGraph({ ...routes(recorded(type.folder, true)), "/beta/security/caseManagement/caseTypeConfigurations/example/statuses": refusal(400, "badRequest", "Tenant's account is not active.") }))
    const job = await setup.run({ scope: only(type.folder) })
    expect(job.outcomes).toMatchObject({ coverage: "incomplete", types: [{ outcome: "failed", saved: 0 }] })
    expect((await setup.files(job)).some(file => file.startsWith(type.folder + "/"))).toBe(false)
  })

  it("caps a Defender object fan-out's actual requests without ending Intune", async () => {
    const type = typeOf("DefenderCaseTypeConfigurations")
    const setup = fixture(async request => {
      const url = new URL(request.url)
      if (!url.pathname.includes(type.path)) return scriptedGraph(intune)(request)
      if (url.pathname.endsWith(type.path)) return Response.json({ value: [{ id: "example" }] })
      if (url.pathname.endsWith("/example")) return Response.json({ id: "example" })
      return Response.json({ value: [], "@odata.nextLink": `https://graph.microsoft.com/beta/${type.path}/example/customFields?$skiptoken=${Number(url.searchParams.get("$skiptoken") ?? 0) + 1}` })
    })
    const job = await setup.run({ scope: only(type.folder, "DeviceConfigurations") })
    expect(setup.requests.filter(request => request.path.includes(type.path))).toHaveLength(500)
    expect(job.outcomes?.types.find(entry => entry.folder === type.folder)).toMatchObject({ outcome: "failed", error: expect.stringContaining("request budget") })
    expect(job.outcomes?.types.find(entry => entry.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved" })
  }, 20_000)

  it("pauses Defender on the real detection list while Intune continues, then ends only the budgeted type", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    try {
      const type = typeOf("DefenderCustomDetectionRules")
      const setup = fixture(async request => new URL(request.url).pathname.includes(type.path) ? refusal(429, "TooManyRequests", "Throttled", { "Retry-After": "60" })() : scriptedGraph(intune)(request))
      const pending = setup.run({ scope: only(type.folder, "DeviceConfigurations") })
      for (let i = 0; i < 1000 && !setup.requests.some(request => request.path === "/beta/deviceManagement/deviceConfigurations"); i++) await new Promise(resolve => setImmediate(resolve))
      expect(setup.requests.some(request => request.path === "/beta/deviceManagement/deviceConfigurations")).toBe(true)
      await vi.advanceTimersByTimeAsync(120_000)
      const job = await pending
      expect(job.outcomes?.types.find(entry => entry.folder === type.folder)).toMatchObject({ outcome: "failed", error: expect.stringContaining("time budget") })
      expect(job.outcomes?.types.find(entry => entry.folder === "DeviceConfigurations")).toMatchObject({ outcome: "saved", saved: 1 })
      expect(job.exception).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it("cancels the type budget with the backup", async () => {
    const type = typeOf("DefenderCustomDetectionRules")
    let signal: AbortSignal | undefined
    let reached!: () => void
    const reading = new Promise<void>(resolve => { reached = resolve })
    const setup = fixture(async request => {
      signal = request.signal
      reached()
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
    })
    const pending = setup.run({ scope: only(type.folder) })
    await reading
    expect(signal).toBeDefined()
    setup.engine.cancel(setup.engine.liveRuns(TENANT)[0]!)
    expect((await pending).status).toBe("Cancelled")
    expect(signal?.aborted).toBe(true)
  })
})

it("never allows action segments or binary secrets in Defender read declarations", () => {
  for (const type of TYPES) for (const path of [type.path, ...(type.extras ?? []).map(extra => extra.path("example"))]) expect(path).not.toMatch(/getDeploymentAccessKey|\/get[A-Z]|\/run(?:\/|$)|\/connect(?:\/|$)|\/modify(?:\/|$)|\/disconnect(?:\/|$)|\/reset(?:\/|$)|\/activate(?:\/|$)/)
})

it("keeps the legacy folder set without any Defender requests", async () => {
  const { ModuleSettings } = await import("../src/main/services/settings")
  const { includedTypes, LEGACY_FOLDERS } = await import("../src/shared/intune/scope")
  const selection = new ModuleSettings({ get: () => null, set: () => undefined, delete: () => undefined }).selection("old-tenant")
  const expected = JSON.parse(readFileSync(new URL("./fixtures/entra-5a/legacy-everything.json", import.meta.url), "utf8"))
  expect(includedTypes({ excluded: [] }, selection).map(type => type.folder)).toEqual(expected)
  expect(LEGACY_FOLDERS.some(folder => folder.startsWith("Defender"))).toBe(false)
  const setup = fixture(scriptedGraph({}), { services: () => selection })
  await setup.run({ scope: { excluded: [] } })
  expect(setup.requests.every(request => request.path.startsWith("/beta/device"))).toBe(true)
})
