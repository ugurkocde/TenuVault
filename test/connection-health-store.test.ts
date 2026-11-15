import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { HEALTH_STORE_VERSION, HealthStore, MAX_CONNECTIONS, MAX_ENTRIES, MAX_RUNS, type ConnectionKey } from "../src/main/connection-health/store"
import { RUN_MAX_AGE_MS, type RunObservation } from "../src/shared/connection-health/model"
import { evaluateHealth } from "../src/shared/connection-health/evaluate"
import { MODULES } from "../src/shared/services/modules"
import { keepEvidence, runObservation } from "../src/shared/connection-health/observe"
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

const outcomesForFolder = (folder: string): RunOutcomes => ({ runId: "bad", tenantId: TENANT, authMode: "delegated", trigger: "manual", startedAt: ago(DAY), endedAt: ago(0), status: "Success", coverage: "complete", types: [{ folder, service: "intune", outcome: "saved", saved: 1 }] })

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
          refused: {},
          snapshot: { at: ago(60_000), account: ADMIN, permissions: ["User.Read"], ready: { "intune/apps": true }, lost: [] },
          updatedAt: NOW.toISOString(),
        },
        {
          clientId: READER,
          mode: "app-only",
          reader: { at: ago(1000), state: "verified", notAfter: ago(-100 * DAY), verifiedAt: ago(10 * DAY), verifiedRoles: ["DeviceManagementApps.Read.All"], roleChange: { added: ["Policy.Read.All"], removed: [], at: ago(DAY) } },
          runs: [],
          verified: {},
          refused: {},
          updatedAt: NOW.toISOString(),
        },
      ],
    })
  })

  it.each([true, false, undefined])("round trips only the known permission fact of a refused run: %s", (permissionHeld) => {
    const { store } = setup()
    store.recordRun(admin, run("read", 3, { read: ["Apps"] }))
    const outcomes: RunOutcomes = { runId: "refused", tenantId: TENANT, authMode: "delegated", trigger: "manual", startedAt: ago(2 * DAY), endedAt: ago(DAY), status: "Success", coverage: "incomplete", types: [{ folder: "Apps", service: "intune", outcome: "failed", saved: 0, status: 403, error: "Forbidden" }] }
    store.recordRun(admin, runObservation(outcomes, ADMIN, { Apps: permissionHeld }))
    const record = store.connections(TENANT)[0]!
    const expected = permissionHeld === undefined ? { cause: "permission" } : { cause: "permission", permissionHeld }
    expect(record.runs[1]!.refused[0]).toMatchObject(expected)
    expect(record.refused.Apps![0]).toMatchObject(expected)
    if (permissionHeld === undefined) expect(record.refused.Apps![0]).not.toHaveProperty("permissionHeld")
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

  it("keeps what says a type was lost per folder, whatever the backups after it select", () => {
    const { store } = setup()
    store.recordRun(admin, run("desktop-1", 20, { read: ["Apps", "DeviceConfigurations"] }))
    store.recordRun(admin, run("desktop-2", 19, { read: ["DeviceConfigurations"], refused: [{ folder: "Apps", cause: "role", status: 403, code: "Forbidden" }] }))
    store.recordRun(admin, run("desktop-3", 18, { read: ["DeviceConfigurations"], refused: [{ folder: "Apps", cause: "permission" }] }))
    for (let index = 4; index < 4 + MAX_RUNS; index++) store.recordRun(admin, run(`desktop-${index}`, 21 - index, { read: ["DeviceConfigurations"] }))
    const [record] = store.connections(TENANT)
    // No run that is still kept says anything about the apps.
    expect(record!.runs.flatMap((kept) => [...kept.read, ...kept.refused.map((refusal) => refusal.folder)])).not.toContain("Apps")
    expect(record!.verified).toEqual({ Apps: ago(20 * DAY), DeviceConfigurations: ago((21 - 3 - MAX_RUNS) * DAY) })
    // The run, its time and the cause it found: no status, code or text of the answer.
    expect(record!.refused).toEqual({ Apps: [{ runId: "desktop-2", at: ago(19 * DAY), cause: "role" }, { runId: "desktop-3", at: ago(18 * DAY), cause: "permission" }] })
  })

  it("rebuilds a known loss from validated kept runs when the stored refusal map is absent", () => {
    const { backing, store } = setup()
    backing.set(KEY, readFileSync(new URL("./fixtures/connection-health-before-folder-refusals.json", import.meta.url), "utf8"))
    const records = store.connections(TENANT)
    expect(records[0]!.refused.Apps).toEqual([
      { runId: "old-1", at: "2026-11-11T12:00:00.000Z", cause: "role" },
      { runId: "old-2", at: "2026-11-12T12:00:00.000Z", cause: "role" },
    ])
    const settings = Object.fromEntries(MODULES.map((module) => [module.id, { enabled: true, access: "backup", areas: {} }])) as Parameters<typeof evaluateHealth>[0]["settings"]
    const { report } = evaluateHealth({ tenantId: TENANT, clientId: CLIENT, reader: null, storage: "local", settings, connections: records }, NOW)
    expect(report.services[0]!.areas.find((area) => area.id === "apps")!.lostAccess).toBe(true)
    // Runs of another account and malformed refusals never rebuild evidence.
    const earlier = JSON.parse(backing.get(KEY)!)
    earlier.connections[0].runs[1].account = "another-admin"
    earlier.connections[0].runs[2].refused[0].cause = "unknown-cause"
    backing.set(KEY, JSON.stringify(earlier))
    expect(store.connections(TENANT)[0]!.refused).toEqual({})
  })

  it("bounds the evidence rebuilt from earlier records", () => {
    const { backing, store } = setup()
    const folders = Array.from({ length: MAX_ENTRIES }, (_, index) => `Folder${index}`)
    const runs = [run("old", 3, { read: ["Apps"] }), run("new", 2, { read: folders }), run("refused", 1, { refused: folders.map((folder) => ({ folder, cause: "role" })) })]
    backing.set(KEY, JSON.stringify({ version: 1, connections: [{ clientId: CLIENT, mode: "delegated", account: ADMIN, updatedAt: ago(0), verified: {}, runs }] }))
    const record = store.connections(TENANT)[0]!
    expect(Object.keys(record.verified)).toHaveLength(MAX_ENTRIES)
    expect(record.verified).not.toHaveProperty("Apps")
    expect(Object.keys(record.refused)).toHaveLength(MAX_ENTRIES)
  })

  it("keeps the first and the latest refusal of a folder, each run once, and none from before its last read", () => {
    const { store } = setup()
    const refusedBy = () => (store.connections(TENANT)[0]!.refused.Apps ?? []).map((refusal) => refusal.runId)
    const refuse = (runId: string, daysAgo: number) => store.recordRun(admin, run(runId, daysAgo, { refused: [{ folder: "Apps", cause: "role" }] }))
    // A folder that was never read cannot be lost.
    refuse("early", 30)
    expect(store.connections(TENANT)[0]!.refused).toEqual({})
    store.recordRun(admin, run("read", 20, { read: ["Apps"] }))
    for (const [runId, daysAgo] of [["r1", 19], ["r2", 18], ["r3", 17], ["r4", 16]] as const) refuse(runId, daysAgo)
    expect(refusedBy()).toEqual(["r1", "r4"])
    // A refusal from before the read says nothing about now, and a read ends the refusals before it.
    refuse("old", 25)
    expect(refusedBy()).toEqual(["r1", "r4"])
    store.recordRun(admin, run("read-again", 10, { read: ["Apps"] }))
    expect(store.connections(TENANT)[0]).toMatchObject({ verified: { Apps: ago(10 * DAY) }, refused: {} })
    // A run that could not read the folder for another reason, or left it out, changes nothing.
    refuse("r5", 9)
    store.recordRun(admin, run("unread", 8, { unread: ["Apps"], excluded: [{ folder: "Apps", cause: "reader" }] }))
    expect(refusedBy()).toEqual(["r5"])
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

  it("drops the refusals of a folder with the read they came after", () => {
    const { store, at } = setup(new Date(NOW.getTime() - 80 * DAY))
    store.recordRun(admin, run("read", 80, { read: ["Apps", "ScopeTags"] }))
    at(new Date(NOW.getTime() - 5 * DAY))
    store.recordRun(admin, run("r1", 6, { read: ["ScopeTags"], refused: [{ folder: "Apps", cause: "role" }] }))
    store.recordRun(admin, run("r2", 5, { read: ["ScopeTags"], refused: [{ folder: "Apps", cause: "role" }] }))
    expect(store.connections(TENANT)[0]!.refused.Apps).toHaveLength(2)
    // Fifteen days on, the read of the apps is more than ninety days old: nothing says they were ever read.
    at(new Date(NOW.getTime() + 15 * DAY))
    store.recordToken(admin, "graph", { at: new Date(NOW.getTime() + 15 * DAY).toISOString() })
    expect(store.connections(TENANT)[0]).toMatchObject({ verified: { ScopeTags: ago(5 * DAY) }, refused: {} })
  })

  it("starts a record over for another admin: their answers, runs and reads are their own", () => {
    const { store } = setup()
    store.recordToken(admin, "graph", { at: ago(5 * DAY), permissions: ["User.Read"] }, ADMIN)
    store.recordToken(admin, "storage", { at: ago(5 * DAY) }, ADMIN)
    store.recordRun(admin, run("desktop-1", 4, { read: ["Apps"] }))
    store.recordRun(admin, run("desktop-2", 3, { refused: [{ folder: "Apps", cause: "role" }] }))
    expect(store.connections(TENANT)[0]!.refused.Apps).toHaveLength(1)
    store.setSnapshot(admin, { at: ago(5 * DAY), account: ADMIN, permissions: ["User.Read"], lost: [] })
    store.recordToken(admin, "graph", { at: ago(DAY), permissions: ["User.Read", "Mail.Send"] }, OTHER_ADMIN)
    const [record] = store.connections(TENANT)
    expect(record).toMatchObject({ account: OTHER_ADMIN, graph: { permissions: ["User.Read", "Mail.Send"] }, runs: [], verified: {}, refused: {} })
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
        { clientId: CLIENT, mode: "delegated", updatedAt: ago(1000), account: 7, graph: { at: "yesterday", permissions: ["User.Read"] }, storage: { at: ago(1000), permissions: "all", failure: { class: 5 } }, runs: [{ runId: "r1" }, "run", { runId: "r2", at: ago(DAY), read: ["Apps", 3], refused: [{ folder: "ScopeTags", cause: "curse" }, { folder: "Branding", cause: "license", status: "403" }], excluded: [{ folder: "X", cause: "reader" }, { folder: "Y" }] }], verified: { Apps: "never", ScopeTags: ago(DAY) }, refused: { Apps: "twice", Branding: [{ runId: "r3", at: ago(DAY), cause: "curse" }, { runId: "r4", at: "today", cause: "role" }], ScopeTags: [{ runId: "r5", at: ago(1000), cause: "role", status: 403, message: "Access denied for admin@contoso.com" }, "refusal", { runId: "r6", at: ago(500), cause: "license" }, { runId: "r7", at: ago(100), cause: "role" }] }, snapshot: { at: ago(DAY), ready: { "intune/apps": "yes", "intune/roles": false }, replaces: { clientId: 12 } }, reader: { state: "verified" } },
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
      refused: { ScopeTags: [{ runId: "r5", at: ago(1000), cause: "role" }, { runId: "r6", at: ago(500), cause: "license" }] },
      snapshot: { at: ago(DAY), ready: { "intune/roles": false } },
      updatedAt: ago(1000),
    }])
  })

  it.each(["__proto__", "constructor", "toString", ""])("drops a malformed folder record for %j and loads and writes the rest", (folder) => {
    const { store, backing } = setup()
    const bad = { clientId: READER, mode: "app-only", updatedAt: ago(0), verified: {}, runs: [run("bad", 1, { read: [folder] })] }
    const good = { clientId: CLIENT, mode: "delegated", updatedAt: ago(0), runs: [], verified: {} }
    for (const record of [bad, { ...bad, runs: [], verified: { [folder]: ago(DAY) } }, { ...bad, runs: [], refused: { [folder]: [] } }]) {
      backing.set(KEY, JSON.stringify({ version: 1, connections: [record, good] }))
      expect(store.connections(TENANT).map((kept) => kept.clientId)).toEqual([CLIENT])
      store.recordToken(admin, "graph", { at: ago(1000), permissions: ["User.Read"] }, ADMIN)
      expect(store.connections(TENANT)[0]!.graph!.permissions).toEqual(["User.Read"])
    }
    store.recordRun(admin, run("bad-live", 1, { read: [folder] }))
    expect(backing.get(KEY)).not.toContain("bad-live")
    expect(runObservation(outcomesForFolder(folder)).read).toEqual([])
  })

  it("allowlists acknowledged loss episodes and keeps only the existing account ID", () => {
    const { store, stored } = setup()
    const episode = { clientId: CLIENT, mode: "delegated", account: ADMIN, folder: "Apps", since: ago(DAY), runId: "first-refusal" }
    store.setSnapshot(admin, { at: ago(0), acknowledgedLosses: [
      { ...episode, username: "admin@contoso.com", token: "secret" },
      { ...episode, mode: "app-only", account: "not-an-admin", clientId: READER },
      { ...episode, folder: "__proto__" },
      { ...episode, mode: "unknown" },
    ] } as never)
    expect(stored().connections[0].snapshot.acknowledgedLosses).toEqual([episode, { clientId: READER, mode: "app-only", folder: "Apps", since: ago(DAY), runId: "first-refusal" }])
  })

  it("never reads inherited folder evidence or permission evidence", () => {
    const evidence = { verified: Object.create({ Apps: ago(2 * DAY) }), refused: Object.create({ Apps: "not a list" }) }
    keepEvidence(evidence, run("read", 1, { read: ["Apps"] }))
    expect(Object.hasOwn(evidence.verified, "Apps")).toBe(true)
    expect(evidence.verified.Apps).toBe(ago(DAY))
    keepEvidence(evidence, run("refused", 0, { refused: [{ folder: "Apps", cause: "role" }] }))
    expect(evidence.refused.Apps).toEqual([{ runId: "refused", at: ago(0), cause: "role" }])
    const outcomes: RunOutcomes = { ...outcomesForFolder("Apps"), types: [{ folder: "Apps", service: "intune", outcome: "skipped", cause: "permission", reason: "Refused" }] }
    expect(runObservation(outcomes, ADMIN, Object.create({ Apps: false })).refused[0]).not.toHaveProperty("permissionHeld")
  })

  it("never stores a token, however an observation is recorded", () => {
    const { store, backing } = setup()
    const secret = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.secret-token-body.signature"
    // Check each write before another write could sanitize it on a read.
    const assertRaw = () => {
      const raw = backing.get(KEY)!
      expect(raw).not.toContain("secret-token-body")
      expect(raw).not.toContain("contoso")
    }
    // What a careless caller might hand over next to the fields an observation has.
    store.recordToken(admin, "graph", { at: ago(1000), permissions: ["User.Read"], accessToken: secret, account: { username: "admin@contoso.com" } } as never, ADMIN)
    assertRaw()
    store.recordReader(reader, { at: ago(1000), state: "verified", notAfter: ago(-DAY), verifiedAt: null, verifiedRoles: null, roleChange: null, privateKeyPem: secret } as never)
    assertRaw()
    store.recordToken(admin, "storage", { at: ago(1000), failure: { class: "consent", code: "AADSTS65001", message: secret }, token: secret } as never, ADMIN)
    assertRaw()
    store.recordRun(admin, { ...run("private", 1, { read: ["Apps"] }), accessToken: secret, refused: [{ folder: "ScopeTags", cause: "role", message: secret }], excluded: [{ folder: "Branding", cause: "reader", message: secret }] } as never)
    assertRaw()
    store.setSnapshot(admin, { at: ago(1000), secret, replaces: { clientId: CLIENT, secret }, found: [{ kind: "permissionsAdded", permissions: ["User.Read"], message: secret }] } as never)
    assertRaw()
  })

  it("drops what was observed for the account when the admin signs out, and keeps what the registration had", () => {
    const { store } = setup()
    store.recordToken(admin, "graph", { at: ago(DAY), permissions: ["User.Read", "Mail.Send"] }, ADMIN)
    store.recordRun(admin, run("desktop-2", 2, { read: ["Apps"] }))
    store.recordRun(admin, run("desktop-1", 1, { refused: [{ folder: "Apps", cause: "role" }] }))
    store.setSnapshot(admin, { at: ago(2 * DAY), account: ADMIN, permissions: ["User.Read"], lost: [], replaces: { clientId: "55555555-5555-5555-5555-555555555555" } })
    store.recordToken(reader, "graph", { at: ago(DAY) })
    store.signedOut(TENANT)
    expect(store.connections(TENANT)).toEqual([{
      clientId: CLIENT,
      mode: "delegated",
      runs: [],
      verified: {},
      refused: {},
      snapshot: { at: ago(2 * DAY), permissions: ["User.Read", "Mail.Send"], replaces: { clientId: "55555555-5555-5555-5555-555555555555" } },
      updatedAt: NOW.toISOString(),
    }])
  })

  it("keeps the permission changes nobody looked at through a sign-out, for whoever signs in next", () => {
    const { store } = setup()
    const added = { kind: "permissionsAdded" as const, permissions: ["Mail.Send"] }
    const ready = { kind: "becameReady" as const, service: "intune" as const, area: "apps" }
    store.recordToken(admin, "graph", { at: ago(DAY), permissions: ["User.Read", "Mail.Send"] }, ADMIN)
    store.setSnapshot(admin, { at: ago(2 * DAY), account: ADMIN, permissions: ["User.Read"], lost: ["intune/apps"], carried: [ready], found: [added] })
    store.signedOut(TENANT)
    expect(store.connections(TENANT)[0]!.snapshot).toEqual({ at: ago(2 * DAY), permissions: ["User.Read", "Mail.Send"], carried: [ready, added].map((change) => ({ ...change, earlierSignIn: true })) })
    // Earlier values had no discovery time: none is invented from the baseline date.
    expect(store.connections(TENANT)[0]!.snapshot!.carried![0]).not.toHaveProperty("foundAt")
    // Also for an admin whose own sign-in never showed a permission: what was found before them is not theirs to lose.
    store.setSnapshot(admin, { at: ago(2 * DAY), account: OTHER_ADMIN, lost: [], carried: [added] })
    store.recordToken(admin, "graph", { at: ago(1000), failure: { class: "session" } }, OTHER_ADMIN)
    store.signedOut(TENANT)
    expect(store.connections(TENANT)[0]!.snapshot).toEqual({ at: ago(2 * DAY), carried: [{ ...added, earlierSignIn: true }] })
  })

  it("reads only the changes of a snapshot that are whole", () => {
    const { store, backing } = setup()
    const changes = [
      { kind: "permissionsAdded", permissions: ["Mail.Send", 7], note: "for admin@contoso.com" },
      { kind: "permissionsRemoved" },
      { kind: "becameReady", service: "intune", area: "apps" },
      { kind: "becameReady", service: "sharepoint" },
      { kind: "lostAccess", service: "intune", area: "apps", cause: "role", mode: "delegated", folders: ["Apps"], since: ago(DAY) },
      "change",
    ]
    backing.set(KEY, JSON.stringify({ version: 1, connections: [{ clientId: CLIENT, mode: "delegated", updatedAt: ago(1000), runs: [], verified: {}, snapshot: { at: ago(DAY), found: changes, carried: "all" } }] }))
    expect(store.connections(TENANT)[0]!.snapshot).toEqual({ at: ago(DAY), found: [{ kind: "permissionsAdded", permissions: ["Mail.Send"] }, { kind: "becameReady", service: "intune", area: "apps" }] })
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
