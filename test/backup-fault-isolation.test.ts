import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { CONSECUTIVE_AUTH_FAILURE_LIMIT, NetworkCircuit } from "../src/main/backup/engine"
import { GraphSession } from "../src/main/backup/graph-session"
import { MODULES, type ModuleId, type ServiceModule } from "../src/shared/services/modules"
import { fixture, refusal, registerTestTypes, scriptedGraph, testType, type GraphRoute } from "./helpers/backup-fixture"
import { GRAPH_ANSWERS } from "./fixtures/graph-answers"

/**
 * One failing endpoint of Entra ID or Defender ends the type it belongs to, never the backup and
 * never Intune. Intune and Conditional Access keep every limit they had: any 401 ends the backup,
 * five consecutive 401 or 403 answers end it, a pause over five minutes fails every read after it.
 */

const UNITS = 20
const TYPES = [
  // Twenty objects, each with a sub-read.
  testType("AdministrativeUnits", "directory/administrativeUnits", { extras: [{ property: "members", path: (id) => `directory/administrativeUnits/${id}/members?$select=id`, ids: true }] }),
  testType("TokenLifetimePolicies", "policies/tokenLifetimePolicies", { listOnly: true }),
  testType("DefenderSecureScoreControlStates", "security/secureScoreControlProfiles", { listOnly: true }),
  testType("DefenderCustomDetectionRules", "security/rules/detectionRules", { listOnly: true }),
]

let unregister: () => void
beforeAll(() => {
  unregister = registerTestTypes(TYPES)
})
afterAll(() => unregister())

const ORIGINAL = new Map(MODULES.map((module) => [module.id, module.isolated]))
/** Changes whether a service isolates its failures, to prove the engine asks the service and not its name. */
function withIsolation(id: ModuleId, isolated: boolean): void {
  ;(MODULES.find((module) => module.id === id) as ServiceModule).isolated = isolated
}
afterEach(() => {
  for (const module of MODULES) (module as ServiceModule).isolated = ORIGINAL.get(module.id)!
  vi.useRealTimers()
})

const realTimeout = setTimeout
/**
 * Waits for `work` while the test's clock runs a hundred times faster than the real one, so the
 * seconds between the attempts of a request cost none. The store still writes real files, which
 * the real pause between the steps leaves time for.
 */
async function elapse<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  let settled = false
  const result = work()
  result.then(() => (settled = true), () => (settled = true))
  while (!settled) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise((resolve) => realTimeout(resolve, 1))
  }
  return result
}

const noAnswer = () => {
  throw new TypeError("Connection reset")
}

const units = Array.from({ length: UNITS }, (_, index) => ({ id: `au${index + 1}`, displayName: `Unit ${index + 1}` }))

/** A tenant with Intune, Entra ID and Defender objects; `routes` injects the fault. */
function tenant(routes: Record<string, GraphRoute> = {}) {
  return scriptedGraph({
    "/beta/deviceManagement/deviceCompliancePolicies": { value: [{ id: "cp1", displayName: "Compliance" }] },
    "/beta/deviceManagement/deviceCompliancePolicies/cp1?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations),assignments": { id: "cp1", displayName: "Compliance" },
    "/beta/deviceManagement/deviceCategories": { value: [{ id: "cat1", displayName: "Kiosk" }] },
    "/beta/deviceManagement/deviceCategories/cat1": { id: "cat1", displayName: "Kiosk" },
    "/beta/directory/administrativeUnits": { value: units },
    ...Object.fromEntries(units.flatMap((unit) => [
      [`/beta/directory/administrativeUnits/${unit.id}`, unit],
      [`/beta/directory/administrativeUnits/${unit.id}/members?$select=id`, { value: [{ id: "m1" }] }],
    ])),
    "/beta/policies/tokenLifetimePolicies": { value: [{ id: "tl1", displayName: "Lifetime" }] },
    "/beta/security/secureScoreControlProfiles": { value: [{ id: "ss1", displayName: "MFA" }] },
    "/beta/security/rules/detectionRules": { value: [{ id: "dr1", displayName: "Rule" }] },
    ...routes,
  })
}

const outcomeOf = (job: { outcomes?: { types: Array<{ folder: string }> } }, folder: string) => job.outcomes!.types.find((type) => type.folder === folder) as Record<string, unknown>
const intuneSaved = async (files: string[]) => {
  expect(files).toContain("CompliancePolicies/Compliance.json")
  expect(files).toContain("DeviceCategories/Kiosk.json")
}

