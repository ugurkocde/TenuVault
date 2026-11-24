import { describe, expect, it } from "vitest"
import { evaluateHealth, signInState, type HealthInput, type ServiceChoice } from "../src/shared/connection-health/evaluate"
import { RUN_MAX_AGE_MS, TOKEN_MAX_AGE_MS, type ConnectionRecord, type ReaderObservation, type RunObservation, type SignInFailure, type Snapshot, type TokenObservation } from "../src/shared/connection-health/model"
import { keepEvidence } from "../src/shared/connection-health/observe"
import { DEFAULT_SETUP_CHOICE, graphPermissions, missingForChoice } from "../src/shared/services/manifest"
import { MODULES, type ModuleId } from "../src/shared/services/modules"
import { SIGN_IN_ERRORS } from "../src/shared/sign-in-errors"

// The evaluator is a pure function of observations, the snapshot and the time, so every case here
// names its time. NOW is the clock; everything else is dated relative to it.
const NOW = new Date("2026-11-14T12:00:00.000Z")
const MINUTE = 60_000
const DAY = 86_400_000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "33333333-3333-3333-3333-333333333333"
const OLD_CLIENT = "55555555-5555-5555-5555-555555555555"
const READER = "44444444-4444-4444-4444-444444444444"
const ADMIN = "aaaaaaaa-0000-0000-0000-000000000001.11111111-1111-1111-1111-111111111111"
const OTHER_ADMIN = "bbbbbbbb-0000-0000-0000-000000000002.11111111-1111-1111-1111-111111111111"

/** What a setup without choices asks for: Intune with restore, and reading Conditional Access. */
const DEFAULT_SCOPES = [...graphPermissions(DEFAULT_SETUP_CHOICE, "delegated")]

const choice = (enabled: boolean, access: "backup" | "restore" = "backup", areas: Record<string, boolean> = {}): ServiceChoice => ({ enabled, access, areas })
const settings = (changes: Partial<Record<ModuleId, ServiceChoice>> = {}): Record<ModuleId, ServiceChoice> => ({
  intune: choice(true, "restore"),
  conditionalAccess: choice(false),
  entra: choice(false),
  ...changes,
})

const healthy = (permissions: string[] = DEFAULT_SCOPES, at = ago(MINUTE)): TokenObservation => ({ at, permissions })
const failed = (failure: SignInFailure, at = ago(MINUTE)): TokenObservation => ({ at, failure })

/**
 * A record as the store keeps it: what it holds per folder follows from its runs the way the store
 * works it out, in the order the runs ended, and for an admin's record from that admin's runs only.
 * `verified` and `refused` given by a test are what the record held before those runs.
 */
