import assert from "node:assert/strict"
import { describe, it } from "vitest"
import { ConnectionHealth, type CheckTrigger, type HealthHost } from "../src/main/connection-health/service"
import type { ConnectionHealthReport, ConnectionMode, LossCause, ReaderObservation } from "../src/shared/connection-health/model"
import type { RunOutcomes, TypeOutcome } from "../src/shared/backup-outcomes"
import { SIGN_IN_ERRORS } from "../src/shared/sign-in-errors"
import { memoryStore } from "./helpers"

const TENANT = "tenant"
const APPS = "DeviceManagementApps.Read.All"
const CONFIG = "DeviceManagementConfiguration.Read.All"
const DAY = 86_400_000
const FOLDERS = ["Apps", "DeviceConfigurations"] as const
const TRIGGERS: CheckTrigger[] = ["launch", "signIn", "opened", "again", "beforeBackup", "afterBackup"]
type Lane = "admin" | "reader" | "storage"
type Event = { kind: string; a?: number; b?: number; c?: number }
type Answer = { at: number; permissions?: string[]; failure?: number }
type Read = { id: string; at: number; folder: string; outcome: number; held?: boolean }
type Loss = { folder: string; mode: ConnectionMode; since: string; cause: LossCause; episode: string }
const iso = (time: number) => new Date(time).toISOString()
const permissions = (bits: number) => [APPS, CONFIG].filter((_, index) => bits & (1 << index))
const jwt = (roles: string[], reader = false) => `e30.${Buffer.from(JSON.stringify(reader ? { roles } : { scp: roles.join(" ") })).toString("base64url")}.sig`
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve() }