describe("a failing Entra ID or Defender endpoint", () => {
  it("ends its type on a 401 HTML page; Intune, the rest of Entra ID and Defender are saved", async () => {
    const html = GRAPH_ANSWERS.find((answer) => answer.name.startsWith("an HTML page"))!
    const { run, files, manifest } = fixture(tenant({ "/beta/policies/tokenLifetimePolicies": () => new Response(html.body, { status: 401, headers: { "content-type": "text/html" } }) }))
    const job = await run()
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    const saved = await files(job)
    await intuneSaved(saved)
    expect(saved.filter((name) => name.startsWith("AdministrativeUnits/"))).toHaveLength(UNITS)
    expect(saved).toContain("DefenderSecureScoreControlStates/MFA.json")
    expect(outcomeOf(job, "TokenLifetimePolicies")).toMatchObject({ outcome: "skipped", cause: "permission", status: 401, service: "entra" })
    // Left out, not failed: the backup is usable and says what it does not hold.
    expect(await manifest(job)).toMatchObject({ Status: "Success", Failures: 0, SkippedTypes: ["TokenLifetimePolicies"], FailedTypes: [], Coverage: "Incomplete" })
    expect(job.coverage).toBe("incomplete")
  })

  it("ends its type on twenty 403 answers to sub-reads, after the first one, and reads no further object of it", async () => {
    const refused = refusal(403, "Authorization_RequestDenied", "Insufficient privileges to complete the operation.")
    const { run, files, manifest, requests } = fixture(tenant(Object.fromEntries(units.map((unit) => [`/beta/directory/administrativeUnits/${unit.id}/members?$select=id`, refused]))))
    const job = await run()
    expect(job.status).toBe("Completed")
    const saved = await files(job)
    await intuneSaved(saved)
    expect(saved).toContain("TokenLifetimePolicies/Lifetime.json")
    expect(saved).toContain("DefenderSecureScoreControlStates/MFA.json")
    // No unit is stored without its members, and none with an empty member list.
    expect(saved.some((name) => name.startsWith("AdministrativeUnits/"))).toBe(false)
    // At most the reads that were already under way when the first refusal came back: never all twenty.
    const subReads = requests.filter((request) => request.path.includes("/members")).length
    expect(subReads).toBeGreaterThan(0)
    expect(subReads).toBeLessThanOrEqual(8)
    expect(outcomeOf(job, "AdministrativeUnits")).toMatchObject({ outcome: "skipped", cause: "permission", status: 403, code: "Authorization_RequestDenied" })
    expect(job.results!.types.find((type) => type.folder === "AdministrativeUnits")).toMatchObject({ state: "skipped", saved: 0, failed: 0 })
    expect(await manifest(job)).toMatchObject({ Status: "Success", Failures: 0, SkippedTypes: ["AdministrativeUnits"], Coverage: "Incomplete" })
  })

  it("ends its type on a 429 with a ten minute Retry-After, without waiting and without stopping the service's other types", async () => {
    const started = Date.now()
    const { run, files, manifest, requests } = fixture(tenant({ "/beta/directory/administrativeUnits": () => new Response("", { status: 429, headers: { "retry-after": "600" } }) }))
    const job = await run()
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(job.status).toBe("Completed")
    const saved = await files(job)
    await intuneSaved(saved)
    // The same service's other type was read after the long pause was asked for.
    expect(saved).toContain("TokenLifetimePolicies/Lifetime.json")
    expect(saved).toContain("DefenderSecureScoreControlStates/MFA.json")
    expect(requests.filter((request) => request.path === "/beta/directory/administrativeUnits")).toHaveLength(1)
    expect(outcomeOf(job, "AdministrativeUnits")).toMatchObject({ outcome: "failed", error: "The service requested a retry delay longer than 5 minutes. Retry this backup later.", saved: 0 })
    // Could not be read, which is a failure a later run may not have: the status says so, as it does for Intune.
    expect(await manifest(job)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1, FailedTypes: ["AdministrativeUnits"], SkippedTypes: [], Coverage: "Incomplete" })
  })

  it("ends its type when an object read is asked to wait ten minutes, and sends no further request for it", async () => {
    const { run, requests, files } = fixture(tenant({ "/beta/directory/administrativeUnits/au1": () => new Response("", { status: 429, headers: { "retry-after": "600" } }) }), { concurrency: 1 })
    const job = await run()
    expect(job.status).toBe("Completed")
    expect(requests.filter((request) => request.path.startsWith("/beta/directory/administrativeUnits/")).map((request) => request.path)).toEqual(["/beta/directory/administrativeUnits/au1"])
    expect(outcomeOf(job, "AdministrativeUnits")).toMatchObject({ outcome: "failed", saved: 0 })
    await intuneSaved(await files(job))
  })

  it("keeps the objects saved before a refusal, and says how many", async () => {
    const { run, files, manifest } = fixture(tenant({ "/beta/directory/administrativeUnits/au3/members?$select=id": refusal(403, "Forbidden", "Access denied.") }), { concurrency: 1 })
    const job = await run()
    expect((await files(job)).filter((name) => name.startsWith("AdministrativeUnits/")).sort()).toEqual(["AdministrativeUnits/Unit 1.json", "AdministrativeUnits/Unit 2.json"])
    expect(outcomeOf(job, "AdministrativeUnits")).toMatchObject({ outcome: "skipped", saved: 2 })
    const metadata = await manifest(job)
    // The manifest lists what is stored, and marks the folder as not covered.
    expect(metadata.ItemCounts.AdministrativeUnits).toBe(2)
    expect(metadata.SkippedTypes).toEqual(["AdministrativeUnits"])
    expect(metadata.Outcomes.find((entry: { Folder: string }) => entry.Folder === "AdministrativeUnits")).toMatchObject({ Outcome: "skipped", Saved: 2 })
  })

  it("counts an object that could not be read for another reason as a failure, and goes on with the type", async () => {
    const { run, files, manifest } = fixture(tenant({ "/beta/directory/administrativeUnits/au3": refusal(400, "BadRequest", "Malformed") }))
    const job = await run()
    expect((await files(job)).filter((name) => name.startsWith("AdministrativeUnits/"))).toHaveLength(UNITS - 1)
    expect(outcomeOf(job, "AdministrativeUnits")).toMatchObject({ outcome: "failed", saved: UNITS - 1, error: expect.stringContaining("1 of 20 could not be saved.") })
    expect(await manifest(job)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1, FailedTypes: [], Coverage: "Incomplete" })
  })

  it.each([
    ["a tenant that never onboarded the product", "license"],
    ["a product that is not active in the tenant", "license"],
    ["application roles named in the refusal", "permission"],
    ["a refusal with no body at all", "permission"],
  ])("leaves the type out for %s, with the cause %s", async (name, cause) => {
    const answer = GRAPH_ANSWERS.find((entry) => entry.name.startsWith(name))!
    const { run, manifest } = fixture(tenant({ "/beta/security/rules/detectionRules": () => new Response(answer.body, { status: answer.status }) }))
    const job = await run()
    expect(outcomeOf(job, "DefenderCustomDetectionRules")).toMatchObject({ outcome: "skipped", cause, status: answer.status, service: "defender" })
    expect(await manifest(job)).toMatchObject({ Status: "Success", Failures: 0, SkippedTypes: ["DefenderCustomDetectionRules"] })
    expect(job.results!.types.find((type) => type.folder === "DefenderSecureScoreControlStates")).toMatchObject({ state: "saved", saved: 1 })
  })

  it("names the account's role when the token holds the permission and Microsoft still refuses", async () => {
    const scopes = "DeviceManagementConfiguration.Read.All DeviceManagementManagedDevices.Read.All AdministrativeUnit.Read.All RoleManagement.Read.Directory Policy.Read.All SecurityEvents.Read.All CustomDetection.Read.All"
    const token = `e30.${Buffer.from(JSON.stringify({ scp: scopes })).toString("base64url")}.sig`
    const { run } = fixture(tenant({ "/beta/security/rules/detectionRules": refusal(403, "Forbidden", "Access denied.") }), { getToken: async () => token })
    const job = await run()
    expect(outcomeOf(job, "DefenderCustomDetectionRules")).toMatchObject({ outcome: "skipped", cause: "role" })
    expect(job.results!.types.find((type) => type.folder === "DefenderCustomDetectionRules")!.reason).toBe('Microsoft refused the read although the permission is granted: "Access denied.". Your account may not have a role that can read Defender (Security Reader or Global Reader to back up).')
  })

  it("still stops the backup when the sign-in itself fails, whichever service asks first", async () => {
    let calls = 0
    const { run } = fixture(tenant(), { services: () => ({ services: ["entra"] }), getToken: async () => { if (++calls > 1) throw new Error("AADSTS50076: sign in again"); return "token" } })
    const job = await run()
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("AADSTS50076")
  })

  it("fails the backup of a tenant without Intune when nothing at all could be read", async () => {
    const down = refusal(400, "BadRequest", "Broken")
    const { run, manifest } = fixture(tenant({ "/beta/directory/administrativeUnits": down, "/beta/policies/tokenLifetimePolicies": down }), { services: () => ({ services: ["entra"] }) })
    const job = await run()
    expect(job.status).toBe("Failed")
    expect(await manifest(job)).toMatchObject({ Status: "Failed", Failures: 2, Coverage: "Incomplete" })
  })
})

