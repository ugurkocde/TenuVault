import { describe, expect, it } from "vitest"
import { HEALTH_STORE_VERSION, HealthStore, MAX_CONNECTIONS, MAX_ENTRIES, MAX_RUNS, type ConnectionKey } from "../src/main/connection-health/store"
import { RUN_MAX_AGE_MS, type RunObservation } from "../src/shared/connection-health/model"
import { runObservation } from "../src/shared/connection-health/observe"
import type { RunOutcomes, TypeOutcome } from "../src/shared/backup-outcomes"
import { memoryStore } from "./helpers"

const NOW = new Date("2026-11-14T12:00:00.000Z")
const DAY = 86_400_000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "33333333-3333-3333-3333-333333333333"
const READER = "44444444-4444-4444-4444-444444444444"
const ADMIN = "aaaaaaaa-0000-0000-0000-000000000001.11111111-1111-1111-1111-111111111111"
const OTHER_ADMIN = "bbbbbbbb-0000-0000-0000-000000000002.11111111-1111-1111-1111-111111111111"
const KEY = `connectionHealth.${TENANT}`

const admin: ConnectionKey = { tenantId: TENANT, clientId: CLIENT, mode: "delegated" }
const reader: ConnectionKey = { tenantId: TENANT, clientId: READER, mode: "app-only" }

const run = (runId: string, daysAgo: number, parts: Partial<RunObservation> = {}): RunObservation => ({ runId, at: ago(daysAgo * DAY), trigger: "manual", status: "Success", account: ADMIN, read: [], refused: [], unread: [], excluded: [], ...parts })

function setup(now = NOW) {
  const backing = memoryStore()
  let clock = now
  return { backing, store: new HealthStore(backing, () => clock), stored: () => JSON.parse(backing.get(KEY) ?? "null"), at: (next: Date) => { clock = next } }
}

describe("what a backup run says about access", () => {
  const outcomes = (types: TypeOutcome[], authMode: "delegated" | "app-only" = "delegated"): RunOutcomes => ({
    runId: "desktop-1", tenantId: TENANT, authMode, trigger: "scheduled", startedAt: ago(2 * DAY), endedAt: ago(DAY), status: "CompletedWithWarnings", coverage: "incomplete", types,
  })
  const of = (folder: string) => ({ folder, service: "intune" as const })

  it("keeps every selected type under what its outcome means, and none of the run's texts", () => {
    const observation = runObservation(outcomes([
      { ...of("DeviceConfigurations"), outcome: "saved", saved: 12 },
      { ...of("Branding"), outcome: "notConfigured" },
      { ...of("Apps"), outcome: "skipped", cause: "permission", reason: "Access was denied. The app registration may lack the permission for contoso.onmicrosoft.com.", status: 403, code: "Forbidden" },
      { ...of("ScopeTags"), outcome: "skipped", cause: "role", reason: "Microsoft refused the read although the permission is granted." },
      { ...of("AutopilotProfiles"), outcome: "skipped", cause: "license", reason: "This tenant is not set up for it.", status: 400 },
      { ...of("DeviceCategories"), outcome: "skipped", cause: "permission", reason: "The Backup Reader has no permission for this type.", reader: true },
      { ...of("MdmEnrollmentPolicies"), outcome: "skipped", cause: "signedIn", reason: "Microsoft Graph lets only a signed-in admin read this type." },
      { ...of("CompliancePolicies"), outcome: "failed", error: "Access denied for admin@contoso.com", saved: 0, status: 403, code: "Authorization_RequestDenied" },
      { ...of("ConfigurationPolicies"), outcome: "failed", error: "Too many requests", saved: 3, status: 429 },
      { ...of("PowerShellScripts"), outcome: "failed", error: "The backup stopped before this type was read in full.", saved: 0 },
    ]), ADMIN)
    expect(observation).toEqual({
      runId: "desktop-1",
      at: ago(DAY),
      trigger: "scheduled",
      status: "CompletedWithWarnings",
      account: ADMIN,
      read: ["DeviceConfigurations", "Branding"],
      refused: [
        { folder: "Apps", cause: "permission", status: 403, code: "Forbidden" },
        { folder: "ScopeTags", cause: "role" },
        { folder: "AutopilotProfiles", cause: "license", status: 400 },
        // A refusal that ended the type as failed is a refusal all the same.
        { folder: "CompliancePolicies", cause: "permission", status: 403, code: "Authorization_RequestDenied" },
      ],
      // A throttle and a run that stopped say nothing about access.
      unread: ["ConfigurationPolicies", "PowerShellScripts"],
      excluded: [{ folder: "DeviceCategories", cause: "reader" }, { folder: "MdmEnrollmentPolicies", cause: "signedIn" }],
    })
    expect(JSON.stringify(observation)).not.toMatch(/contoso|denied|Too many|stopped/)
  })

  it("names no account for a Backup Reader run", () => {
    expect(runObservation(outcomes([], "app-only"), ADMIN)).not.toHaveProperty("account")
    expect(runObservation(outcomes([]))).not.toHaveProperty("account")
  })

  it("dates the run by when it ended", () => {
    expect(runObservation(outcomes([])).at).toBe(ago(DAY))
  })
})