/** Independent event ledger. It does not read stored records or import the evaluator or its helpers. */
function harness() {
  let clock = Date.parse("2026-11-15T12:00:00Z")
  let connected = true
  let account: string | null = "admin-A"
  let client = "registration-1"
  let storage = "storage-1"
  let reader: ReturnType<HealthHost["reader"]> = null
  let generation = 0
  let process = 0
  let serial = 0
  const epochs: Record<Lane, number> = { admin: 0, reader: 0, storage: 0 }
  const answers: Partial<Record<Lane, Answer>> = {}
  const reads: Record<"admin" | "reader", Read[]> = { admin: [], reader: [] }
  const pending: Array<{ lane: Lane; epoch: number; process: number; resolve: (value: any) => void; reject: (error: unknown) => void; done?: boolean }> = []
  const runs: Array<{ id: string; lane: "admin" | "reader"; epoch: number; process: number; valid: boolean; held?: boolean }> = []
  const acknowledged = new Set<string>()
  const reports: Array<{ report: ConnectionHealthReport; losses: Loss[]; epoch: number; permissions?: string[]; carried: string[]; found: string[] }> = []
  let baselinePermissions: string[] | undefined
  let carried: string[] = []
  let foundPermissions: string[] = []
  let ackTime = -Infinity
  const backing = memoryStore()
  const request = () => ({ tenantId: TENANT, clientId: client })
  const host: HealthHost = {
    store: backing, now: () => new Date(clock),
    tenant: () => connected ? { clientId: client, storage: "azure", storageId: storage } : null,
    account: () => account,
    reader: () => reader,
    settings: () => ({ intune: { enabled: true, access: "backup", areas: {} }, conditionalAccess: { enabled: false, access: "backup", areas: {} }, entra: { enabled: false, access: "backup", areas: {} }, defender: { enabled: false, access: "backup", areas: {} } }),
    token: (_tenant, _client, resource) => new Promise((resolve, reject) => pending.push({ lane: resource === "graph" ? "admin" : "storage", epoch: epochs[resource === "graph" ? "admin" : "storage"], process, resolve, reject })),
    readerToken: () => new Promise((resolve, reject) => pending.push({ lane: "reader", epoch: epochs.reader, process, resolve, reject })),
  }
  let health = new ConnectionHealth(host)
  const fresh = (answer: Answer | undefined) => answer && clock - answer.at <= 7 * DAY ? answer : undefined
  const granted = (lane: Lane): string[] | undefined => {
    const answer = fresh(answers[lane])
    if (lane === "reader" && reader?.facts.state === "verified" && reader.facts.verifiedAt && clock - Date.parse(reader.facts.verifiedAt) <= 7 * DAY && (!answer || Date.parse(reader.facts.verifiedAt) > answer.at)) return reader.facts.verifiedRoles ?? undefined
    return answer?.permissions
  }
  const permissionChanges = () => {
    const current = granted("admin")
    if (!current || !baselinePermissions) return foundPermissions
    foundPermissions = [...current.filter((permission) => !baselinePermissions!.includes(permission)).map((p) => `+${p}`), ...baselinePermissions.filter((p) => !current.includes(p)).map((p) => `-${p}`)].sort()
    return foundPermissions
  }
  const reset = (lane: Lane) => {
    const found = lane === "admin" ? permissionChanges() : []
    epochs[lane]++
    delete answers[lane]
    if (lane !== "storage") reads[lane] = []
    if (lane === "admin") {
      carried.push(...found)
      baselinePermissions = undefined
      foundPermissions = []
      ackTime = -Infinity
    }
  }
  const losses = (): Loss[] => (["admin", "reader"] as const).flatMap((lane) => FOLDERS.flatMap((folder) => {
    const history = reads[lane].filter((read) => read.folder === folder && clock - read.at <= 90 * DAY)
    const lastRead = history.filter((read) => read.outcome === 0).at(-1)
    if (!lastRead) return []
    const refused = history.filter((read) => read.at > lastRead.at && read.outcome >= 1 && read.outcome <= 3)
    if (refused.length < 2) return []
    const first = refused[0]!
    const last = refused.at(-1)!
    const permission = folder === "Apps" ? APPS : CONFIG
    const cause: LossCause = last.outcome === 2 ? "role" : last.outcome === 3 ? "license" : granted(lane)?.includes(permission) ? last.held === false ? "notVerifiedYet" : "refusedWithPermission" : "permission"
    return [{ folder, mode: lane === "admin" ? "delegated" as const : "app-only" as const, since: iso(first.at), cause, episode: `${lane}/${epochs[lane]}/${folder}/${first.id}` }]
  }))
  const start = (lane: "admin" | "reader", held?: boolean) => {
    const run = { id: `run-${++serial}`, lane, epoch: epochs[lane], process, held, valid: connected && (lane === "admin" || !!reader?.clientId) }
    health.runStarted({ id: run.id, authMode: lane === "admin" ? "delegated" : "app-only" }, request())
    if (held !== undefined) health.runToken(run.id, { kind: lane === "admin" ? "delegated" : "application", permissions: new Set(held ? [APPS, CONFIG] : []) })
    runs.push(run)
    return runs.length - 1
  }
  const finish = (index: number, outcome: number, folder: string) => {
    const run = runs[index]
    if (!run) return
    const base = { folder, service: "intune" as const }
    const types: TypeOutcome[] = outcome === 0 ? [{ ...base, outcome: "saved", saved: 1 }] : outcome <= 3 ? [{ ...base, outcome: "skipped", cause: outcome === 1 ? "permission" : outcome === 2 ? "role" : "license", reason: "private message must not be stored" }] : outcome === 4 ? [{ ...base, outcome: "notConfigured" }] : outcome === 5 ? [] : outcome === 6 ? [{ ...base, outcome: "skipped", cause: "permission", reader: true, reason: "left out" }] : [{ ...base, outcome: "failed", saved: 0, error: outcome === 7 ? "timeout" : "stopped" }]
    const mode = run.lane === "admin" ? "delegated" : "app-only"
    const result: RunOutcomes = { runId: run.id, tenantId: TENANT, authMode: mode, trigger: mode === "delegated" ? "manual" : "scheduled", startedAt: iso(clock - 1), endedAt: iso(clock), status: outcome === 8 ? "Cancelled" : "Success", coverage: "complete", types }
    health.recordRun(result, request())
    health.runEnded(run.id)
    if (run.valid && connected && (run.lane === "reader" ? !!reader?.clientId : true) && run.epoch === epochs[run.lane] && run.process === process && !reads[run.lane].some((read) => read.id === run.id)) reads[run.lane].push({ id: run.id, at: clock, folder, outcome, held: run.held })
  }
  const facts = (verified = false): Omit<ReaderObservation, "at"> => ({ state: verified ? "verified" : "pending", notAfter: iso(clock + 200 * DAY), verifiedAt: verified ? iso(clock) : null, verifiedRoles: verified ? [APPS, CONFIG] : null, roleChange: null })
  const step = async ({ kind, a = 0, b = 0, c = 0 }: Event) => {
    clock += 1000
    if (kind === "admin") {
      const next = a % 2 ? "admin-B" : "admin-A"
      if (next !== account) { reset("admin"); reset("storage") }
      account = next
    } else if (kind === "signOut") {
      // A sign-out removes the reader in the real host too.
      reset("admin"); reset("reader"); reset("storage")
      account = null; reader = null
      health.signedOut(TENANT)
    } else if (kind === "removeTenant") {
      reset("admin"); reset("reader"); reset("storage")
      connected = false; reader = null; baselinePermissions = undefined; carried = []
      health.forget(TENANT)
    } else if (kind === "addTenant") connected = true
    else if (kind === "client") {
      const next = `registration-${1 + a % 2}`
      if (client !== next) { reset("admin"); reset("storage"); carried = [] }
      client = next
    } else if (kind === "storage") {
      const next = `storage-${1 + a % 2}`
      if (storage !== next) reset("storage")
      storage = next
    } else if (kind === "setup" || kind === "replace") {
      reset("reader")
      reader = { clientId: "reader", credential: `public-thumbprint-${++generation}`, facts: facts(kind === "replace") }
    } else if (kind === "removeReader") { reset("reader"); reader = null }
    else if (kind === "verify" && reader) reader.facts = { ...facts(true), verifiedRoles: permissions(a % 4) }
    else if (kind === "roles" && reader) reader.facts = { ...reader.facts, roleChange: { at: iso(clock), added: permissions(a % 4), removed: permissions(b % 4) } }
    else if (kind === "check" && connected) void health.check(TENANT, TRIGGERS[a % TRIGGERS.length]!, { reader: b % 2 === 0, failed: c % 2 === 0 }).catch(() => undefined)
    else if (kind === "answer" || kind === "failure") {
      const available = pending.filter((check) => !check.done && check.process === process)
      const check = available[a % available.length]
      if (check) {
        check.done = true
        if (kind === "answer") check.resolve(check.lane === "reader" ? jwt(permissions(b % 4), true) : { accessToken: jwt(permissions(b % 4)), fromCache: c % 4 === 0 })
        else check.reject({ errorNo: SIGN_IN_ERRORS[b % SIGN_IN_ERRORS.length]!.code.slice(6), message: "private message must not be stored" })
        if (check.epoch === epochs[check.lane] && connected && (account || check.lane === "reader" || kind === "failure") && (kind === "failure" || check.lane === "reader" || c % 4 !== 0)) {
          answers[check.lane] = { at: clock, ...(kind === "failure" ? { failure: b % SIGN_IN_ERRORS.length } : { permissions: permissions(b % 4) }) }
          if (check.lane === "admin" && kind === "answer" && !baselinePermissions) baselinePermissions = permissions(b % 4)
        }
      }
    } else if (kind === "runStart") start(a % 2 ? "reader" : "admin", b % 3 === 2 ? undefined : b % 3 === 1)
    else if (kind === "runFinish") finish(a % runs.length, b % 9, FOLDERS[c % 2]!)
    else if (kind === "run") finish(start(a % 2 ? "reader" : "admin", c % 3 === 2 ? undefined : c % 3 === 1), b % 9, FOLDERS[Math.floor(c / 3) % 2]!)
    else if (kind === "time") clock += [60_001, 8 * DAY, 91 * DAY][a % 3]!
    else if (kind === "ack" && reports.length) {
      const shown = reports[a % reports.length]!
      if (shown.report.acknowledgement) {
        // Receipts are bounded. A report outside the last twenty distinct receipts is safely ignored.
        const recent = [...new Set(reports.filter((r) => r.epoch === epochs.admin).map((r) => r.report.acknowledgement).filter(Boolean))].slice(-20)
        if (shown.epoch === epochs.admin && recent.includes(shown.report.acknowledgement)) {
          for (const loss of shown.losses) acknowledged.add(loss.episode)
          carried = carried.filter((change) => !shown.carried.includes(change))
          if (shown.permissions && Date.parse(shown.report.evaluatedAt) >= ackTime) {
            baselinePermissions = shown.permissions
            foundPermissions = foundPermissions.filter((change) => !shown.found.includes(change))
            ackTime = Date.parse(shown.report.evaluatedAt)
          }
        }
        health.acknowledge(TENANT, shown.report.acknowledgement)
      }
    } else if (kind === "restart") {
      process++
      health = new ConnectionHealth(host)
    }
    health.connectionsChanged(TENANT)
    await flush()
    const report = health.report(TENANT)
    const expected = connected ? losses() : []
    const previousReport = reports.at(-1)?.report
    if (kind === "client" && connected && previousReport?.since && previousReport.clientId !== client) assert.deepEqual(report.changes.find((change) => change.kind === "registrationReplaced"), { kind: "registrationReplaced", previousClientId: previousReport.clientId, lacks: [] })
    const readerAnswer = fresh(answers.reader)
    const verification = reader?.facts.state === "verified" && reader.facts.verifiedAt && clock - Date.parse(reader.facts.verifiedAt) <= 7 * DAY ? Date.parse(reader.facts.verifiedAt) : undefined
    const newestReader = verification !== undefined && (!readerAnswer || verification > readerAnswer.at) ? { at: verification } : readerAnswer
    assert.equal(report.reader.checkedAt, reader && newestReader ? iso(newestReader.at) : null)
    if (!reader) assert.equal(report.reader.state, "notSetUp")
    else if (reader.facts.state === "pending") assert.equal(report.reader.state, "pending")
    else if (clock >= Date.parse(reader.facts.notAfter)) assert.equal(report.reader.state, "certificateExpired")
    else if (newestReader && "failure" in newestReader && newestReader.failure !== undefined) {
      const failed = SIGN_IN_ERRORS[newestReader.failure]!.class
      assert.equal(report.reader.state, failed === "throttled" ? "throttled" : failed === "unavailable" ? "unreachable" : "refused")
    } else assert.equal(report.reader.state, reader.facts.roleChange ? "rolesChanged" : Date.parse(reader.facts.notAfter) - clock <= 30 * DAY ? "certificateExpiring" : "healthy")
    const actual = report.services.flatMap((service) => service.areas.flatMap((area) => area.losses))
    assert.deepEqual(actual.map(({ folder, mode, since, cause }) => ({ folder, mode, since, cause })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), expected.map(({ episode: _episode, ...loss }) => loss).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))))
    const notices = report.changes.flatMap((change) => change.kind === "lostAccess" ? change.folders.map((folder) => `${change.mode}/${folder}`) : []).sort()
    assert.deepEqual(notices, expected.filter((loss) => !acknowledged.has(loss.episode)).map((loss) => `${loss.mode}/${loss.folder}`).sort())
    for (const lane of ["admin", "storage"] as const) {
      const value = lane === "admin" ? report.graph : report.storage
      const answer = connected ? fresh(answers[lane]) : undefined
      assert.equal(value.checkedAt, answer ? iso(answer.at) : null)
      assert.equal(value.state, !connected && lane === "storage" ? "local" : !answer ? "notChecked" : answer.failure !== undefined ? SIGN_IN_ERRORS[answer.failure]!.state === "refused" ? "unknown" : SIGN_IN_ERRORS[answer.failure]!.state : "healthy")
    }
    assert.deepEqual(report.granted, connected ? granted("admin")?.slice().sort() ?? null : null)
    const gotChanges = report.changes.flatMap((change) => change.kind === "permissionsAdded" || change.kind === "permissionsRemoved" ? change.permissions.map((p) => `${change.kind === "permissionsAdded" ? "+" : "-"}${p}`) : []).sort()
    assert.deepEqual(gotChanges, connected ? [...carried, ...permissionChanges()].sort() : [])
    // Creating a second service is an actual restart read of the persisted value, not an evaluator call.
    assert.deepEqual(new ConnectionHealth(host).report(TENANT), report)
    const raw = backing.get(`connectionHealth.${TENANT}`)
    if (raw) {
      assert.doesNotMatch(raw, /private message|accessToken|privateKey|certificatePem|\.sig/)
      const stored = JSON.parse(raw)
      assert.ok(stored.connections.length <= 4)
      for (const record of stored.connections) {
        assert.equal(Object.keys(record).every((key) => ["clientId", "mode", "owner", "storageOwner", "receipts", "acknowledgedRevision", "account", "graph", "storage", "reader", "runs", "verified", "refused", "snapshot", "updatedAt"].includes(key)), true)
        assert.ok(record.runs.length <= 5)
        assert.ok((record.receipts?.length ?? 0) <= 20)
        for (const key of ["verified", "refused"]) assert.ok(Object.keys(record[key]).length <= 600)
        for (const refusals of Object.values(record.refused) as unknown[][]) assert.ok(refusals.length <= 2)
      }
      if (kind === "signOut") assert.doesNotMatch(raw, /admin-A|admin-B/)
    }
    if (!reads.admin.length && !reads.reader.length) assert.equal(report.services.every((service) => service.verified.state === "noBackup"), true)
    reports.push({ report, losses: expected, epoch: epochs.admin, permissions: granted("admin") ?? baselinePermissions, carried: [...carried], found: permissionChanges().slice() })
    return report
  }
  const close = async () => {
    // Retire outstanding checks without leaving timers alive after the test.
    connected = false; health.connectionsChanged(TENANT)
    for (const check of pending) if (!check.done) { check.done = true; check.resolve(null) }
    await flush()
  }
  return { step, close }
}