describe("an Entra ID or Defender endpoint that does not answer", () => {
  it("ends its type after the attempts of one request; Intune, the rest of Entra ID and Defender are saved", async () => {
    const { run, files, manifest, requests } = fixture(tenant({ "/beta/policies/tokenLifetimePolicies": noAnswer }), { concurrency: 2 })
    const job = await elapse(run)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    expect(requests.filter((request) => request.path === "/beta/policies/tokenLifetimePolicies")).toHaveLength(3)
    const saved = await files(job)
    await intuneSaved(saved)
    expect(saved.filter((name) => name.startsWith("AdministrativeUnits/"))).toHaveLength(UNITS)
    expect(saved).toContain("DefenderSecureScoreControlStates/MFA.json")
    expect(outcomeOf(job, "TokenLifetimePolicies")).toMatchObject({ outcome: "failed", error: "Connection reset", saved: 0, service: "entra" })
    expect(await manifest(job)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1, FailedTypes: ["TokenLifetimePolicies"], SkippedTypes: [], Coverage: "Incomplete" })
  })

  it("does not end the backup after three failures with one reader, as the same failures of an Intune endpoint do", async () => {
    // With one reader, three requests in a row without an answer stop a backup.
    const entra = fixture(tenant({ "/beta/policies/tokenLifetimePolicies": noAnswer }), { concurrency: 1 })
    const job = await elapse(entra.run)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    const saved = await entra.files(job)
    await intuneSaved(saved)
    expect(saved).toContain("DefenderSecureScoreControlStates/MFA.json")
    expect(saved).toContain("DefenderCustomDetectionRules/Rule.json")
    // The limit is the service's own now: Entra ID stopped, and nothing more was asked of it.
    expect(outcomeOf(job, "TokenLifetimePolicies")).toMatchObject({ outcome: "failed", error: "Microsoft Graph did not respond for 3 consecutive requests of this service, so the rest of the service was not read." })
    expect(outcomeOf(job, "AdministrativeUnits")).toMatchObject({ outcome: "failed", saved: 0 })
    expect(entra.requests.filter((request) => request.path.startsWith("/beta/directory/administrativeUnits/"))).toHaveLength(0)
    expect(await entra.manifest(job)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 2, FailedTypes: ["TokenLifetimePolicies", "AdministrativeUnits"] })

    const intune = fixture(tenant({ "/beta/deviceManagement/deviceCategories": noAnswer }), { concurrency: 1 })
    const stopped = await elapse(intune.run)
    expect(stopped.status).toBe("Failed")
    expect(stopped.exception).toBe("Backup stopped: Microsoft Graph did not respond for 3 consecutive requests. Earlier policies in this run were saved; the backup is incomplete.")
  })

  it("stops the service, and only it, after as many unanswered requests in a row as stop a backup", async () => {
    const { run, files, manifest, requests } = fixture(tenant({ "/beta/directory/administrativeUnits": noAnswer, "/beta/policies/tokenLifetimePolicies": noAnswer }), { concurrency: 2 })
    const job = await elapse(run)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    // Two readers, three attempts each: the sixth unanswered request in a row is the last one sent to Entra ID.
    expect(requests.filter((request) => request.path.startsWith("/beta/directory") || request.path.startsWith("/beta/policies"))).toHaveLength(6)
    const saved = await files(job)
    await intuneSaved(saved)
    expect(saved).toContain("DefenderSecureScoreControlStates/MFA.json")
    expect(outcomeOf(job, "AdministrativeUnits")).toMatchObject({ outcome: "failed", saved: 0 })
    expect(outcomeOf(job, "TokenLifetimePolicies")).toMatchObject({ outcome: "failed", saved: 0 })
    expect(outcomeOf(job, "DefenderSecureScoreControlStates")).toMatchObject({ outcome: "saved", saved: 1 })
    expect(await manifest(job)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 2, Coverage: "Incomplete" })
  })

  it("ends its type when an object read gets no answer, keeps what was saved before and asks for no further object of it", async () => {
    const slow = (unit: { id: string }) => () => new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json(unit)), 2_000))
    const { run, files, manifest, requests } = fixture(tenant({
      ...Object.fromEntries(units.map((unit) => [`/beta/directory/administrativeUnits/${unit.id}`, slow(unit)])),
      "/beta/directory/administrativeUnits/au3": noAnswer,
    }), { concurrency: 2 })
    const job = await elapse(run)
    expect(job.status).toBe("Completed")
    expect(requests.filter((request) => request.path === "/beta/directory/administrativeUnits/au3")).toHaveLength(3)
    // The other reader got a unit or two further in the three seconds the attempts took; the rest was never asked for.
    const asked = new Set(requests.filter((request) => /administrativeUnits\/au\d+$/.test(request.path)).map((request) => request.path.split("/").pop()))
    expect(asked.size).toBeLessThan(10)
    const saved = (await files(job)).filter((name) => name.startsWith("AdministrativeUnits/"))
    expect(saved).toContain("AdministrativeUnits/Unit 1.json")
    expect(saved).not.toContain("AdministrativeUnits/Unit 3.json")
    expect(outcomeOf(job, "AdministrativeUnits")).toMatchObject({ outcome: "failed", error: "Connection reset", saved: saved.length })
    // One unanswered request ends its type, not its service.
    expect(await files(job)).toContain("TokenLifetimePolicies/Lifetime.json")
    await intuneSaved(await files(job))
    expect(await manifest(job)).toMatchObject({ Status: "CompletedWithWarnings", Failures: 1, FailedTypes: ["AdministrativeUnits"] })
  })

  it("counts apart from Intune: its answers do not end a streak of unanswered Intune requests", async () => {
    vi.useFakeTimers()
    const circuit = new NetworkCircuit(4)
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/intune")) throw new TypeError("Connection reset")
      return Response.json({ ok: true })
    }) as typeof fetch
    const intune = new GraphSession(fetchImpl, async () => "token", circuit, { service: "intune" })
    const entra = new GraphSession(fetchImpl, async () => "token", circuit, { service: "entra", isolated: true })
    const settled = (request: Promise<unknown>) => request.then(() => "answered", (error: Error) => error.message)
    const first = settled(intune.get("https://graph.microsoft.com/beta/intune"))
    await vi.advanceTimersByTimeAsync(3_000)
    // Three attempts without an answer: one short of the limit.
    await expect(first).resolves.toBe("Connection reset")
    await expect(entra.get("https://graph.microsoft.com/beta/entra")).resolves.toEqual({ ok: true })
    // The fourth in a row stops the backup, whatever Entra ID answered in between.
    await expect(settled(intune.get("https://graph.microsoft.com/beta/intune"))).resolves.toContain("Microsoft Graph did not respond for 4 consecutive requests")
  })
})