describe("the observation store", () => {
  it("keeps observations per tenant, client ID and sign-in mode, under one versioned value per tenant", () => {
    const { store, stored, backing } = setup()
    store.recordToken(admin, "graph", { at: ago(60_000), permissions: ["User.Read"] }, ADMIN)
    store.recordToken(reader, "graph", { at: ago(30_000), failure: { class: "credential", code: "AADSTS700027" } })
    store.recordToken({ ...admin, tenantId: "22222222-2222-2222-2222-222222222222" }, "graph", { at: ago(1000) })
    expect([...backing.values.keys()].sort()).toEqual([KEY, "connectionHealth.22222222-2222-2222-2222-222222222222"])
    expect(stored().version).toBe(HEALTH_STORE_VERSION)
    expect(store.connections(TENANT).map((record) => [record.clientId, record.mode])).toEqual([[READER, "app-only"], [CLIENT, "delegated"]])
    expect(store.connections(TENANT.toUpperCase())).toHaveLength(2)
    expect(store.connections("99999999-9999-9999-9999-999999999999")).toEqual([])
  })

  it("matches a connection whatever the case of its IDs", () => {
    const { store } = setup()
    store.recordToken(admin, "graph", { at: ago(60_000) })
    store.recordToken({ tenantId: TENANT.toUpperCase(), clientId: CLIENT.toUpperCase(), mode: "delegated" }, "storage", { at: ago(1000) })
    expect(store.connections(TENANT)).toHaveLength(1)
    expect(store.connections(TENANT)[0]).toMatchObject({ graph: { at: ago(60_000) }, storage: { at: ago(1000) } })
  })

  it("stores one observation of each kind as nothing but permission names, classes, codes, folders and times", () => {
    const { store, stored } = setup()
    store.recordToken(admin, "graph", { at: ago(60_000), permissions: ["DeviceManagementApps.Read.All", "User.Read"] }, ADMIN)
    store.recordToken(admin, "storage", { at: ago(60_000), failure: { class: "consent", code: "AADSTS65001" } }, ADMIN)
    store.recordRun(admin, run("desktop-1", 1, { read: ["Apps"], refused: [{ folder: "ScopeTags", cause: "role", status: 403, code: "Forbidden" }], unread: ["Branding"] }))
    store.recordReader(reader, { at: ago(1000), state: "verified", notAfter: ago(-100 * DAY), verifiedAt: ago(10 * DAY), verifiedRoles: ["DeviceManagementApps.Read.All"], roleChange: { added: ["Policy.Read.All"], removed: [], at: ago(DAY) } })
    store.setSnapshot(admin, { at: ago(60_000), account: ADMIN, permissions: ["User.Read"], ready: { "intune/apps": true }, lost: [] })
    expect(stored()).toEqual({
      version: 1,
      connections: [
        {
          clientId: CLIENT,
          mode: "delegated",
          account: ADMIN,
          graph: { at: ago(60_000), permissions: ["DeviceManagementApps.Read.All", "User.Read"] },
          storage: { at: ago(60_000), failure: { class: "consent", code: "AADSTS65001" } },
          runs: [{ runId: "desktop-1", at: ago(DAY), trigger: "manual", status: "Success", account: ADMIN, read: ["Apps"], refused: [{ folder: "ScopeTags", cause: "role", status: 403, code: "Forbidden" }], unread: ["Branding"], excluded: [] }],
          verified: { Apps: ago(DAY) },
          snapshot: { at: ago(60_000), account: ADMIN, permissions: ["User.Read"], ready: { "intune/apps": true }, lost: [] },
          updatedAt: NOW.toISOString(),
        },
        {
          clientId: READER,
          mode: "app-only",
          reader: { at: ago(1000), state: "verified", notAfter: ago(-100 * DAY), verifiedAt: ago(10 * DAY), verifiedRoles: ["DeviceManagementApps.Read.All"], roleChange: { added: ["Policy.Read.All"], removed: [], at: ago(DAY) } },
          runs: [],
          verified: {},
          updatedAt: NOW.toISOString(),
        },
      ],
    })
  })

  it("keeps a run once, whatever it says the second time", () => {
    const { store } = setup()
    store.recordRun(admin, run("desktop-1", 2, { refused: [{ folder: "Apps", cause: "permission" }] }))
    store.recordRun(admin, run("desktop-1", 1, { read: ["Apps"] }))
    const [record] = store.connections(TENANT)
    expect(record!.runs).toHaveLength(1)
    expect(record!.runs[0]).toMatchObject({ at: ago(2 * DAY), refused: [{ folder: "Apps" }] })
    expect(record!.verified).toEqual({})
  })

  it("keeps the last runs of a connection, oldest first, and when each folder was last read", () => {
    const { store } = setup()
    for (let index = 1; index <= MAX_RUNS + 3; index++) store.recordRun(admin, run(`desktop-${index}`, 20 - index, { read: index === 1 ? ["Apps", "ScopeTags"] : ["Apps"] }))
    // A run that arrives late is put where its time belongs.
    store.recordRun(admin, run("late", 12.5))
    const [record] = store.connections(TENANT)
    expect(record!.runs.map((kept) => kept.runId)).toEqual(["desktop-5", "desktop-6", "desktop-7", "late", "desktop-8"])
    // The read of a run that is no longer kept stays known.
    expect(record!.verified).toEqual({ Apps: ago(12 * DAY), ScopeTags: ago(19 * DAY) })
  })

  it("keeps a bounded number of connections per tenant: the ones used last", () => {
    const { store } = setup()
    for (let index = 0; index < MAX_CONNECTIONS + 2; index++) store.recordToken({ ...admin, clientId: `0000000${index}-0000-0000-0000-000000000000` }, "graph", { at: ago((10 - index) * DAY) })
    const kept = store.connections(TENANT).map((record) => record.clientId)
    expect(kept).toHaveLength(MAX_CONNECTIONS)
    expect(kept).toContain("00000005-0000-0000-0000-000000000000")
    expect(kept).not.toContain("00000000-0000-0000-0000-000000000000")
    expect(kept).not.toContain("00000001-0000-0000-0000-000000000000")
  })

  it("caps every list it stores", () => {
    const { store } = setup()
    const many = Array.from({ length: MAX_ENTRIES + 50 }, (_, index) => `Permission.${index}`)
    store.recordToken(admin, "graph", { at: ago(1000), permissions: many }, ADMIN)
    store.recordRun(admin, run("desktop-1", 1, { read: many }))
    const [record] = store.connections(TENANT)
    expect(record!.graph!.permissions).toHaveLength(MAX_ENTRIES)
    expect(record!.runs[0]!.read).toHaveLength(MAX_ENTRIES)
    expect(Object.keys(record!.verified)).toHaveLength(MAX_ENTRIES)
  })

  it("drops runs and reads that expired when it writes, and a connection that was not used for as long", () => {
    const { store, at } = setup(new Date(NOW.getTime() - 80 * DAY))
    store.recordRun(admin, run("old", 80, { read: ["Apps"] }))
    store.recordToken(reader, "graph", { at: ago(80 * DAY) })
    at(new Date(NOW.getTime() - 5 * DAY))
    store.recordRun(admin, run("recent", 5, { read: ["ScopeTags"] }))
    expect(store.connections(TENANT)[0]!.runs.map((kept) => kept.runId)).toEqual(["old", "recent"])
    // Fifteen days on, the first run and the reader's record are more than ninety days old.
    at(new Date(NOW.getTime() + 15 * DAY))
    store.recordToken(admin, "graph", { at: new Date(NOW.getTime() + 15 * DAY).toISOString() })
    const records = store.connections(TENANT)
    expect(records.map((record) => record.mode)).toEqual(["delegated"])
    expect(records[0]!.runs.map((kept) => kept.runId)).toEqual(["recent"])
    expect(records[0]!.verified).toEqual({ ScopeTags: ago(5 * DAY) })
    expect(RUN_MAX_AGE_MS).toBe(90 * DAY)
  })

  it("starts a record over for another admin: their answers, runs and reads are their own", () => {
    const { store } = setup()
    store.recordToken(admin, "graph", { at: ago(5 * DAY), permissions: ["User.Read"] }, ADMIN)
    store.recordToken(admin, "storage", { at: ago(5 * DAY) }, ADMIN)
    store.recordRun(admin, run("desktop-1", 4, { read: ["Apps"] }))
    store.setSnapshot(admin, { at: ago(5 * DAY), account: ADMIN, permissions: ["User.Read"], lost: [] })
    store.recordToken(admin, "graph", { at: ago(DAY), permissions: ["User.Read", "Mail.Send"] }, OTHER_ADMIN)
    const [record] = store.connections(TENANT)
    expect(record).toMatchObject({ account: OTHER_ADMIN, graph: { permissions: ["User.Read", "Mail.Send"] }, runs: [], verified: {} })
    expect(record).not.toHaveProperty("storage")
    // The snapshot still names the earlier admin, which is how the evaluator knows not to compare.
    expect(record!.snapshot!.account).toBe(ADMIN)
  })

  it("keeps the record's admin for an answer that names none", () => {
    const { store } = setup()
    store.recordToken(admin, "graph", { at: ago(5 * DAY), permissions: ["User.Read"] }, ADMIN)
    store.recordRun(admin, run("desktop-1", 4, { read: ["Apps"] }))
    store.recordToken(admin, "graph", { at: ago(DAY), failure: { class: "session" } })
    expect(store.connections(TENANT)[0]).toMatchObject({ account: ADMIN, graph: { failure: { class: "session" } }, verified: { Apps: ago(4 * DAY) } })
  })

  it("reads a value of another version, or one that cannot be read, as nothing observed, and replaces it", () => {
    for (const value of ["{", "null", "[]", JSON.stringify({ version: 2, connections: [{ clientId: CLIENT, mode: "delegated", runs: [], verified: {}, updatedAt: ago(0) }] }), JSON.stringify({ version: 1, connections: "none" })]) {
      const { store, backing, stored } = setup()
      backing.set(KEY, value)
      expect(store.connections(TENANT)).toEqual([])
      store.recordToken(admin, "graph", { at: ago(1000) })
      expect(stored()).toMatchObject({ version: 1, connections: [{ clientId: CLIENT, graph: { at: ago(1000) } }] })
    }
  })

  it("leaves out the parts of a stored record that do not read, never guessing them", () => {
    const { store, backing } = setup()
    backing.set(KEY, JSON.stringify({
      version: 1,
      connections: [
        { clientId: CLIENT, mode: "delegated", updatedAt: ago(1000), account: 7, graph: { at: "yesterday", permissions: ["User.Read"] }, storage: { at: ago(1000), permissions: "all", failure: { class: 5 } }, runs: [{ runId: "r1" }, "run", { runId: "r2", at: ago(DAY), read: ["Apps", 3], refused: [{ folder: "ScopeTags", cause: "curse" }, { folder: "Branding", cause: "license", status: "403" }], excluded: [{ folder: "X", cause: "reader" }, { folder: "Y" }] }], verified: { Apps: "never", ScopeTags: ago(DAY) }, snapshot: { at: ago(DAY), ready: { "intune/apps": "yes", "intune/roles": false }, replaces: { clientId: 12 } }, reader: { state: "verified" } },
        { clientId: READER, mode: "certificate", updatedAt: ago(1000) },
        { mode: "delegated", updatedAt: ago(1000) },
        "connection",
      ],
    }))
    expect(store.connections(TENANT)).toEqual([{
      clientId: CLIENT,
      mode: "delegated",
      storage: { at: ago(1000) },
      runs: [{ runId: "r2", at: ago(DAY), trigger: "manual", status: "", read: ["Apps"], refused: [{ folder: "Branding", cause: "license" }], unread: [], excluded: [{ folder: "X", cause: "reader" }] }],
      verified: { ScopeTags: ago(DAY) },
      snapshot: { at: ago(DAY), ready: { "intune/roles": false } },
      updatedAt: ago(1000),
    }])
  })

  it("never stores a token, however an observation is recorded", () => {
    const { store, backing } = setup()
    const secret = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.secret-token-body.signature"
    // What a careless caller might hand over next to the fields an observation has.
    store.recordToken(admin, "graph", { at: ago(1000), permissions: ["User.Read"], accessToken: secret, account: { username: "admin@contoso.com" } } as never, ADMIN)
    store.recordReader(reader, { at: ago(1000), state: "verified", notAfter: ago(-DAY), verifiedAt: null, verifiedRoles: null, roleChange: null, privateKeyPem: secret } as never)
    // What is stored is read back through the same checks, so only what a record may hold survives a restart.
    const reread = JSON.stringify(new HealthStore(backing).connections(TENANT))
    expect(reread).not.toContain("secret-token-body")
    expect(reread).not.toContain("contoso")
  })

  it("drops what was observed for the account when the admin signs out, and keeps what the registration had", () => {
    const { store } = setup()
    store.recordToken(admin, "graph", { at: ago(DAY), permissions: ["User.Read", "Mail.Send"] }, ADMIN)
    store.recordRun(admin, run("desktop-1", 1, { read: ["Apps"] }))
    store.setSnapshot(admin, { at: ago(2 * DAY), account: ADMIN, permissions: ["User.Read"], lost: [], replaces: { clientId: "55555555-5555-5555-5555-555555555555" } })
    store.recordToken(reader, "graph", { at: ago(DAY) })
    store.signedOut(TENANT)
    expect(store.connections(TENANT)).toEqual([{
      clientId: CLIENT,
      mode: "delegated",
      runs: [],
      verified: {},
      snapshot: { at: ago(2 * DAY), permissions: ["User.Read", "Mail.Send"], replaces: { clientId: "55555555-5555-5555-5555-555555555555" } },
      updatedAt: NOW.toISOString(),
    }])
  })

  it("keeps nothing after a sign-out for a connection that never saw a permission", () => {
    const { store, backing } = setup()
    store.recordToken(admin, "graph", { at: ago(DAY), failure: { class: "session" } }, ADMIN)
    store.signedOut(TENANT)
    expect(backing.get(KEY)).toBeNull()
  })

  it("forgets a tenant that was removed", () => {
    const { store, backing } = setup()
    store.recordToken(admin, "graph", { at: ago(DAY) })
    store.forget(TENANT.toUpperCase())
    expect(backing.get(KEY)).toBeNull()
  })

  it("drops the tenant's other records of the same sign-in mode on request, and only those", () => {
    const { store } = setup()
    store.recordToken({ ...admin, clientId: "55555555-5555-5555-5555-555555555555" }, "graph", { at: ago(5 * DAY) })
    store.recordToken(reader, "graph", { at: ago(DAY) })
    store.recordToken(admin, "graph", { at: ago(1000) })
    store.dropOthers(admin)
    expect(store.connections(TENANT).map((record) => record.clientId).sort()).toEqual([CLIENT, READER])
  })
})