function random(seed: number) {
  let value = seed >>> 0
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return value >>> 0 }
}
const KINDS = ["admin", "signOut", "removeTenant", "addTenant", "client", "setup", "verify", "replace", "roles", "removeReader", "storage", "check", "check", "answer", "answer", "failure", "runStart", "runFinish", "run", "run", "run", "ack", "time", "restart"]
async function replay(seed: number, events: Event[]) {
  const test = harness()
  const prefix: Event[] = []
  try {
    for (const event of events) { prefix.push(event); await test.step(event) }
  } catch (error) {
    // Every prefix was checked, so this is the shortest failing prefix of this generated sequence.
    throw new Error(`seed=${seed}; smallest failing prefix (${prefix.length} events): ${JSON.stringify(prefix)}`, { cause: error })
  } finally { await test.close() }
}

const run = (outcome: number, lane = 0, folder = 0): Event => ({ kind: "run", a: lane, b: outcome, c: folder * 3 })
describe("connection health rules over event sequences", () => {
  it("does not clear a loss when a later run finds the type not configured (seed 0x4e43)", async () => {
    await replay(0x4e43, [run(0), run(1), run(1), run(4)])
  })
  it("keeps a reader's loss notice without a token check of the admin (seed 0x5244)", async () => {
    await replay(0x5244, [{ kind: "setup" }, { kind: "verify", a: 3 }, run(0, 1), run(1, 1), run(1, 1)])
  })
  it("ignores permissions without a signed-in account (seed 1640532134)", async () => {
    await replay(1640532134, [{ kind: "check", a: 3 }, { kind: "answer", b: 0, c: 1 }, { kind: "signOut" }, { kind: "check", a: 3 }, { kind: "answer", a: 1, b: 3, c: 1 }])
  })
  it("keeps registration notices after observations expire (seed 1640535218)", async () => {
    await replay(1640535218, [{ kind: "check", a: 3 }, { kind: "answer", b: 1, c: 1 }, { kind: "answer", b: 1, c: 1 }, { kind: "check", a: 3 }, { kind: "answer", b: 0, c: 1 }, { kind: "time", a: 2 }, { kind: "setup" }, run(7, 1)])
  })
  it("names a registration change before its first check answers (seed 1640531620)", async () => {
    await replay(1640531620, [run(0), { kind: "client", a: 1 }, { kind: "client", a: 0 }])
  })
  it("does not acknowledge later permissions from a report with none known (seed 1640535318)", async () => {
    await replay(1640535318, [run(0), { kind: "check", a: 3 }, { kind: "answer", b: 1, c: 1 }, { kind: "answer", b: 1, c: 1 }, { kind: "check", a: 3 }, { kind: "answer", b: 3, c: 1 }, { kind: "ack", a: 0 }])
  })
  it("keeps reader notices and acknowledgements through admin and registration changes (seed 1640536094)", async () => {
    const loss = [{ kind: "setup" }, { kind: "verify", a: 3 }, run(0, 1), run(1, 1), run(1, 1)]
    await replay(1640536094, [...loss, { kind: "admin", a: 1 }, { kind: "client", a: 1 }, { kind: "client", a: 0 }])
    await replay(1640536094, [...loss, { kind: "ack", a: 4 }, { kind: "admin", a: 1 }, { kind: "client", a: 1 }])
    await replay(1640536094, [{ kind: "signOut" }, ...loss, { kind: "ack", a: 5 }])
  })
  it("checks every prefix of reproducible generated sequences", async () => {
    const count = Number(process.env.TENUVAULT_HEALTH_SEQUENCES ?? 300)
    if (!Number.isSafeInteger(count) || count < 300) throw new Error("TENUVAULT_HEALTH_SEQUENCES must be an integer of at least 300.")
    for (let index = 0; index < count; index++) {
      const seed = (0x61c88647 + index) >>> 0
      const next = random(seed)
      const events = Array.from({ length: 40 }, (): Event => ({ kind: KINDS[next() % KINDS.length]!, a: next() % 100, b: next() % 100, c: next() % 100 }))
      await replay(seed, events)
    }
  }, 600_000)
})