describe("a sign-in that ended during a backup", () => {
  const expired = refusal(401, "InvalidAuthenticationToken", "Access token has expired or is not yet valid.")
  const html = () => new Response("<html><title>401 - Unauthorized: Access is denied due to invalid credentials.</title></html>", { status: 401, headers: { "content-type": "text/html" } })
  /** The sign-in as the engine asks for it: the cached token, or one Microsoft issues now. */
  const signIn = (fresh: () => Promise<string> = async () => "fresh") => {
    const asked: boolean[] = []
    return { asked, getToken: async (_tenant: string, _client: string, _scope: string, wantsFresh?: boolean) => (asked.push(wantsFresh === true), wantsFresh ? fresh() : "token") }
  }

  it("ends the backup when an Entra ID or Defender list is answered with a token error, like an Intune one", async () => {
    const { run, requests, manifest } = fixture(tenant({ "/beta/policies/tokenLifetimePolicies": expired }))
    const job = await run()
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Access token has expired or is not yet valid.")
    // Not a type that was left out or failed on its own: the run stopped.
    expect(outcomeOf(job, "TokenLifetimePolicies")).toMatchObject({ outcome: "failed", error: "The backup stopped before this type was read in full." })
    expect(job.outcomes).toMatchObject({ status: "Failed", coverage: "incomplete" })
    expect(requests.filter((request) => request.path === "/beta/policies/tokenLifetimePolicies")).toHaveLength(1)
    // No object was asked for with a sign-in Microsoft refused.
    expect(requests.some((request) => request.path.startsWith("/beta/directory/administrativeUnits/"))).toBe(false)
    expect(await manifest(job).catch(() => null)).toBeNull()
  })

  it("ends the backup at the first object of an Entra ID type that is answered with a token error, instead of failing each object", async () => {
    const { run, requests, manifest } = fixture(tenant(Object.fromEntries(units.map((unit) => [`/beta/directory/administrativeUnits/${unit.id}`, expired]))), { concurrency: 1 })
    const job = await run()
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Access token has expired or is not yet valid.")
    expect(requests.filter((request) => request.path.startsWith("/beta/directory/administrativeUnits/")).map((request) => request.path)).toEqual(["/beta/directory/administrativeUnits/au1"])
    expect(await manifest(job)).toMatchObject({ Status: "Failed", Error: "Access token has expired or is not yet valid." })
  })

  it("ends the backup when the token error comes after the type had already ended", async () => {
    // The first unit is refused, which ends the type; the unit read next to it is answered with a token error a moment later.
    let secondAsked: () => void = () => undefined
    const bothUnderWay = new Promise<void>((resolve) => { secondAsked = resolve })
    const { run, requests } = fixture(tenant({
      "/beta/directory/administrativeUnits/au1": async () => {
        await bothUnderWay
        return refusal(403, "Authorization_RequestDenied", "Insufficient privileges to complete the operation.")()
      },
      "/beta/directory/administrativeUnits/au2": async () => {
        secondAsked()
        await new Promise((resolve) => setTimeout(resolve, 50))
        return expired()
      },
    }), { concurrency: 2 })
    const job = await run()
    expect(requests.some((request) => request.path === "/beta/directory/administrativeUnits/au3")).toBe(false)
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Access token has expired or is not yet valid.")
  })

  it("takes a 401 without a token error as the endpoint's own answer once the same request got it again with a new token", async () => {
    const { asked, getToken } = signIn()
    const { run, requests, files, manifest } = fixture(tenant({ "/beta/policies/tokenLifetimePolicies": html }), { getToken })
    const job = await run()
    expect(job.status).toBe("Completed")
    const sent = requests.filter((request) => request.path === "/beta/policies/tokenLifetimePolicies")
    expect(sent.map((request) => request.headers.get("Authorization"))).toEqual(["Bearer token", "Bearer fresh"])
    // One new token for the one repeat, and the cached sign-in for everything else.
    expect(asked.filter(Boolean)).toHaveLength(1)
    expect(outcomeOf(job, "TokenLifetimePolicies")).toMatchObject({ outcome: "skipped", cause: "permission", status: 401 })
    await intuneSaved(await files(job))
    expect(await manifest(job)).toMatchObject({ Status: "Success", SkippedTypes: ["TokenLifetimePolicies"], Coverage: "Incomplete" })
  })

  it("ends the backup as a sign-in failure when no new token can be had after such a 401", async () => {
    const { getToken } = signIn(async () => { throw new Error("AADSTS700082: The refresh token has expired due to inactivity.") })
    const { run, requests } = fixture(tenant({ "/beta/policies/tokenLifetimePolicies": html }), { getToken })
    const job = await run()
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("AADSTS700082")
    // The type was not left out for a permission it may well have.
    expect(outcomeOf(job, "TokenLifetimePolicies")).toMatchObject({ outcome: "failed", error: "The backup stopped before this type was read in full." })
    expect(requests.filter((request) => request.path === "/beta/policies/tokenLifetimePolicies")).toHaveLength(1)
  })

  it("reads the type after all when the new token is answered, because the 401 was the old token's", async () => {
    const { getToken } = signIn()
    const { run, files } = fixture(tenant({
      "/beta/policies/tokenLifetimePolicies": (request: Request) => (request.headers.get("Authorization") === "Bearer fresh" ? Response.json({ value: [{ id: "tl1", displayName: "Lifetime" }] }) : html()),
    }), { getToken })
    const job = await run()
    expect(await files(job)).toContain("TokenLifetimePolicies/Lifetime.json")
    expect(outcomeOf(job, "TokenLifetimePolicies")).toMatchObject({ outcome: "saved", saved: 1 })
  })

  it("ends the backup when the new token is answered with a token error", async () => {
    const { getToken } = signIn()
    const { run } = fixture(tenant({
      "/beta/policies/tokenLifetimePolicies": (request: Request) => (request.headers.get("Authorization") === "Bearer fresh" ? expired() : html()),
    }), { getToken })
    const job = await run()
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Access token has expired or is not yet valid.")
  })

  it("asks an object read and a sub-read once more in the same way, and ends the type on the confirmed answer", async () => {
    const { asked, getToken } = signIn()
    const { run, requests, files } = fixture(tenant({ "/beta/directory/administrativeUnits/au1/members?$select=id": html }), { getToken, concurrency: 1 })
    const job = await run()
    expect(job.status).toBe("Completed")
    expect(requests.filter((request) => request.path.includes("/members")).map((request) => [request.path, request.headers.get("Authorization")])).toEqual([
      ["/beta/directory/administrativeUnits/au1/members?$select=id", "Bearer token"],
      ["/beta/directory/administrativeUnits/au1/members?$select=id", "Bearer fresh"],
    ])
    expect(asked.filter(Boolean)).toHaveLength(1)
    expect(outcomeOf(job, "AdministrativeUnits")).toMatchObject({ outcome: "skipped", cause: "permission", status: 401 })
    await intuneSaved(await files(job))
  })

  it("asks the Backup Reader for a new token in the same way", async () => {
    const asked: Array<{ fresh?: boolean } | undefined> = []
    const { run, requests } = fixture(tenant({ "/beta/security/rules/detectionRules": html }), {
      unattendedTokens: () => ({
        mode: "app-only",
        graph: async (options) => (asked.push(options), options?.fresh ? "fresh" : "opaque"),
        storage: async () => "storage",
      }),
    })
    const job = await run({ trigger: "scheduled" })
    expect(job.status).toBe("Completed")
    expect(asked.filter((options) => options?.fresh)).toHaveLength(1)
    expect(requests.filter((request) => request.path === "/beta/security/rules/detectionRules").map((request) => request.headers.get("Authorization"))).toEqual(["Bearer opaque", "Bearer fresh"])
    expect(outcomeOf(job, "DefenderCustomDetectionRules")).toMatchObject({ outcome: "skipped", cause: "permission" })
  })

  it("never asks an Intune read once more: any 401 ends the backup as before", async () => {
    const { asked, getToken } = signIn()
    const { run, requests } = fixture(tenant({ "/beta/deviceManagement/deviceCategories": html }), { getToken })
    const job = await run()
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Microsoft Graph returned 401")
    expect(requests.filter((request) => request.path === "/beta/deviceManagement/deviceCategories")).toHaveLength(1)
    expect(asked.some(Boolean)).toBe(false)
  })
})