function stored(record: ConnectionRecord): ConnectionRecord {
  const evidence = { verified: { ...record.verified }, refused: { ...record.refused } }
  for (const run of [...record.runs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (record.mode === "app-only" || run.account === record.account) keepEvidence(evidence, run)
  }
  return { ...record, ...evidence }
}
const delegated = (parts: Partial<ConnectionRecord> = {}): ConnectionRecord => stored({ clientId: CLIENT, mode: "delegated", account: ADMIN, runs: [], verified: {}, refused: {}, updatedAt: ago(MINUTE), ...parts })
const readerConnection = (parts: Partial<ConnectionRecord> = {}): ConnectionRecord => stored({ clientId: READER, mode: "app-only", runs: [], verified: {}, refused: {}, updatedAt: ago(MINUTE), ...parts })

/** A run that ended `daysAgo` days ago; an admin's run unless `account` is cleared. */
const run = (runId: string, daysAgo: number, parts: Partial<RunObservation> = {}): RunObservation => ({ runId, at: ago(daysAgo * DAY), trigger: "manual", status: "Success", account: ADMIN, read: [], refused: [], unread: [], excluded: [], ...parts })
const readerRun = (runId: string, daysAgo: number, parts: Partial<RunObservation> = {}): RunObservation => {
  const { account: _account, ...rest } = run(runId, daysAgo, { trigger: "scheduled", ...parts })
  return rest
}
const refusal = (folder: string, cause: "permission" | "role" | "license" = "permission", permissionHeld?: boolean) => ({ folder, cause, status: 403, ...(permissionHeld !== undefined ? { permissionHeld } : {}) })

const readerFacts = (parts: Partial<ReaderObservation> = {}): ReaderObservation => ({ at: NOW.toISOString(), state: "verified", notAfter: ago(-200 * DAY), verifiedAt: ago(30 * DAY), verifiedRoles: ["DeviceManagementConfiguration.Read.All"], roleChange: null, ...parts })

const evaluate = (connections: ConnectionRecord[], input: Partial<HealthInput> = {}, now = NOW) =>
  evaluateHealth({ tenantId: TENANT, clientId: CLIENT, reader: null, storage: "local", settings: settings(), connections, ...input }, now)

it("uses only the scheduled Backup Reader's effective coverage alongside delegated evidence", () => {
  const roles = ["SecurityEvents.Read.All", "DeviceManagementConfiguration.Read.All"]
  const connections = [delegated({ graph: healthy(["DeviceManagementConfiguration.Read.All"]) })]
  const input = {
    readerClientId: READER,
    readerScheduled: true,
    reader: readerFacts({ verifiedAt: ago(MINUTE), verifiedRoles: roles }),
    settings: settings({ entra: choice(true), conditionalAccess: choice(true) }),
  }
  const { report } = evaluate(connections, input)
  expect(report.readerReadableServices).toEqual(expect.arrayContaining(["entra", "intune"]))
  expect(report.readerReadableServices).not.toContain("entra")
  expect(report.coverage?.find(row => row.service === "entra")?.readable).toEqual([])
  expect(report.coverage?.find(row => row.service === "intune")?.readable).toContain("DeviceConfigurations")

  const changed = evaluate(connections, { ...input, reader: {
    ...input.reader, roleChange: { added: [], removed: ["SecurityEvents.Read.All"], at: ago(0) },
  } })
  expect(changed.report.readerReadableServices).toEqual(["intune"])
  expect(evaluate(connections, { ...input, readerScheduled: false }).report.readerReadableServices).toBeUndefined()
  expect(evaluate(connections, { ...input, reader: { ...input.reader, notAfter: ago(MINUTE) } }).report.readerReadableServices).toBeUndefined()
})


const service = (report: ReturnType<typeof evaluate>["report"], id: ModuleId) => report.services.find((entry) => entry.id === id)!
const area = (report: ReturnType<typeof evaluate>["report"], id: ModuleId, areaId: string) => service(report, id).areas.find((entry) => entry.id === areaId)!

describe("the state of the admin's sign-in", () => {
  it("is not checked before any token request was answered", () => {
    expect(evaluate([]).report.graph).toEqual({ state: "notChecked", checkedAt: null })
    expect(evaluate([delegated()]).report.graph).toEqual({ state: "notChecked", checkedAt: null })
  })

  it("is healthy when Microsoft issued a token for the check, as of the time of the check", () => {
    expect(evaluate([delegated({ graph: healthy(DEFAULT_SCOPES, ago(3 * MINUTE)) })]).report.graph).toEqual({ state: "healthy", checkedAt: ago(3 * MINUTE) })
  })

  // Every code of the error table that can answer an admin's sign-in, each to the state of its row.
  it.each(SIGN_IN_ERRORS.map((row) => [row.code, row.class, row.class === "credential" ? "unknown" : row.state] as const))("%s (%s) leads to %s", (code, errorClass, state) => {
    const { graph } = evaluate([delegated({ graph: failed({ class: errorClass, code }) })]).report
    expect(graph).toEqual({ state, checkedAt: ago(MINUTE), class: errorClass, code, link: `https://login.microsoftonline.com/error?code=${code.slice(6)}` })
  })

  it("covers every state an admin's sign-in can be in", () => {
    const fromCodes = new Set(SIGN_IN_ERRORS.filter((row) => row.class !== "credential").map((row) => row.state))
    expect([...fromCodes].sort()).toEqual([
      "accountDisabled", "accountLockedOrBlocked", "applicationDisabled", "blockedByConditionalAccess", "consentMissing", "mfaRequired", "notAssigned", "registrationMisconfigured",
      "registrationNotFoundInTenant", "servicePrincipalMissing", "signInNeeded", "throttled", "unreachable", "wrongTenantOrAccount",
    ])
  })

  it("keeps both readings of a locked account or a blocked sign-in, and shows the code", () => {
    expect(evaluate([delegated({ graph: failed({ class: "account", code: "AADSTS50053" }) })]).report.graph).toEqual({
      state: "accountLockedOrBlocked", checkedAt: ago(MINUTE), class: "account", code: "AADSTS50053", link: "https://login.microsoftonline.com/error?code=50053",
    })
    // A disabled account is its own code and its own state.
    expect(evaluate([delegated({ graph: failed({ class: "account", code: "AADSTS50057" }) })]).report.graph.state).toBe("accountDisabled")
  })

  // A failure without a code Microsoft gave: the class alone decides.
  it.each([
    ["session", "signInNeeded"],
    ["mfa", "mfaRequired"],
    ["conditionalAccess", "blockedByConditionalAccess"],
    ["consent", "consentMissing"],
    ["assignment", "notAssigned"],
    ["account", "accountDisabled"],
    ["tenant", "wrongTenantOrAccount"],
    ["throttled", "throttled"],
    ["unavailable", "unreachable"],
    ["unreachable", "unreachable"],
    ["registration", "unknown"],
    ["application", "unknown"],
    ["credential", "unknown"],
    ["readerCheck", "unknown"],
    ["unknown", "unknown"],
  ] as const)("a %s failure without a code leads to %s", (failureClass, state) => {
    expect(signInState({ class: failureClass })).toBe(state)
    expect(evaluate([delegated({ graph: failed({ class: failureClass }) })]).report.graph).toEqual({ state, checkedAt: ago(MINUTE), class: failureClass })
  })

  it("names a code it has no row for, with Microsoft's description of it, and guesses nothing", () => {
    expect(evaluate([delegated({ graph: failed({ class: "unknown", code: "AADSTS999999" }) })]).report.graph).toEqual({
      state: "unknown", checkedAt: ago(MINUTE), class: "unknown", code: "AADSTS999999", link: "https://login.microsoftonline.com/error?code=999999",
    })
  })

  it("follows the code when the class stored with it says something else", () => {
    expect(evaluate([delegated({ graph: failed({ class: "session", code: "AADSTS53003" }) })]).report.graph.state).toBe("blockedByConditionalAccess")
    expect(evaluate([delegated({ graph: failed({ class: "unreachable", code: "AADSTS700016" }) })]).report.graph.state).toBe("registrationNotFoundInTenant")
  })

  it("lets an answer expire", () => {
    const at = (age: number) => evaluate([delegated({ graph: healthy(DEFAULT_SCOPES, ago(age)) })]).report.graph
    expect(at(TOKEN_MAX_AGE_MS).state).toBe("healthy")
    expect(at(TOKEN_MAX_AGE_MS + 1)).toEqual({ state: "notChecked", checkedAt: null })
    // A refusal expires like a success: after a week it no longer says how the sign-in is.
    expect(evaluate([delegated({ graph: failed({ class: "session", code: "AADSTS50173" }, ago(8 * DAY)) })]).report.graph).toEqual({ state: "notChecked", checkedAt: null })
  })

  it("does not trust an answer dated ahead of the clock", () => {
    expect(evaluate([delegated({ graph: healthy(DEFAULT_SCOPES, ago(-MINUTE)) })]).report.graph.state).toBe("healthy")
    expect(evaluate([delegated({ graph: healthy(DEFAULT_SCOPES, ago(-DAY)) })]).report.graph.state).toBe("notChecked")
    expect(evaluate([delegated({ graph: healthy(DEFAULT_SCOPES, "not a date") })]).report.graph.state).toBe("notChecked")
  })

  it("reads the same observations differently as time passes", () => {
    const connections = [delegated({ graph: healthy(DEFAULT_SCOPES, ago(0)) })]
    expect(evaluate(connections, {}, NOW).report.graph.state).toBe("healthy")
    expect(evaluate(connections, {}, new Date(NOW.getTime() + 6 * DAY)).report.graph.state).toBe("healthy")
    expect(evaluate(connections, {}, new Date(NOW.getTime() + 8 * DAY)).report.graph.state).toBe("notChecked")
  })

  it("only looks at the connection the tenant is connected with", () => {
    const report = evaluate([delegated({ clientId: OLD_CLIENT, graph: healthy() }), readerConnection({ graph: healthy() })]).report
    expect(report.graph).toEqual({ state: "notChecked", checkedAt: null })
    expect(report.granted).toBeNull()
  })
})

describe("the state of the storage sign-in", () => {
  it("is local for backups on this device, whatever was observed", () => {
    expect(evaluate([delegated({ storage: failed({ class: "consent", code: "AADSTS65001" }) })]).report.storage).toEqual({ state: "local", checkedAt: null })
  })

  it.each([
    [undefined, "notChecked"],
    [healthy(["user_impersonation"]), "healthy"],
    [failed({ class: "consent", code: "AADSTS65001" }), "consentMissing"],
    [failed({ class: "consent", code: "AADSTS650057" }), "consentMissing"],
    [failed({ class: "session", code: "AADSTS70043" }), "signInNeeded"],
    [failed({ class: "mfa", code: "AADSTS50076" }), "mfaRequired"],
    [failed({ class: "conditionalAccess", code: "AADSTS53003" }), "blockedByConditionalAccess"],
    [failed({ class: "unreachable" }), "unreachable"],
    [failed({ class: "throttled" }), "throttled"],
    [failed({ class: "unknown", code: "AADSTS500011" }), "unknown"],
  ] as const)("an Azure tenant with %j is %s", (storage, state) => {
    const report = evaluate([delegated({ graph: healthy(), ...(storage ? { storage } : {}) })], { storage: "azure" }).report
    expect(report.storage.state).toBe(state)
    // Graph and storage are told apart: a storage refusal says nothing about Microsoft Graph.
    expect(report.graph.state).toBe("healthy")
  })

  it("expires like the Graph answer", () => {
    expect(evaluate([delegated({ storage: healthy(["user_impersonation"], ago(8 * DAY)) })], { storage: "azure" }).report.storage).toEqual({ state: "notChecked", checkedAt: null })
  })
})

describe("the state of the Backup Reader", () => {
  const reader = (facts: ReaderObservation | null, token?: TokenObservation, now = NOW) =>
    evaluate(token ? [readerConnection({ graph: token })] : [], { reader: facts, ...(facts ? { readerClientId: READER } : {}) }, now).report.reader

  it("is not set up for a tenant without one", () => {
    expect(reader(null)).toEqual({ state: "notSetUp", checkedAt: null })
  })

  it("is pending while its certificate waits for the first verification", () => {
    expect(reader(readerFacts({ state: "pending", verifiedAt: null, verifiedRoles: null })).state).toBe("pending")
  })

  it("is healthy when verified, with a certificate that is far from its end", () => {
    expect(reader(readerFacts(), healthy(["DeviceManagementConfiguration.Read.All"]))).toEqual({ state: "healthy", checkedAt: ago(MINUTE), notAfter: ago(-200 * DAY), daysLeft: 200 })
    // Without an answer to a token request the facts on this device stand, and say when nothing was asked.
    expect(reader(readerFacts())).toEqual({ state: "healthy", checkedAt: null, notAfter: ago(-200 * DAY), daysLeft: 200 })
  })

  it.each([[31, "healthy"], [30, "certificateExpiring"], [1, "certificateExpiring"]] as const)("with %i days left the certificate is %s", (days, state) => {
    expect(reader(readerFacts({ notAfter: ago(-days * DAY) }))).toMatchObject({ state, daysLeft: days })
  })

  it("has an expired certificate from the certificate's own date on", () => {
    expect(reader(readerFacts({ notAfter: ago(0) }))).toMatchObject({ state: "certificateExpired", daysLeft: 0 })
    expect(reader(readerFacts({ notAfter: ago(3 * DAY) }))).toMatchObject({ state: "certificateExpired", daysLeft: -3 })
    // The same facts a day earlier: the clock decides, not when they were read.
    expect(reader(readerFacts({ notAfter: ago(0) }), undefined, new Date(NOW.getTime() - DAY)).state).toBe("certificateExpiring")
  })

  it("says the certificate expired by the certificate's own date alone, never from an answer of Microsoft", () => {
    // Microsoft describes AADSTS7000222 as expired client secret keys. The certificate is good for 200 more days.
    const found = reader(readerFacts(), failed({ class: "credential", code: "AADSTS7000222" }))
    expect(found).toMatchObject({ state: "refused", code: "AADSTS7000222", daysLeft: 200 })
    for (const row of SIGN_IN_ERRORS) expect(reader(readerFacts(), failed({ class: row.class, code: row.code })).state).not.toBe("certificateExpired")
  })

  it("waits for a new verification when its permissions changed", () => {
    const roleChange = { added: ["Policy.Read.All"], removed: [], at: ago(DAY) }
    expect(reader(readerFacts({ roleChange }), healthy([]))).toMatchObject({ state: "rolesChanged", roleChange })
  })

  it.each([
    [{ class: "credential", code: "AADSTS700027" }, "refused"],
    [{ class: "credential", code: "AADSTS700024" }, "refused"],
    [{ class: "credential", code: "AADSTS7000222" }, "refused"],
    [{ class: "registration", code: "AADSTS700016" }, "refused"],
    [{ class: "application", code: "AADSTS7000112" }, "refused"],
    [{ class: "application", code: "AADSTS7000229" }, "refused"],
    [{ class: "conditionalAccess", code: "AADSTS53003" }, "refused"],
    [{ class: "readerCheck" }, "refused"],
    [{ class: "unknown", code: "AADSTS999999" }, "refused"],
    [{ class: "throttled", code: "AADSTS90055" }, "throttled"],
    [{ class: "throttled" }, "throttled"],
    [{ class: "unavailable", code: "AADSTS90033" }, "unreachable"],
    [{ class: "unreachable" }, "unreachable"],
  ] as const)("a token request answered with %j makes it %s", (failure, state) => {
    const found = reader(readerFacts(), failed(failure))
    expect(found).toMatchObject({ state, checkedAt: ago(MINUTE), class: failure.class })
    if ("code" in failure) expect(found).toMatchObject({ code: failure.code, link: `https://login.microsoftonline.com/error?code=${failure.code.slice(6)}` })
  })

  it("settles observations that disagree by what stops scheduled backups first", () => {
    const roleChange = { added: [], removed: ["DeviceManagementApps.Read.All"], at: ago(DAY) }
    const refused = failed({ class: "application", code: "AADSTS7000112" })
    // An expired certificate is never used, whatever Microsoft said last.
    expect(reader(readerFacts({ notAfter: ago(DAY), roleChange }), refused).state).toBe("certificateExpired")
    expect(reader(readerFacts({ notAfter: ago(-10 * DAY), roleChange }), refused).state).toBe("refused")
    expect(reader(readerFacts({ notAfter: ago(-10 * DAY), roleChange }), healthy([])).state).toBe("rolesChanged")
    expect(reader(readerFacts({ notAfter: ago(-10 * DAY) }), healthy([])).state).toBe("certificateExpiring")
    // A pending reader was never verified, so nothing else is said about it.
    expect(reader(readerFacts({ state: "pending", notAfter: ago(DAY) }), refused).state).toBe("pending")
  })

  it("lets a verification that is newer than a refusal replace it", () => {
    // A check was refused the certificate ten minutes ago. The admin uploaded the right one and verified a minute ago.
    const refused = failed({ class: "credential", code: "AADSTS700027" }, ago(10 * MINUTE))
    expect(reader(readerFacts({ verifiedAt: ago(MINUTE) }), refused)).toEqual({ state: "healthy", checkedAt: ago(MINUTE), notAfter: ago(-200 * DAY), daysLeft: 200 })
    // What this device knows about the verified reader still shows.
    expect(reader(readerFacts({ verifiedAt: ago(MINUTE), notAfter: ago(-10 * DAY) }), refused)).toMatchObject({ state: "certificateExpiring", checkedAt: ago(MINUTE) })
    // A refusal that came after the verification stands, and so does one whose verification is dated ahead of the clock.
    expect(reader(readerFacts({ verifiedAt: ago(11 * MINUTE) }), refused)).toMatchObject({ state: "refused", checkedAt: ago(10 * MINUTE), code: "AADSTS700027" })
    expect(reader(readerFacts({ verifiedAt: ago(-DAY) }), refused)).toMatchObject({ state: "refused", checkedAt: ago(10 * MINUTE) })
    // A newer verification also replaces an earlier successful check.
    expect(reader(readerFacts({ verifiedAt: ago(MINUTE) }), healthy([], ago(10 * MINUTE))).checkedAt).toBe(ago(MINUTE))
  })

  it("forgets a refusal that expired, and falls back to what this device knows", () => {
    expect(reader(readerFacts(), failed({ class: "application", code: "AADSTS7000112" }, ago(8 * DAY)))).toEqual({ state: "healthy", checkedAt: null, notAfter: ago(-200 * DAY), daysLeft: 200 })
  })

  it("never takes the admin's token for the reader's, or the other way round", () => {
    const report = evaluate([delegated({ graph: failed({ class: "session", code: "AADSTS50173" }) }), readerConnection({ graph: healthy([]) })], { reader: readerFacts(), readerClientId: READER }).report
    expect(report.graph.state).toBe("signInNeeded")
    expect(report.reader.state).toBe("healthy")
  })
})

// Every service, with its own permissions and its own folders: permissions present from the token,
// verified from the last backup, and the cause when it was not.
describe.each(MODULES.map((module) => [module.label, module] as const))("%s", (_label, module) => {
  const scopes = [...graphPermissions({ [module.id]: { access: "backup" } }, "delegated")]
  const on = settings({ intune: choice(false), [module.id]: choice(true) })
  const first = module.areas.find((entry) => !entry.optIn)!
  const [folder, second] = [first.folders[0]!, first.folders[1]]
  const always = module.areas.filter((entry) => !entry.optIn)

  it("has its permissions present when the token carries what backing it up asks for", () => {
    const found = service(evaluate([delegated({ graph: healthy(scopes) })], { settings: on }).report, module.id)
    expect(found).toMatchObject({ enabled: true, access: "backup", permissions: "present", missing: [] })
    for (const entry of found.areas.filter((entry) => !entry.optIn)) expect(entry).toMatchObject({ enabled: true, permissions: "present", missing: [] })
  })

  it("names exactly the permissions that are missing, from the manifest", () => {
    const base = ["User.Read", "Organization.Read.All"]
    const found = service(evaluate([delegated({ graph: healthy(base) })], { settings: on }).report, module.id)
    const expected = missingForChoice({ [module.id]: { access: "backup" } }, { kind: "delegated", permissions: new Set(base) })
    expect(expected.length).toBeGreaterThan(0)
    expect(found.missing).toEqual(expected)
    expect(found.permissions).toBe("missing")
    // Every permission named for an area is one the service names.
    for (const entry of found.areas.filter((entry) => !entry.optIn)) for (const permission of entry.missing) expect(expected).toContain(permission)
  })

  it("says unknown, never missing, without a recent token", () => {
    for (const graph of [undefined, failed({ class: "session" }), healthy(scopes, ago(8 * DAY))]) {
      const found = service(evaluate([delegated(graph ? { graph } : {})], { settings: on }).report, module.id)
      expect(found).toMatchObject({ permissions: "unknown", missing: [] })
      expect(found.areas.every((entry) => entry.permissions === "unknown" && entry.restore === "unknown")).toBe(true)
    }
  })

  it("is verified by the last backup that read its types, with that backup's date", () => {
    const folders = always.flatMap((entry) => entry.folders)
    const report = evaluate([delegated({ graph: healthy(scopes), runs: [run("r1", 2, { read: folders })] })], { settings: on }).report
    expect(service(report, module.id).verified).toEqual({ state: "verified", at: ago(2 * DAY), mode: "delegated", notVerified: [] })
    expect(area(report, module.id, first.id).verified).toEqual({ state: "verified", at: ago(2 * DAY), mode: "delegated", notVerified: [] })
  })

  it("has no backup to go by before one selected its types", () => {
    const report = evaluate([delegated({ graph: healthy(scopes) })], { settings: on }).report
    expect(service(report, module.id).verified).toEqual({ state: "noBackup", notVerified: [] })
  })

  const refusedReads: Array<[cause: string, outcome: Partial<RunObservation>, granted: string[]]> = [
    ["permission", { refused: [refusal(folder, "permission")] }, []],
    // The run lacked a permission that the token carries now: that cause is gone, and nothing says the role is what is left.
    ["notVerifiedYet", { refused: [refusal(folder, "permission", false)] }, scopes],
    ["refusedWithPermission", { refused: [refusal(folder, "permission", true)] }, scopes],
    ["refusedWithPermission", { refused: [refusal(folder, "permission")] }, scopes],
    // The cause a run found with its own token stays, whatever the token of today carries.
    ["role", { refused: [refusal(folder, "role")] }, []],
    ["role", { refused: [refusal(folder, "role")] }, scopes],
    ["license", { refused: [refusal(folder, "license")] }, scopes],
    ["notRead", { unread: [folder] }, scopes],
  ]
  it.each(refusedReads)("is not verified, because of %s, when the last backup ended with %j", (cause, outcome, granted) => {
    const report = evaluate([delegated({ graph: healthy(granted), runs: [run("r1", 1, outcome)] })], { settings: on }).report
    expect(area(report, module.id, first.id).verified).toEqual({ state: "notVerified", at: ago(DAY), cause, mode: "delegated", notVerified: [folder] })
    expect(area(report, module.id, first.id).lostAccess).toBe(false)
  })

  it("says a signed-in admin is required when only the Backup Reader ran and left the type out for that", () => {
    const report = evaluate([readerConnection({ runs: [readerRun("r1", 1, { excluded: [{ folder, cause: "signedIn" }] })] })], { settings: on, reader: readerFacts(), readerClientId: READER }).report
    expect(area(report, module.id, first.id).verified).toEqual({ state: "notVerified", at: ago(DAY), cause: "signedIn", mode: "app-only", notVerified: [folder] })
  })

  it("says the Backup Reader leaves the type out by design when only it ran, which is no refusal", () => {
    const report = evaluate([readerConnection({ runs: [readerRun("r1", 3, { excluded: [{ folder, cause: "reader" }] }), readerRun("r2", 1, { excluded: [{ folder, cause: "reader" }] })] })], { settings: on, reader: readerFacts(), readerClientId: READER }).report
    expect(area(report, module.id, first.id).verified).toEqual({ state: "notVerified", at: ago(DAY), cause: "reader", mode: "app-only", notVerified: [folder] })
    expect(area(report, module.id, first.id).lostAccess).toBe(false)
    expect(report.changes).toEqual([])
  })

  it("keeps an admin's read when a later Backup Reader run left the type out by design", () => {
    const report = evaluate(
      [delegated({ runs: [run("manual", 9, { read: [folder] })] }), readerConnection({ runs: [readerRun("nightly", 1, { excluded: [{ folder, cause: "reader" }] })] })],
      { settings: on, reader: readerFacts(), readerClientId: READER },
    ).report
    expect(area(report, module.id, first.id).verified).toEqual({ state: "verified", at: ago(9 * DAY), mode: "delegated", notVerified: [] })
  })

  it.runIf(second)("is partly verified when the last backup read one type and not another", () => {
    const report = evaluate([delegated({ runs: [run("r1", 1, { read: [folder], refused: [refusal(second!, "license")] })] })], { settings: on }).report
    expect(area(report, module.id, first.id).verified).toEqual({ state: "partly", at: ago(DAY), cause: "license", mode: "delegated", notVerified: [second] })
  })

  it("loses access when a type it read before is refused by two backups", () => {
    const runs = [run("r1", 5, { read: [folder] }), run("r2", 3, { refused: [refusal(folder)] }), run("r3", 1, { refused: [refusal(folder)] })]
    const baseline = evaluate([delegated({ runs: runs.slice(0, 1) })], { settings: on }).baseline!
    const { report } = evaluate([delegated({ runs, snapshot: baseline })], { settings: on })
    expect(area(report, module.id, first.id)).toMatchObject({ lostAccess: true, verified: { state: "notVerified", cause: "permission" } })
    expect(report.changes).toEqual([{ kind: "lostAccess", service: module.id, area: first.id, cause: "permission", mode: "delegated", folders: [folder], since: ago(3 * DAY) }])
  })

  it("is outside what backups cover when it is turned off: nothing verified, nothing lost", () => {
    const runs = [run("r1", 5, { read: [folder] }), run("r2", 3, { refused: [refusal(folder)] }), run("r3", 1, { refused: [refusal(folder)] })]
    const off = settings({ intune: choice(false), [module.id]: choice(false) })
    const { report } = evaluate([delegated({ graph: healthy(scopes), runs, snapshot: { at: ago(9 * DAY), account: ADMIN, lost: [] } })], { settings: off })
    expect(service(report, module.id)).toMatchObject({ enabled: false, verified: { state: "noBackup" } })
    expect(service(report, module.id).areas.every((entry) => !entry.enabled && !entry.lostAccess)).toBe(true)
    expect(report.changes).toEqual([])
    // What its token may do is still known, so the card can say what turning it on would need.
    expect(service(report, module.id).permissions).toBe("present")
  })
})

describe("opt-in areas", () => {
  it("count only when the tenant turned them on", () => {
    const scopes = [...graphPermissions({ entra: { access: "backup" } }, "delegated")]
    const off = evaluate([delegated({ graph: healthy(scopes), runs: [run("r1", 1, { read: ["Groups"] })] })], { settings: settings({ entra: choice(true) }) }).report
    expect(area(off, "entra", "groups")).toMatchObject({ optIn: true, personalData: true, enabled: false, permissions: "missing", verified: { state: "noBackup" } })
    // An area that is off does not make its service miss permissions.
    expect(service(off, "entra")).toMatchObject({ permissions: "present", missing: [] })

    const on = evaluate([delegated({ graph: healthy(scopes), runs: [run("r1", 1, { read: ["Groups"] })] })], { settings: settings({ entra: choice(true, "backup", { groups: true }) }) }).report
    expect(area(on, "entra", "groups")).toMatchObject({ enabled: true, permissions: "missing", verified: { state: "verified" } })
    expect(service(on, "entra").permissions).toBe("missing")
    expect(service(on, "entra").missing).toEqual(missingForChoice({ entra: { access: "backup", areas: ["groups"] } }, { kind: "delegated", permissions: new Set(scopes) }))
  })
})

describe("services and what this version backs up", () => {
  it("lists every service, and says which have types to back up", () => {
    const { services } = evaluate([]).report
    expect(services.map((entry) => entry.id)).toEqual(MODULES.map((module) => module.id))
    expect(services.find((entry) => entry.id === "intune")!.hasTypes).toBe(true)
  })

  it("follows the access level the tenant chose when it names what to add", () => {
    const backup = [...graphPermissions({ conditionalAccess: { access: "backup" } }, "delegated")]
    const report = evaluate([delegated({ graph: healthy(backup) })], { settings: settings({ conditionalAccess: choice(true, "restore") }) }).report
    expect(service(report, "conditionalAccess")).toMatchObject({ access: "restore", permissions: "present", missing: ["Policy.ReadWrite.ConditionalAccess"] })
    expect(area(report, "conditionalAccess", "policies")).toMatchObject({ permissions: "present", restore: "missing", missing: ["Policy.ReadWrite.ConditionalAccess"] })
  })
})

describe("lost access", () => {
  const FOLDER = "DeviceConfigurations"
  const OTHER = "Apps"
  /** The areas that lost access for these runs, evaluated against a snapshot taken before any of it. */
  const lost = (runs: RunObservation[], parts: Partial<ConnectionRecord> = {}, input: Partial<HealthInput> = {}) => {
    const { report } = evaluate([delegated({ runs, snapshot: { at: ago(80 * DAY), account: ADMIN, lost: [] }, ...parts })], input)
    return report.changes.filter((change) => change.kind === "lostAccess")
  }
  const read = (id: string, daysAgo: number, parts: Partial<RunObservation> = {}) => run(id, daysAgo, { read: [FOLDER], ...parts })
  const refused = (id: string, daysAgo: number, parts: Partial<RunObservation> = {}) => run(id, daysAgo, { refused: [refusal(FOLDER)], ...parts })

  it("needs two refusals", () => {
    expect(lost([read("r1", 5), refused("r2", 1)])).toEqual([])
    expect(lost([read("r1", 5), refused("r2", 3), refused("r3", 1)])).toEqual([
      { kind: "lostAccess", service: "intune", area: "configuration", cause: "permission", mode: "delegated", folders: [FOLDER], since: ago(3 * DAY) },
    ])
  })

  it("needs two distinct runs: the same run recorded twice is one", () => {
    expect(lost([read("r1", 5), refused("r2", 3), refused("r2", 3)])).toEqual([])
    expect(lost([read("r1", 5), refused("r2", 3), refused("r2", 1)])).toEqual([])
  })

  it("needs a type that was read before", () => {
    expect(lost([refused("r2", 3), refused("r3", 1)])).toEqual([])
    // A read of another type is not a read of this one.
    expect(lost([run("r1", 5, { read: [OTHER] }), refused("r2", 3), refused("r3", 1)])).toEqual([])
  })

  it("takes the read from the connection's record when the run that made it is no longer kept", () => {
    expect(lost([refused("r2", 3), refused("r3", 1)], { verified: { [FOLDER]: ago(20 * DAY) } })).toHaveLength(1)
    // A read after the first refusal is not a read before it, and an expired one no longer counts.
    expect(lost([refused("r2", 3), refused("r3", 1)], { verified: { [FOLDER]: ago(2 * DAY) } })).toEqual([])
    expect(lost([refused("r2", 3), refused("r3", 1)], { verified: { [FOLDER]: ago(RUN_MAX_AGE_MS + DAY) } })).toEqual([])
  })

  it("is cleared by a successful read", () => {
    expect(lost([read("r1", 9), refused("r2", 5), read("r3", 3), refused("r4", 1)])).toEqual([])
    expect(lost([read("r1", 9), refused("r2", 5), refused("r3", 3), read("r4", 1)])).toEqual([])
  })

  it("never counts a type the backup scope left out: the run says nothing about it", () => {
    const without = (id: string, daysAgo: number) => run(id, daysAgo, { read: [OTHER] })
    expect(lost([read("r1", 9), refused("r2", 5), without("r3", 3), without("r4", 1)])).toEqual([])
    // Nor does it clear a refusal: two refusals around a run that left the type out still count.
    expect(lost([read("r1", 9), refused("r2", 5), without("r3", 3), refused("r4", 1)])).toHaveLength(1)
  })

  it("never counts a type the Backup Reader leaves out, or that only a signed-in admin can read", () => {
    const left = (id: string, daysAgo: number, cause: "reader" | "signedIn") => run(id, daysAgo, { excluded: [{ folder: FOLDER, cause }] })
    expect(lost([read("r1", 9), left("r2", 5, "reader"), left("r3", 3, "reader")])).toEqual([])
    expect(lost([read("r1", 9), left("r2", 5, "signedIn"), left("r3", 3, "signedIn")])).toEqual([])
    expect(lost([read("r1", 9), refused("r2", 5), left("r3", 3, "reader")])).toEqual([])
  })

  it("never counts a read that failed for another reason, which neither clears a refusal", () => {
    const unread = (id: string, daysAgo: number) => run(id, daysAgo, { unread: [FOLDER] })
    expect(lost([read("r1", 9), unread("r2", 5), unread("r3", 3)])).toEqual([])
    expect(lost([read("r1", 9), refused("r2", 5), unread("r3", 3)])).toEqual([])
    expect(lost([read("r1", 9), refused("r2", 5), unread("r3", 3), refused("r4", 1)])).toHaveLength(1)
  })

  it("never counts the runs of another admin, as refusals or as the read before", () => {
    const other = { account: OTHER_ADMIN }
    expect(lost([read("r1", 9), refused("r2", 5, other), refused("r3", 3, other)])).toEqual([])
    expect(lost([read("r1", 9), refused("r2", 5), refused("r3", 3, other)])).toEqual([])
    expect(lost([read("r1", 9, other), refused("r2", 5), refused("r3", 3)])).toEqual([])
  })

  it("never adds a refusal of the Backup Reader to one of the admin", () => {
    const connections = [
      delegated({ runs: [read("r1", 9), refused("r2", 5)], snapshot: { at: ago(80 * DAY), account: ADMIN, lost: [] } }),
      readerConnection({ runs: [readerRun("r3", 3, { refused: [refusal(FOLDER)] })] }),
    ]
    const { report } = evaluate(connections, { reader: readerFacts(), readerClientId: READER })
    expect(report.changes).toEqual([])
    expect(area(report, "intune", "configuration").lostAccess).toBe(false)
  })

  it("counts for the Backup Reader what its own runs say", () => {
    const connections = [
      delegated({ snapshot: { at: ago(80 * DAY), account: ADMIN, lost: [] } }),
      readerConnection({ runs: [readerRun("r1", 9, { read: [FOLDER] }), readerRun("r2", 5, { refused: [refusal(FOLDER, "license")] }), readerRun("r3", 3, { refused: [refusal(FOLDER, "license")] })] }),
    ]
    const { report } = evaluate(connections, { reader: readerFacts(), readerClientId: READER })
    expect(report.changes).toEqual([{ kind: "lostAccess", service: "intune", area: "configuration", cause: "license", mode: "app-only", folders: [FOLDER], since: ago(5 * DAY) }])
  })

  it("names the cause and the sign-in of the connection that lost access, not what a later backup of the other one ran into", () => {
    // The Backup Reader read the type and was refused twice. After that a backup of the admin failed to read it for another reason.
    const readerRuns = [readerRun("r1", 9, { read: [FOLDER] }), readerRun("r2", 5, { refused: [refusal(FOLDER, "role")] }), readerRun("r3", 3, { refused: [refusal(FOLDER, "role")] })]
    const connections = [delegated({ graph: healthy(), runs: [run("manual", 1, { unread: [FOLDER] })], snapshot: BEFORE }), readerConnection({ runs: readerRuns })]
    const { report } = evaluate(connections, { reader: readerFacts(), readerClientId: READER })
    expect(report.changes).toEqual([{ kind: "lostAccess", service: "intune", area: "configuration", cause: "role", mode: "app-only", folders: [FOLDER], since: ago(5 * DAY) }])
    // What the last backup said about the type is a statement of its own.
    expect(area(report, "intune", "configuration")).toMatchObject({ lostAccess: true, verified: { state: "notVerified", cause: "notRead", mode: "delegated" } })
  })

  it("names the connection that lost access first when both did", () => {
    const connections = [
      delegated({ runs: [read("a1", 20), refused("a2", 8), refused("a3", 6)], snapshot: BEFORE }),
      readerConnection({ runs: [readerRun("r1", 9, { read: [FOLDER] }), readerRun("r2", 5, { refused: [refusal(FOLDER, "license")] }), readerRun("r3", 3, { refused: [refusal(FOLDER, "license")] })] }),
    ]
    const { report } = evaluate(connections, { reader: readerFacts(), readerClientId: READER })
    expect(report.changes).toEqual([{ kind: "lostAccess", service: "intune", area: "configuration", cause: "permission", mode: "delegated", folders: [FOLDER], since: ago(8 * DAY) }])
  })

  it("keeps the Backup Reader loss while an admin read verifies the type, and after an admin timeout", () => {
    const FOLDER = "Apps"
    const connections = [
      delegated({ runs: [run("manual", 1, { read: [FOLDER] })], snapshot: { at: ago(80 * DAY), account: ADMIN, lost: [] } }),
      readerConnection({ runs: [readerRun("r1", 9, { read: [FOLDER] }), readerRun("r2", 5, { refused: [refusal(FOLDER)] }), readerRun("r3", 3, { refused: [refusal(FOLDER)] })] }),
    ]
    const { report } = evaluate(connections, { reader: readerFacts(), readerClientId: READER })
    const loss = { folder: FOLDER, since: ago(5 * DAY), cause: "permission", mode: "app-only" }
    expect(report.changes).toMatchObject([{ kind: "lostAccess", mode: "app-only" }])
    expect(area(report, "intune", "apps")).toMatchObject({ lostAccess: true, losses: [loss], verified: { state: "verified", at: ago(DAY), mode: "delegated" } })
    // A later timeout of the admin changes verification, never the reader's still-standing loss.
    connections[0]!.runs.push(run("timeout", 0.5, { unread: [FOLDER] }))
    const later = evaluate(connections, { reader: readerFacts(), readerClientId: READER }).report
    expect(area(later, "intune", "apps")).toMatchObject({ lostAccess: true, losses: [loss], verified: { state: "notVerified", cause: "notRead", mode: "delegated" } })
    expect(later.changes).toEqual(report.changes)
    // Only a read by the reader ends its own loss.
    connections[1] = readerConnection({ runs: [...connections[1]!.runs, readerRun("reader-back", 0.25, { read: [FOLDER] })] })
    expect(area(evaluate(connections, { reader: readerFacts(), readerClientId: READER }).report, "intune", "apps")).toMatchObject({ lostAccess: false, losses: [] })
  })

  // What a connection keeps for a type it read 30 days ago and that two runs refused since. No run in its list says anything about the type.
  const KEPT = { verified: { [OTHER]: ago(30 * DAY) }, refused: { [OTHER]: [{ runId: "r2", at: ago(25 * DAY), cause: "role" as const }, { runId: "r3", at: ago(24 * DAY), cause: "role" as const }] } }
  const BEFORE: Snapshot = { at: ago(80 * DAY), account: ADMIN, lost: [] }

  it("stands when the backups since then selected other types, however many there were", () => {
    const later = [5, 4, 3, 2, 1].map((day) => read(`later-${day}`, day))
    const { report } = evaluate([delegated({ runs: later, ...KEPT, snapshot: BEFORE })])
    expect(area(report, "intune", "apps")).toMatchObject({ lostAccess: true, verified: { state: "notVerified", at: ago(24 * DAY), notVerified: [OTHER] } })
    expect(report.changes).toMatchObject([{ kind: "lostAccess", service: "intune", area: "apps", folders: [OTHER], since: ago(25 * DAY) }])
    // The type those backups read is verified by them, and nothing is lost there.
    expect(area(report, "intune", "configuration")).toMatchObject({ lostAccess: false, verified: { state: "verified", at: ago(DAY) } })
  })

  it("counts a refusal that comes after backups that selected other types", () => {
    const once = { verified: KEPT.verified, refused: { [OTHER]: KEPT.refused[OTHER]!.slice(0, 1) } }
    const later = [5, 4, 3, 2].map((day) => read(`later-${day}`, day))
    expect(lost(later, once)).toEqual([])
    expect(lost([...later, run("again", 1, { refused: [refusal(OTHER, "role")] })], once)).toMatchObject([{ area: "apps", since: ago(25 * DAY) }])
  })

  it("ends when a backup reads the type again, and when what is kept about it expires", () => {
    expect(lost([], KEPT)).toHaveLength(1)
    const back = evaluate([delegated({ runs: [run("back", 1, { read: [OTHER] })], ...KEPT, snapshot: BEFORE })]).report
    expect(back.changes).toEqual([])
    expect(area(back, "intune", "apps")).toMatchObject({ lostAccess: false, verified: { state: "verified", at: ago(DAY) } })
    // The read is ninety days old on day 60 from now: a day later nothing says the type was ever read.
    const at = (days: number) => evaluate([delegated({ ...KEPT, snapshot: BEFORE })], {}, new Date(NOW.getTime() + days * DAY)).report
    expect(area(at(60), "intune", "apps").lostAccess).toBe(true)
    expect(area(at(61), "intune", "apps").lostAccess).toBe(false)
    expect(at(61).changes).toEqual([])
  })

  it("needs the refusals to come after the read, from two runs, whatever a record holds", () => {
    const refusals = KEPT.refused[OTHER]!
    expect(lost([], { verified: { [OTHER]: ago(24 * DAY) }, refused: KEPT.refused })).toEqual([])
    expect(lost([], { verified: KEPT.verified, refused: { [OTHER]: [refusals[0]!, { ...refusals[1]!, runId: "r2" }] } })).toEqual([])
    expect(lost([], { verified: {}, refused: KEPT.refused })).toEqual([])
  })

  it("lets runs expire: an old refusal no longer counts", () => {
    const old = RUN_MAX_AGE_MS / DAY + 1
    expect(lost([read("r1", old + 5), refused("r2", old), refused("r3", 1)], { verified: { [FOLDER]: ago((old + 5) * DAY) } })).toEqual([])
    const { report } = evaluate([delegated({ runs: [read("r1", old)] })])
    expect(area(report, "intune", "configuration").verified).toEqual({ state: "noBackup", notVerified: [] })
  })

  it("keeps the cause the refused runs found, and never works out a role from the token of today", () => {
    const WITHOUT = DEFAULT_SCOPES.filter((permission) => !permission.startsWith("DeviceManagementConfiguration"))
    const refusedFor = (cause: "permission" | "role" | "license", held?: boolean) => [read("r1", 9), refused("r2", 5, { refused: [refusal(FOLDER, cause, held)] }), refused("r3", 3, { refused: [refusal(FOLDER, cause, held)] })]
    // The runs found the role with the token they had.
    expect(lost(refusedFor("role"), { graph: healthy() })).toMatchObject([{ cause: "role", mode: "delegated" }])
    expect(lost(refusedFor("role"), { graph: healthy(WITHOUT) })).toMatchObject([{ cause: "role" }])
    expect(lost(refusedFor("license"), { graph: healthy() })).toMatchObject([{ cause: "license" }])
    // The runs lacked the permission. While it is missing, or not known, that is the cause.
    expect(lost(refusedFor("permission"), { graph: healthy(WITHOUT) })).toMatchObject([{ cause: "permission" }])
    expect(lost(refusedFor("permission"))).toMatchObject([{ cause: "permission" }])
    // Once the token carries it, the cause is gone and the type waits for a backup to read it.
    expect(lost(refusedFor("permission", false), { graph: healthy() })).toMatchObject([{ cause: "notVerifiedYet", mode: "delegated" }])
    for (const held of [true, undefined]) expect(lost(refusedFor("permission", held), { graph: healthy() })).toMatchObject([{ cause: "refusedWithPermission", mode: "delegated" }])
  })

  it("never takes the admin's token for what the Backup Reader may read", () => {
    const readerRuns = [readerRun("r1", 9, { read: [FOLDER] }), readerRun("r2", 5, { refused: [refusal(FOLDER)] }), readerRun("r3", 3, { refused: [refusal(FOLDER)] })]
    const { report } = evaluate([delegated({ graph: healthy(), snapshot: BEFORE }), readerConnection({ runs: readerRuns })], { reader: readerFacts(), readerClientId: READER })
    expect(report.changes).toMatchObject([{ kind: "lostAccess", cause: "permission", mode: "app-only" }])
    expect(area(report, "intune", "configuration").verified).toMatchObject({ cause: "permission", mode: "app-only" })
  })

  it("is reported once: looking at the changes makes it the state, and losing it again is news", () => {
    const runs = [read("r1", 9), refused("r2", 5), refused("r3", 3)]
    const first = evaluate([delegated({ runs, snapshot: { at: ago(80 * DAY), account: ADMIN, lost: [] } })])
    expect(first.report.changes).toHaveLength(1)
    // The changes were looked at: the state as it is becomes the snapshot.
    const seen = evaluate([delegated({ runs, snapshot: first.current! })])
    expect(seen.report.changes).toEqual([])
    expect(area(seen.report, "intune", "configuration").lostAccess).toBe(true)
    // Access comes back, then goes again.
    const back = evaluate([delegated({ runs: [...runs, read("r4", 2)], snapshot: seen.baseline! })])
    expect(back.report.changes).toEqual([])
    expect(back.baseline!.lost).toEqual([])
    const again = evaluate([delegated({ runs: [read("r4", 2), refused("r5", 1), refused("r6", 0.5)], snapshot: back.baseline! })])
    expect(again.report.changes).toMatchObject([{ kind: "lostAccess", area: "configuration", since: ago(DAY) }])
  })
})

describe("acknowledging one loss episode", () => {
  const input = { reader: readerFacts(), readerClientId: READER }
  const before: Snapshot = { at: ago(80 * DAY), account: ADMIN, lost: [] }
  const loss = (id: string, folder: string, start: number, reader = false, account = ADMIN) => {
    const makeRun = reader ? readerRun : (id: string, day: number, parts: Partial<RunObservation>) => run(id, day, { ...parts, account })
    return [makeRun(`${id}-read`, start, { read: [folder] }), makeRun(`${id}-first`, start - 1, { refused: [refusal(folder, "role")] }), makeRun(`${id}-second`, start - 2, { refused: [refusal(folder, "role")] })]
  }

  it.each(["delegated", "app-only"] as const)("reports the other connection's Apps loss after acknowledging %s", (mode) => {
    const adminRuns = mode === "delegated" ? loss("admin", "Apps", 9) : []
    const readerRuns = mode === "app-only" ? loss("reader", "Apps", 9, true) : []
    const first = evaluate([delegated({ runs: adminRuns, snapshot: before }), readerConnection({ runs: readerRuns })], input)
    expect(first.report.changes).toMatchObject([{ kind: "lostAccess", mode }])
    expect(evaluate([delegated({ runs: adminRuns, snapshot: first.current! }), readerConnection({ runs: readerRuns })], input).report.changes).toEqual([])
    const nextMode = mode === "delegated" ? "app-only" : "delegated"
    const next = evaluate([
      delegated({ runs: mode === "delegated" ? adminRuns : loss("later-admin", "Apps", 6), snapshot: first.current! }),
      readerConnection({ runs: mode === "app-only" ? readerRuns : loss("later-reader", "Apps", 6, true) }),
    ], input)
    expect(next.report.changes).toEqual([{ kind: "lostAccess", service: "intune", area: "apps", mode: nextMode, cause: "role", folders: ["Apps"], since: ago(5 * DAY) }])
    expect(area(next.report, "intune", "apps").losses).toHaveLength(2)
    expect(JSON.stringify(next.report)).not.toContain(ADMIN)
    expect(next.current!.acknowledgedLosses).toHaveLength(2)
  })

  it("reports another folder in the same area while the acknowledged loss still stands", () => {
    const firstRuns = loss("apps", "Apps", 9)
    const first = evaluate([delegated({ runs: firstRuns, snapshot: before })])
    const next = evaluate([delegated({ runs: [...firstRuns, ...loss("categories", "AppCategories", 6)], snapshot: first.current! })])
    expect(next.report.changes).toEqual([{ kind: "lostAccess", service: "intune", area: "apps", mode: "delegated", cause: "role", folders: ["AppCategories"], since: ago(5 * DAY) }])
  })

  it.each(["delegated", "app-only"] as const)("reports a new %s episode even without an evaluation between recovery and loss", (mode) => {
    const reader = mode === "app-only"
    const firstRuns = loss("first", "Apps", 9, reader)
    const records = (runs: RunObservation[], snapshot: Snapshot) => [delegated({ runs: reader ? [] : runs, snapshot }), readerConnection({ runs: reader ? runs : [] })]
    const first = evaluate(records(firstRuns, before), input)
    // The reader recovered and lost access again without anyone opening health between those runs.
    const next = evaluate(records([...firstRuns, ...loss("again", "Apps", 6, reader)], first.current!), input)
    expect(next.report.changes).toMatchObject([{ kind: "lostAccess", mode, folders: ["Apps"], since: ago(5 * DAY) }])
    expect(next.baseline!.acknowledgedLosses).toEqual([])
    expect(next.current!.acknowledgedLosses).toMatchObject([{ runId: "again-first" }])
  })

  it("never applies an earlier admin's acknowledgement to the current account", () => {
    const first = evaluate([delegated({ runs: loss("a", "Apps", 9), snapshot: before })])
    // A changed account gets its own baseline. It has not lost access yet.
    const nextAccount = evaluate([delegated({ account: OTHER_ADMIN, runs: [], snapshot: first.current! })])
    const next = evaluate([delegated({ account: OTHER_ADMIN, runs: loss("b", "Apps", 6, false, OTHER_ADMIN), snapshot: nextAccount.baseline! })])
    expect(next.report.changes).toMatchObject([{ kind: "lostAccess", folders: ["Apps"], since: ago(5 * DAY) }])
    expect(next.current!.acknowledgedLosses![0]!.account).toBe(OTHER_ADMIN)
    expect(JSON.stringify(next.report)).not.toContain(OTHER_ADMIN)
  })
})

describe("changes since the snapshot", () => {
  const WITHOUT_APPS = DEFAULT_SCOPES.filter((permission) => !permission.startsWith("DeviceManagementApps"))

  it("reports nothing for the first snapshot, whatever it finds", () => {
    const runs = [run("r1", 9, { read: ["Apps"] }), run("r2", 5, { refused: [refusal("Apps")] }), run("r3", 3, { refused: [refusal("Apps")] })]
    const { report, baseline } = evaluate([delegated({ graph: healthy(WITHOUT_APPS, ago(2 * MINUTE)), runs })])
    expect(report.changes).toEqual([])
    expect(report.since).toBe(ago(2 * MINUTE))
    expect(baseline).toMatchObject({ at: ago(2 * MINUTE), account: ADMIN, permissions: [...WITHOUT_APPS].sort(), lost: ["intune/apps"] })
    expect(baseline!.ready).toMatchObject({ "intune/apps": false, "intune/configuration": true })
  })

  it("has no snapshot and no changes before anything was observed for the connection", () => {
    const evaluation = evaluate([])
    expect(evaluation.report).toMatchObject({ changes: [], since: null, granted: null })
    expect(evaluation.baseline).toBeUndefined()
    expect(evaluation.current).toBeUndefined()
  })

  it("names permissions that were added and removed, for the same connection and admin", () => {
    const snapshot = evaluate([delegated({ graph: healthy(WITHOUT_APPS, ago(3 * DAY)) })], {}, new Date(NOW.getTime() - 3 * DAY)).baseline!
    const scopes = [...DEFAULT_SCOPES.filter((permission) => permission !== "DeviceManagementRBAC.ReadWrite.All"), "Mail.Send"]
    const { report, baseline } = evaluate([delegated({ graph: healthy(scopes), snapshot })])
    expect(report.changes).toEqual([
      { kind: "permissionsAdded", permissions: ["DeviceManagementApps.ReadWrite.All", "Mail.Send"] },
      { kind: "permissionsRemoved", permissions: ["DeviceManagementRBAC.ReadWrite.All"] },
      { kind: "becameReady", service: "intune", area: "apps" },
    ])
    // The snapshot stays what it was, with its date, until the changes were looked at.
    expect(report.since).toBe(snapshot.at)
    expect(baseline).toMatchObject({ at: snapshot.at, permissions: snapshot.permissions })
    expect(report.granted).toEqual([...scopes].sort())
  })

  it("moves the date of the snapshot to the last check that found nothing changed", () => {
    const snapshot = evaluate([delegated({ graph: healthy(DEFAULT_SCOPES, ago(3 * DAY)) })], {}, new Date(NOW.getTime() - 3 * DAY)).baseline!
    expect(snapshot.at).toBe(ago(3 * DAY))
    const { report, baseline } = evaluate([delegated({ graph: healthy(DEFAULT_SCOPES, ago(MINUTE)), snapshot })])
    expect(report.changes).toEqual([])
    expect(baseline!.at).toBe(ago(MINUTE))
    // A check that could not compare anything leaves the date alone.
    expect(evaluate([delegated({ graph: failed({ class: "unreachable" }), snapshot })]).baseline!.at).toBe(ago(3 * DAY))
  })

  it("reports no change when the sign-in fails: a token that was not issued shows no permissions", () => {
    const snapshot: Snapshot = { at: ago(3 * DAY), account: ADMIN, permissions: [...DEFAULT_SCOPES].sort(), lost: [] }
    for (const graph of [failed({ class: "consent", code: "AADSTS65001" }), failed({ class: "session" }), healthy(DEFAULT_SCOPES, ago(8 * DAY))]) {
      const { report } = evaluate([delegated({ graph, snapshot })])
      expect(report.changes).toEqual([])
      expect(report.granted).toBeNull()
    }
  })

  it("keeps unacknowledged permission changes in the report without a usable token", () => {
    const snapshot = evaluate([delegated({ graph: healthy(WITHOUT_APPS, ago(3 * DAY)) })]).baseline!
    const found = evaluate([delegated({ graph: healthy([...WITHOUT_APPS, "DeviceManagementApps.Read.All"]), snapshot })])
    expect(found.report.changes).toContainEqual({ kind: "permissionsAdded", permissions: ["DeviceManagementApps.Read.All"] })
    for (const graph of [failed({ class: "session" }), healthy(DEFAULT_SCOPES, ago(8 * DAY)), { at: ago(MINUTE) }]) {
      const ended = evaluate([delegated({ graph, snapshot: found.baseline! })])
      expect(ended.report.changes).toEqual(found.report.changes)
      expect(ended.baseline!.found).toEqual(found.baseline!.found)
      expect(evaluate([delegated({ graph, snapshot: ended.current! })]).report.changes).toEqual([])
    }
  })

  it("fills in what the snapshot did not know, without calling it a change", () => {
    const snapshot: Snapshot = { at: ago(3 * DAY), account: ADMIN, lost: [] }
    const { report, baseline } = evaluate([delegated({ graph: healthy(), snapshot })])
    expect(report.changes).toEqual([])
    expect(baseline!.permissions).toEqual([...DEFAULT_SCOPES].sort())
    expect(baseline!.ready).toMatchObject({ "intune/apps": true })
  })

  it("reports no permission change when another admin signs in, and starts comparing from them", () => {
    const snapshot: Snapshot = { at: ago(3 * DAY), account: ADMIN, permissions: [...DEFAULT_SCOPES].sort(), ready: { "intune/apps": true }, lost: [] }
    const other = evaluate([delegated({ account: OTHER_ADMIN, graph: healthy(WITHOUT_APPS), snapshot })])
    expect(other.report.changes).toEqual([])
    expect(other.baseline).toMatchObject({ account: OTHER_ADMIN, permissions: [...WITHOUT_APPS].sort(), at: ago(MINUTE) })
    // From here on a change for that admin is one.
    const later = evaluate([delegated({ account: OTHER_ADMIN, graph: healthy(DEFAULT_SCOPES), snapshot: other.baseline! })])
    expect(later.report.changes).toContainEqual({ kind: "permissionsAdded", permissions: ["DeviceManagementApps.ReadWrite.All"] })
  })

  it("keeps a permission change nobody looked at listed when another admin signs in, and takes no new one from their token", () => {
    const snapshot = evaluate([delegated({ graph: healthy(WITHOUT_APPS, ago(3 * DAY)) })], {}, new Date(NOW.getTime() - 3 * DAY)).baseline!
    const found = evaluate([delegated({ graph: healthy(DEFAULT_SCOPES), snapshot })])
    const unseen = [{ kind: "permissionsAdded", permissions: ["DeviceManagementApps.ReadWrite.All"] }, { kind: "becameReady", service: "intune" }]
    expect(found.report.changes).toEqual(unseen)
    const carried = unseen.map((change) => ({ ...change, earlierSignIn: true, foundAt: ago(MINUTE) }))
    // Another admin signs in before anyone looked. Their token differs in another permission, which is no change.
    const OTHER_SCOPES = DEFAULT_SCOPES.filter((permission) => !permission.startsWith("DeviceManagementRBAC"))
    const other = evaluate([delegated({ account: OTHER_ADMIN, graph: healthy(OTHER_SCOPES), snapshot: found.baseline! })])
    expect(other.report.changes).toEqual(carried)
    expect(other.report.since).toBe(snapshot.at)
    expect(other.baseline).toMatchObject({ account: OTHER_ADMIN, permissions: [...OTHER_SCOPES].sort() })
    // It stays listed at every later evaluation, next to what changes for the new admin from here on.
    expect(evaluate([delegated({ account: OTHER_ADMIN, graph: healthy(OTHER_SCOPES), snapshot: other.baseline! })]).report.changes).toEqual(carried)
    const more = evaluate([delegated({ account: OTHER_ADMIN, graph: healthy(DEFAULT_SCOPES), snapshot: other.baseline! })])
    expect(more.report.changes).toEqual([...carried, { kind: "permissionsAdded", permissions: ["DeviceManagementRBAC.ReadWrite.All"] }, { kind: "becameReady", service: "intune" }])
    // And through a second change of admin, until someone looks at the changes.
    const back = evaluate([delegated({ graph: healthy(DEFAULT_SCOPES), snapshot: more.baseline! })])
    expect(back.report.changes).toEqual(more.report.changes.map((change) => ({ ...change, earlierSignIn: true, foundAt: ago(MINUTE) })))
    expect(evaluate([delegated({ graph: healthy(DEFAULT_SCOPES), snapshot: back.current! })]).report.changes).toEqual([])
    expect(evaluate([delegated({ account: OTHER_ADMIN, graph: healthy(OTHER_SCOPES), snapshot: other.current! })]).report.changes).toEqual([])
  })

  it("keeps a change found before the sign-in failed, for the admin who signs in next", () => {
    const snapshot = evaluate([delegated({ graph: healthy(WITHOUT_APPS, ago(3 * DAY)) })], {}, new Date(NOW.getTime() - 3 * DAY)).baseline!
    const found = evaluate([delegated({ graph: healthy(DEFAULT_SCOPES, ago(2 * DAY)), snapshot })], {}, new Date(NOW.getTime() - 2 * DAY))
    // The first admin's sign-in ends: nothing can be compared, and what was found stays in the snapshot.
    const ended = evaluate([delegated({ graph: failed({ class: "session" }), snapshot: found.baseline! })])
    const other = evaluate([delegated({ account: OTHER_ADMIN, graph: healthy(DEFAULT_SCOPES), snapshot: ended.baseline! })])
    expect(other.report.changes).toEqual(found.report.changes.map((change) => ({ ...change, earlierSignIn: true, foundAt: ago(2 * DAY) })))
  })

  it("never carries lost access to another admin: what was verified, or lost, was for the earlier account", () => {
    const runs = [run("r1", 9, { read: ["Apps"] }), run("r2", 5, { refused: [refusal("Apps", "role")] }), run("r3", 3, { refused: [refusal("Apps", "role")] })]
    const found = evaluate([delegated({ graph: healthy(), runs, snapshot: { at: ago(20 * DAY), account: ADMIN, permissions: [...DEFAULT_SCOPES].sort(), lost: [] } })])
    expect(found.report.changes).toMatchObject([{ kind: "lostAccess", area: "apps" }])
    const other = evaluate([delegated({ account: OTHER_ADMIN, graph: healthy(), snapshot: found.baseline! })])
    expect(other.report.changes).toEqual([])
    expect(area(other.report, "intune", "apps")).toMatchObject({ lostAccess: false, verified: { state: "noBackup" } })
  })

  it("invalidates what was verified for the admin who signed in before", () => {
    const runs = [run("r1", 2, { read: ["DeviceConfigurations"] })]
    expect(area(evaluate([delegated({ runs })]).report, "intune", "configuration").verified.state).toBe("verified")
    expect(area(evaluate([delegated({ account: OTHER_ADMIN, runs })]).report, "intune", "configuration").verified).toEqual({ state: "noBackup", notVerified: [] })
  })

  it("starts over, without a permission change, for a snapshot whose admin is no longer known", () => {
    const snapshot: Snapshot = { at: ago(3 * DAY), permissions: [...DEFAULT_SCOPES].sort(), lost: [] }
    const { report, baseline } = evaluate([delegated({ graph: healthy(WITHOUT_APPS), snapshot })])
    expect(report.changes).toEqual([])
    expect(baseline).toMatchObject({ account: ADMIN, permissions: [...WITHOUT_APPS].sort() })
  })

  it("names a replaced registration, with what it lacks, until the changes were looked at", () => {
    const old = delegated({ clientId: OLD_CLIENT, graph: healthy(DEFAULT_SCOPES, ago(10 * DAY)), updatedAt: ago(10 * DAY), snapshot: { at: ago(20 * DAY), account: ADMIN, permissions: [...DEFAULT_SCOPES].sort(), lost: [] } })
    const first = evaluate([old, delegated({ graph: healthy(WITHOUT_APPS) })])
    expect(first.report.changes).toEqual([{ kind: "registrationReplaced", previousClientId: OLD_CLIENT, lacks: ["DeviceManagementApps.ReadWrite.All"] }])
    expect(first.baseline!.replaces).toEqual({ clientId: OLD_CLIENT, permissions: [...DEFAULT_SCOPES].sort() })
    // The earlier record is no longer needed: the snapshot carries what the old registration had.
    const next = evaluate([delegated({ graph: healthy(DEFAULT_SCOPES), snapshot: first.baseline! })])
    expect(next.report.changes).toEqual([
      { kind: "registrationReplaced", previousClientId: OLD_CLIENT, lacks: [] },
      { kind: "permissionsAdded", permissions: ["DeviceManagementApps.ReadWrite.All"] },
      { kind: "becameReady", service: "intune" },
    ])
    expect(next.current!.replaces).toBeUndefined()
    expect(evaluate([delegated({ graph: healthy(DEFAULT_SCOPES), snapshot: next.current! })]).report.changes).toEqual([])
  })

  it("names a replaced registration even when its permissions could not be read yet", () => {
    const old = delegated({ clientId: OLD_CLIENT, updatedAt: ago(10 * DAY), snapshot: { at: ago(20 * DAY), account: ADMIN, permissions: [...DEFAULT_SCOPES].sort(), lost: [] } })
    const { report } = evaluate([old, delegated({ graph: failed({ class: "consent", code: "AADSTS65001" }) })])
    expect(report.changes).toEqual([{ kind: "registrationReplaced", previousClientId: OLD_CLIENT, lacks: [] }])
    expect(report.graph.state).toBe("consentMissing")
  })

  it("does not take the Backup Reader's registration for an earlier one of the admin", () => {
    expect(evaluate([readerConnection({ graph: healthy([]) }), delegated({ graph: healthy() })]).report.changes).toEqual([])
  })

  it("says a service became ready when every area that is on has its permissions, otherwise the area", () => {
    const entra = [...graphPermissions({ entra: { access: "backup" } }, "delegated")]
    const on = settings({ entra: choice(true) })
    const before = evaluate([delegated({ graph: healthy(DEFAULT_SCOPES, ago(DAY)) })], { settings: on }, new Date(NOW.getTime() - DAY)).baseline!
    const whole = evaluate([delegated({ graph: healthy([...DEFAULT_SCOPES, ...entra]), snapshot: before })], { settings: on }).report.changes
    expect(whole.filter((change) => change.kind === "becameReady")).toEqual([{ kind: "becameReady", service: "entra" }])
    // Only one of its areas: the area is named.
    const part = evaluate([delegated({ graph: healthy([...DEFAULT_SCOPES, "IdentityProvider.Read.All", "IdentityUserFlow.Read.All", "EventListener.Read.All", "CustomAuthenticationExtension.Read.All", "APIConnectors.Read.All", "MultiTenantOrganization.Read.All", "Policy.Read.B2BManagementPolicy"]), snapshot: before })], { settings: on }).report.changes
    expect(part).toContainEqual({ kind: "becameReady", service: "entra", area: "externalIdentities" })
    expect(part).not.toContainEqual({ kind: "becameReady", service: "entra" })
  })

  it("makes the state as it is the snapshot once the changes were looked at", () => {
    const snapshot: Snapshot = { at: ago(3 * DAY), account: ADMIN, permissions: [...WITHOUT_APPS].sort(), ready: { "intune/apps": false }, lost: [] }
    const first = evaluate([delegated({ graph: healthy(), snapshot })])
    expect(first.report.changes.length).toBeGreaterThan(0)
    expect(first.current).toMatchObject({ at: NOW.toISOString(), permissions: [...DEFAULT_SCOPES].sort() })
    expect(evaluate([delegated({ graph: healthy(), snapshot: first.current! })]).report.changes).toEqual([])
  })

  it("keeps the last known permissions in the snapshot when the changes are looked at while the sign-in fails", () => {
    const snapshot: Snapshot = { at: ago(3 * DAY), account: ADMIN, permissions: [...DEFAULT_SCOPES].sort(), ready: { "intune/apps": true }, lost: [] }
    const { current } = evaluate([delegated({ graph: failed({ class: "session" }), snapshot })])
    expect(current).toMatchObject({ permissions: snapshot.permissions, ready: { "intune/apps": true } })
  })
})

describe("tenant backup coverage", () => {
  const all = settings({ entra: choice(true), conditionalAccess: choice(true) })
  const permissions = [...graphPermissions({ entra: { access: "backup" }, conditionalAccess: { access: "backup" }, intune: { access: "restore" } }, "delegated")]

  it("shows full coverage on an existing own-registration tenant and keeps its service and restore settings", () => {
    const { report } = evaluate([delegated({ graph: healthy(permissions) })], { settings: all })
    expect(report.clientId).toBe(CLIENT)
    expect(report.coverage?.map(row => row.service)).toEqual(["entra", "intune"])
    for (const row of report.coverage!) {
      expect(row.folders.length).toBeGreaterThan(0)
      expect(row.readable).toEqual(row.folders)
      expect(row.issues).toEqual({})
    }
    expect(report.services.map(service => [service.id, service.enabled, service.access])).toEqual(
      MODULES.map(module => [module.id, all[module.id].enabled, all[module.id].access]),
    )
    expect(report.changes).toEqual([])
  })

  it("reports a scope gap, role refusal and unknown read separately, using evidence from the active sign-in only", () => {
    const graph = healthy(permissions.filter(permission => permission !== "AuthenticationContext.Read.All"))
    const current = run("newer", 1, {
      refused: [refusal("NamedLocations", "role", true)],
      unread: ["DeviceConfigurations"],
    })
    const previous = run("previous", 2, { read: ["NamedLocations", "DeviceConfigurations"] })
    const { report } = evaluate([delegated({ graph, runs: [previous, current] }), readerConnection({
      runs: [readerRun("reader", 0, { read: ["NamedLocations", "DeviceConfigurations"] })],
    })], { settings: all, readerClientId: READER })
    expect(report.coverage?.map(row => row.issues)).toMatchObject([
      { AuthenticationContexts: "permission" },
      { NamedLocations: "role" },
      { DeviceConfigurations: "unknown" },
    ])
    expect(report.coverage?.flatMap(row => row.readable ?? [])).not.toContain("DeviceConfigurations")
  })
})