describe("Intune and Conditional Access", () => {
  it("still end the backup on a 401, also in a tenant with Entra ID and Defender", async () => {
    const { run, manifest } = fixture(tenant({ "/beta/deviceManagement/deviceCategories": refusal(401, "InvalidAuthenticationToken", "Access token has expired or is not yet valid.") }))
    const job = await run()
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Access token has expired or is not yet valid.")
    // The run stopped: every type it had not finished is recorded as not read.
    expect(outcomeOf(job, "DeviceCategories")).toMatchObject({ outcome: "failed", error: "The backup stopped before this type was read in full." })
    expect(job.coverage).toBe("incomplete")
    expect(job.outcomes).toMatchObject({ status: "Failed", runId: job.id })
    expect(await manifest(job).catch(() => null)).toBeNull()
  })

  it("still end the backup after five consecutive 403 answers to Intune reads", async () => {
    const categories = Array.from({ length: 12 }, (_, index) => ({ id: `cat${index}`, displayName: `Category ${index}` }))
    const { run, requests } = fixture(tenant({
      "/beta/deviceManagement/deviceCategories": { value: categories },
      ...Object.fromEntries(categories.map((category) => [`/beta/deviceManagement/deviceCategories/${category.id}`, refusal(403, "Forbidden", "No role")])),
    }), { concurrency: 1 })
    const job = await run()
    expect(job.status).toBe("Failed")
    expect(requests.filter((request) => request.path.startsWith("/beta/deviceManagement/deviceCategories/"))).toHaveLength(CONSECUTIVE_AUTH_FAILURE_LIMIT)
  })

  it("still fail every later Intune read after a pause of more than five minutes, while Entra ID and Defender read on", async () => {
    const { run, files, manifest } = fixture(tenant({ "/beta/deviceManagement/deviceCompliancePolicies": () => new Response("", { status: 429, headers: { "retry-after": "600" } }) }), { concurrency: 1 })
    const job = await run()
    const saved = await files(job)
    // Intune: nothing after the pause was read, as before.
    expect(saved.some((name) => name.startsWith("DeviceCategories/"))).toBe(false)
    const metadata = await manifest(job)
    expect(metadata.FailedTypes).toEqual(expect.arrayContaining(["CompliancePolicies", "DeviceCategories", "ScopeTags"]))
    // The other services have their own throttle state.
    expect(saved.filter((name) => name.startsWith("AdministrativeUnits/"))).toHaveLength(UNITS)
    expect(saved).toContain("DefenderSecureScoreControlStates/MFA.json")
  })

  it("end the backup or the type by what the service says of itself, not by its name", async () => {
    // Entra ID without isolation behaves like Intune: a 401 ends the backup.
    withIsolation("entra", false)
    const stopped = await fixture(tenant({ "/beta/policies/tokenLifetimePolicies": refusal(401, "Unauthorized", "Auth failed") })).run()
    expect(stopped.status).toBe("Failed")
    // Intune with isolation behaves like Entra ID: the type ends, the backup goes on.
    withIsolation("entra", true)
    withIsolation("intune", true)
    const isolated = fixture(tenant({ "/beta/deviceManagement/deviceCategories": refusal(401, "Unauthorized", "Auth failed") }))
    const job = await isolated.run()
    expect(job.status).toBe("Completed")
    expect(outcomeOf(job, "DeviceCategories")).toMatchObject({ outcome: "skipped", cause: "permission" })
    expect(await isolated.files(job)).toContain("CompliancePolicies/Compliance.json")
  })

  it("isolate nothing today, and Entra ID and Defender do", () => {
    expect(Object.fromEntries(MODULES.map((module) => [module.id, module.isolated]))).toEqual({ intune: false, conditionalAccess: false, entra: true, defender: true })
  })
})

describe("auth failure and throttle state per service", () => {
  it("counts refusals of one service apart from another's, and a success only ends its own service's count", () => {
    const circuit = new NetworkCircuit(100)
    const stop = "Backup stopped"
    for (let i = 0; i < CONSECUTIVE_AUTH_FAILURE_LIMIT - 1; i++) circuit.authFailed("Microsoft Graph", 403, stop, "intune")
    // Twenty refusals and a success elsewhere change nothing for Intune.
    for (let i = 0; i < CONSECUTIVE_AUTH_FAILURE_LIMIT - 1; i++) circuit.authFailed("Microsoft Graph", 403, stop, "conditionalAccess")
    circuit.succeeded("Microsoft Graph", "entra")
    circuit.succeeded("Microsoft Graph", "conditionalAccess")
    expect(() => circuit.authFailed("Microsoft Graph", 403, stop, "intune")).toThrow(stop)
  })

  it("pauses the readers of the throttled service only", async () => {
    const circuit = new NetworkCircuit(100)
    const controller = new AbortController()
    const paused = new NetworkCircuit(100, controller.signal)
    let throttled = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/entra") && throttled++ === 0) return new Response("", { status: 429, headers: { "retry-after": "120" } })
      return Response.json({ id: url })
    }) as typeof fetch
    const entra = new GraphSession(fetchImpl, async () => "token", paused, { service: "entra", isolated: true })
    const defender = new GraphSession(fetchImpl, async () => "token", circuit, { service: "defender", isolated: true })
    // Entra ID is told to wait two minutes and does.
    const waiting = entra.get("https://graph.microsoft.com/beta/entra").then(() => "answered", () => "stopped")
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Defender reads at once.
    await expect(defender.get("https://graph.microsoft.com/beta/defender")).resolves.toEqual({ id: "https://graph.microsoft.com/beta/defender" })
    await expect(Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50))])).resolves.toBe("still waiting")
    controller.abort(new Error("test over"))
    await expect(waiting).resolves.toBe("stopped")
  })

  it("lets a service that isolates its failures read on after one request was asked to wait too long", async () => {
    const answers = [new Response("", { status: 429, headers: { "retry-after": "600" } }), Response.json({ ok: true })]
    const fetchImpl = (async () => answers.shift()!) as typeof fetch
    const isolated = new GraphSession(fetchImpl, async () => "token", new NetworkCircuit(100), { service: "entra", isolated: true })
    await expect(isolated.get("https://graph.microsoft.com/beta/a")).rejects.toThrow("longer than 5 minutes")
    await expect(isolated.get("https://graph.microsoft.com/beta/b")).resolves.toEqual({ ok: true })
    // Without isolation the pause holds for the whole session, and no further request is sent.
    let sent = 0
    const shared = new GraphSession((async () => (sent++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "600" } }) : Response.json({ ok: true }))) as typeof fetch, async () => "token", new NetworkCircuit(100), { service: "intune" })
    await expect(shared.get("https://graph.microsoft.com/beta/a")).rejects.toThrow("longer than 5 minutes")
    await expect(shared.get("https://graph.microsoft.com/beta/b")).rejects.toThrow("longer than 5 minutes")
    expect(sent).toBe(1)
  })
})
