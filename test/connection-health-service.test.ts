import { InteractionRequiredAuthError } from "@azure/msal-node"
import { describe, expect, it, vi } from "vitest"
import { BackupReaderError } from "../src/main/auth/backup-reader"
import { SignInRequiredError } from "../src/main/auth/msal"
import { CHECK_INTERVAL_MS, CHECK_TIMEOUT_MS, ConnectionHealth, selectedTenant, type HealthHost } from "../src/main/connection-health/service"
import type { ServiceChoice } from "../src/shared/connection-health/evaluate"
import type { ConnectionMode, ReaderObservation } from "../src/shared/connection-health/model"
import { DEFAULT_SETUP_CHOICE, graphPermissions } from "../src/shared/services/manifest"
import type { ModuleId } from "../src/shared/services/modules"
import { fixture, jwt, refusal, scriptedGraph, TENANT, CLIENT } from "./helpers/backup-fixture"
import { memoryStore } from "./helpers"

const START = new Date("2026-11-14T12:00:00.000Z")
const MINUTE = 60_000
const DAY = 86_400_000
const READER = "44444444-4444-4444-4444-444444444444"
const ADMIN = "aaaaaaaa-0000-0000-0000-000000000001.11111111-1111-1111-1111-111111111111"
const OTHER_ADMIN = "bbbbbbbb-0000-0000-0000-000000000002.11111111-1111-1111-1111-111111111111"
const SCOPES = [...graphPermissions(DEFAULT_SETUP_CHOICE, "delegated")]
const WITHOUT_APPS = SCOPES.filter((permission) => !permission.startsWith("DeviceManagementApps"))

const choice = (enabled: boolean, access: "backup" | "restore" = "backup"): ServiceChoice => ({ enabled, access, areas: {} })
const SETTINGS: Record<ModuleId, ServiceChoice> = { intune: choice(true, "restore"), conditionalAccess: choice(false), entra: choice(false), defender: choice(false) }

/** A token with these scopes, issued two hours before the test's clock starts. Not signed. */
const token = (scopes: string[]) => `e30.${Buffer.from(JSON.stringify({ scp: scopes.join(" "), iat: Math.floor((START.getTime() - 2 * 60 * MINUTE) / 1000) })).toString("base64url")}.sig`
const fresh = (scopes: string[] = SCOPES) => ({ accessToken: token(scopes), fromCache: false })
const READER_FACTS: Omit<ReaderObservation, "at"> = { state: "verified", notAfter: new Date(START.getTime() + 200 * DAY).toISOString(), verifiedAt: new Date(START.getTime() - 30 * DAY).toISOString(), verifiedRoles: ["DeviceManagementApps.Read.All"], roleChange: null }

function setup(overrides: Partial<HealthHost> = {}) {
  const backing = memoryStore()
  let clock = START.getTime()
  const state = {
    tenant: { clientId: CLIENT, storage: "local" as "local" | "azure" } as ReturnType<HealthHost["tenant"]>,
    account: ADMIN as string | null,
    reader: null as { clientId: string; credential: string; facts: Omit<ReaderObservation, "at"> } | null,
  }
  const tokens = vi.fn<HealthHost["token"]>(async () => fresh())
  const readerToken = vi.fn<HealthHost["readerToken"]>(async () => `e30.${Buffer.from(JSON.stringify({ roles: ["DeviceManagementApps.Read.All"] })).toString("base64url")}.sig`)
  const changed = vi.fn()
  const health = new ConnectionHealth({
    store: backing,
    now: () => new Date(clock),
    tenant: () => state.tenant,
    account: () => state.account,
    settings: () => SETTINGS,
    token: tokens,
    reader: () => state.reader,
    readerToken,
    changed,
    ...overrides,
  })
  const stored = () => JSON.parse(backing.get(`connectionHealth.${TENANT}`) ?? "null") as { connections: Array<Record<string, any>> } | null
  return { health, backing, state, tokens, readerToken, changed, stored, now: () => new Date(clock).toISOString(), pass: (ms: number) => { clock += ms } }
}

describe("a check", () => {
  it("records what Microsoft answered, dated by when the check ran, never by the token", async () => {
    const { health, tokens, pass, now, stored } = setup()
    // The answer takes three seconds: the observation carries the time it came back.
    tokens.mockImplementationOnce(async () => { pass(3000); return fresh() })
    const report = await health.check(TENANT, "again")
    const at = new Date(START.getTime() + 3000).toISOString()
    expect(now()).toBe(at)
    expect(report.graph).toEqual({ state: "healthy", checkedAt: at })
    expect(stored()!.connections[0]!.graph).toEqual({ at, permissions: [...SCOPES].sort() })
    // The token was issued two hours earlier by its own claim, which is not when it was checked.
    expect(JSON.stringify(stored())).not.toContain(new Date(START.getTime() - 2 * 60 * MINUTE).toISOString())
    expect(tokens).toHaveBeenCalledWith(TENANT, CLIENT, "graph")
  })

  it("never records a cached token as a check", async () => {
    const { health, tokens, stored, pass } = setup()
    tokens.mockResolvedValueOnce({ accessToken: token(SCOPES), fromCache: true })
    expect((await health.check(TENANT, "again")).graph).toEqual({ state: "notChecked", checkedAt: null })
    expect(stored()).toBeNull()
    // Nor a token whose origin the sign-in did not say.
    tokens.mockResolvedValueOnce({ accessToken: token(SCOPES) })
    expect((await health.check(TENANT, "again")).graph.state).toBe("notChecked")
    expect(stored()).toBeNull()

    // A real answer, then a cached one: the real answer stands, with its own time.
    const first = await health.check(TENANT, "again")
    pass(10 * MINUTE)
    tokens.mockResolvedValueOnce({ accessToken: token(WITHOUT_APPS), fromCache: true })
    const second = await health.check(TENANT, "again")
    expect(second.graph).toEqual({ state: "healthy", checkedAt: first.graph.checkedAt })
    expect(second.granted).toEqual([...SCOPES].sort())
  })

  it("records a refusal by its class and code, and resolves all the same", async () => {
    const { health, tokens, stored } = setup()
    const answer = new InteractionRequiredAuthError("interaction_required", "correlation", "AADSTS50076: Due to a configuration change made by your administrator, admin@contoso.com must use multi-factor authentication.", undefined, undefined, undefined, undefined, "50076")
    tokens.mockRejectedValueOnce(new SignInRequiredError(TENANT, CLIENT, "Microsoft needs you to sign in again as admin@contoso.com for Microsoft Graph (interaction_required, AADSTS50076).", undefined, answer))
    const report = await health.check(TENANT, "again")
    expect(report.graph).toEqual({ state: "mfaRequired", checkedAt: START.toISOString(), class: "mfa", code: "AADSTS50076", link: "https://login.microsoftonline.com/error?code=50076" })
    expect(stored()!.connections[0]!.graph).toEqual({ at: START.toISOString(), failure: { class: "mfa", code: "AADSTS50076" } })
    // Neither the message nor the account it names is kept.
    expect(JSON.stringify(stored())).not.toMatch(/contoso|sign in again|configuration change/)
  })

  it("asks for a storage token only for a tenant that keeps its backups in Azure, and tells the two sign-ins apart", async () => {
    const local = setup()
    expect((await local.health.check(TENANT, "again")).storage).toEqual({ state: "local", checkedAt: null })
    expect(local.tokens.mock.calls.map((call) => call[2])).toEqual(["graph"])

    const azure = setup()
    azure.state.tenant = { clientId: CLIENT, storage: "azure" }
    azure.tokens.mockImplementation(async (_tenant, _client, resource) => {
      if (resource === "graph") return fresh()
      throw new SignInRequiredError(TENANT, CLIENT, "Microsoft needs you to sign in again for Azure Storage.", undefined, { errorNo: "65001", errorCode: "invalid_grant" })
    })
    const report = await azure.health.check(TENANT, "again")
    expect(azure.tokens.mock.calls.map((call) => call[2]).sort()).toEqual(["graph", "storage"])
    expect(report.graph.state).toBe("healthy")
    expect(report.storage).toMatchObject({ state: "consentMissing", code: "AADSTS65001" })
  })

  it("refuses a tenant that is not connected, and reports nothing for it", async () => {
    const { health, state, tokens } = setup()
    state.tenant = null
    await expect(health.check(TENANT, "again")).rejects.toThrow("Connect this tenant first.")
    expect(tokens).not.toHaveBeenCalled()
    expect(health.report(TENANT)).toMatchObject({ graph: { state: "notChecked" }, changes: [], since: null })
  })

  it("stops waiting for an answer that does not come, records that, and lets the next check run", async () => {
    vi.useFakeTimers()
    try {
      const { health, tokens } = setup()
      tokens.mockImplementationOnce(() => new Promise(() => undefined))
      const waiting = health.check(TENANT, "again")
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS)
      expect((await waiting).graph).toMatchObject({ state: "unreachable", class: "unreachable" })
      // The check that hung no longer holds the tenant's checks up.
      expect((await health.check(TENANT, "again")).graph.state).toBe("healthy")
    } finally {
      vi.useRealTimers()
    }
  })

  it("tells the window when what is known about a tenant changed", async () => {
    const { health, changed } = setup()
    await health.check(TENANT.toUpperCase(), "again")
    expect(changed).toHaveBeenCalledWith(TENANT, "admin")
  })
})

describe("triggers that follow each other", () => {
  it("share one check while it runs", async () => {
    const { health, tokens } = setup()
    let answer: (value: ReturnType<typeof fresh>) => void = () => undefined
    tokens.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const checks = [health.check(TENANT, "launch"), health.check(TENANT, "opened"), health.check(TENANT, "beforeBackup"), health.check(TENANT, "afterBackup")]
    answer(fresh())
    const reports = await Promise.all(checks)
    expect(tokens).toHaveBeenCalledTimes(1)
    expect(new Set(reports.map((report) => report.graph.checkedAt)).size).toBe(1)
  })

  it("are not answered by a check that started before a sign-in or before the admin asked again", async () => {
    const { health, tokens, pass } = setup()
    let refuse: (error: Error) => void = () => undefined
    // The check under way started while the sign-in had ended: Microsoft refuses it.
    tokens.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject }))
    const before = health.check(TENANT, "launch")
    // The admin signs in and asks again while it runs: one more check follows it, shared by both.
    const after = [health.check(TENANT, "signIn"), health.check(TENANT, "signIn"), health.check(TENANT, "afterBackup", { failed: true })]
    pass(1000)
    refuse(new SignInRequiredError(TENANT, CLIENT, "Your session for admin@contoso.com has ended. Sign in again to continue."))
    expect((await before).graph.state).toBe("signInNeeded")
    const reports = await Promise.all(after)
    expect(tokens).toHaveBeenCalledTimes(2)
    expect(reports.map((report) => report.graph.state)).toEqual(["healthy", "healthy", "healthy"])
  })

  it("answer from the last check when they come within a minute of it", async () => {
    const { health, tokens, pass } = setup()
    await health.check(TENANT, "launch")
    pass(CHECK_INTERVAL_MS - 1)
    for (const trigger of ["launch", "opened", "beforeBackup", "afterBackup"] as const) expect((await health.check(TENANT, trigger)).graph.state).toBe("healthy")
    expect(tokens).toHaveBeenCalledTimes(1)
    pass(1)
    await health.check(TENANT, "opened")
    expect(tokens).toHaveBeenCalledTimes(2)
  })

  it("always ask Microsoft when the admin asks to check again, after a sign-in, and after a backup that failed", async () => {
    const { health, tokens } = setup()
    await health.check(TENANT, "launch")
    await health.check(TENANT, "again")
    await health.check(TENANT, "signIn")
    await health.check(TENANT, "afterBackup", { failed: true })
    expect(tokens).toHaveBeenCalledTimes(4)
    await health.check(TENANT, "afterBackup", { failed: false })
    expect(tokens).toHaveBeenCalledTimes(4)
  })

  it("keep each tenant's checks apart", async () => {
    const { health, tokens } = setup()
    await health.check(TENANT, "launch")
    await health.check("99999999-9999-9999-9999-999999999999", "launch")
    expect(tokens).toHaveBeenCalledTimes(2)
  })
})

describe("a tenant that is signed out of or removed while a check runs", () => {
  const KEY = `connectionHealth.${TENANT}`
  /** A token request that answers when the test says so. */
  function pending() {
    let resolve: (value: ReturnType<typeof fresh>) => void = () => undefined
    let reject: (error: Error) => void = () => undefined
    const request = new Promise<ReturnType<typeof fresh>>((onAnswer, onRefusal) => { resolve = onAnswer; reject = onRefusal })
    return { request, resolve, reject }
  }

  it("is not brought back by the answer that comes late, whether Microsoft issued a token or refused", async () => {
    for (const answer of ["token", "refusal"] as const) {
      const { health, tokens, backing, changed } = setup()
      await health.check(TENANT, "launch")
      const asked = pending()
      tokens.mockImplementationOnce(() => asked.request)
      const late = health.check(TENANT, "again")
      // The tenant is removed from the app while Microsoft has not answered yet.
      health.forget(TENANT)
      expect(backing.get(KEY)).toBeNull()
      changed.mockClear()
      if (answer === "token") asked.resolve(fresh())
      else asked.reject(new SignInRequiredError(TENANT, CLIENT, "Your session has ended. Sign in again to continue."))
      const report = await late
      // Nothing of the answer is kept, nobody is told, and the report is what is known now: nothing.
      expect(backing.get(KEY)).toBeNull()
      expect(changed).not.toHaveBeenCalled()
      expect(report).toMatchObject({ graph: { state: "notChecked", checkedAt: null }, granted: null, changes: [], since: null })
    }
  })

  it("keeps only what a sign-out leaves, whatever the late answer says", async () => {
    const { health, tokens, stored, changed } = setup()
    await health.check(TENANT, "launch")
    const asked = pending()
    tokens.mockImplementationOnce(() => asked.request)
    const late = health.check(TENANT, "again")
    health.signedOut(TENANT)
    const left = JSON.stringify(stored())
    // What stays after a sign-out names no account and holds no answer.
    expect(left).not.toContain(ADMIN)
    expect(stored()!.connections[0]).not.toHaveProperty("graph")
    changed.mockClear()
    asked.resolve(fresh(WITHOUT_APPS))
    expect((await late).graph.state).toBe("notChecked")
    expect(JSON.stringify(stored())).toBe(left)
    expect(changed).not.toHaveBeenCalled()
  })

  it("is not brought back by a late answer of the Backup Reader", async () => {
    const { health, state, readerToken, backing } = setup()
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    let answer: (token: string) => void = () => undefined
    readerToken.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const late = health.check(TENANT, "again")
    // The admin's token came back before the tenant was removed; the reader's is still on its way.
    await Promise.resolve()
    health.forget(TENANT)
    state.reader = null
    answer(`e30.${Buffer.from(JSON.stringify({ roles: ["DeviceManagementApps.Read.All"] })).toString("base64url")}.sig`)
    expect((await late).reader.state).toBe("notSetUp")
    expect(backing.get(KEY)).toBeNull()
  })

  it("does not run a check that was waiting behind the one that ran", async () => {
    const { health, tokens, backing } = setup()
    const asked = pending()
    tokens.mockImplementationOnce(() => asked.request)
    const running = health.check(TENANT, "launch")
    // A check that must not be answered by the running one waits for it to end.
    const waiting = health.check(TENANT, "signIn")
    health.forget(TENANT)
    asked.resolve(fresh())
    expect((await running).graph.state).toBe("notChecked")
    expect((await waiting).graph.state).toBe("notChecked")
    // It asked Microsoft nothing: the admin who wanted it is gone.
    expect(tokens).toHaveBeenCalledTimes(1)
    expect(backing.get(KEY)).toBeNull()
  })

  it("checks at once for whoever signs in next, and still drops what the earlier check brings", async () => {
    const { health, state, tokens, stored } = setup()
    const asked = pending()
    tokens.mockImplementationOnce(() => asked.request)
    const late = health.check(TENANT, "launch")
    const queued = health.check(TENANT, "afterBackup", { failed: true })
    health.signedOut(TENANT)
    // Another admin signs in while the earlier check is still out. Their check neither waits for it nor shares its answer.
    state.account = OTHER_ADMIN
    const report = await health.check(TENANT, "signIn")
    expect(tokens).toHaveBeenCalledTimes(2)
    expect(report.granted).toEqual([...SCOPES].sort())
    expect(stored()!.connections[0]).toMatchObject({ account: OTHER_ADMIN })
    // The earlier answer, for the admin who signed out, arrives after it.
    asked.resolve(fresh(WITHOUT_APPS))
    await late
    await queued
    expect(tokens).toHaveBeenCalledTimes(2)
    expect(stored()!.connections[0]).toMatchObject({ account: OTHER_ADMIN, graph: { permissions: [...SCOPES].sort() } })
    expect(health.report(TENANT).granted).toEqual([...SCOPES].sort())
    // A page that opens within the minute is answered by the new admin's check, not asked again because of the old one.
    await health.check(TENANT, "opened")
    expect(tokens).toHaveBeenCalledTimes(2)
  })
})

describe("a check whose identity changed", () => {
  it.each(["token", "refusal"] as const)("drops admin A's late %s without deleting admin B's completed backup", async (answer) => {
    const { health, state, tokens, stored, changed, now } = setup()
    let resolve = (_value: ReturnType<typeof fresh>) => undefined as void
    let reject = (_error: Error) => undefined as void
    tokens.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no }))
    const earlier = health.check(TENANT, "launch")
    state.account = OTHER_ADMIN
    const queued = health.check(TENANT, "signIn")
    health.runStarted({ id: "b-read", authMode: "delegated" }, { tenantId: TENANT, clientId: CLIENT })
    health.recordRun({ runId: "b-read", tenantId: TENANT, authMode: "delegated", trigger: "manual", startedAt: now(), endedAt: now(), status: "Success", coverage: "complete", types: [{ folder: "Apps", service: "intune", outcome: "saved", saved: 1 }] }, { tenantId: TENANT, clientId: CLIENT })
    const evidence = stored()!.connections[0]!
    changed.mockClear()
    if (answer === "token") resolve(fresh(WITHOUT_APPS))
    else reject(new SignInRequiredError(TENANT, CLIENT, "Sign in again."))
    await earlier
    await queued
    expect(tokens).toHaveBeenCalledTimes(2)
    expect(stored()!.connections[0]).toMatchObject({ account: OTHER_ADMIN, runs: evidence.runs, verified: { Apps: now() } })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it.each(["account", "registration", "reader"] as const)("invalidates only that connection after a %s change and return", async (field) => {
    const { health, state, tokens, readerToken, stored, changed } = setup()
    state.tenant!.storage = "azure"
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    const answers: Array<() => void> = []
    tokens.mockImplementationOnce(() => new Promise((resolve) => answers.push(() => resolve(fresh()))))
    tokens.mockImplementationOnce(() => new Promise((_resolve, reject) => answers.push(() => reject(new Error("refused")))))
    readerToken.mockImplementationOnce(() => new Promise((resolve) => answers.push(() => resolve(token(SCOPES)))))
    const running = health.check(TENANT, "again")
    const oldQueue = health.check(TENANT, "signIn")
    if (field === "account") state.account = OTHER_ADMIN
    else if (field === "registration") state.tenant!.clientId = "new-client"
    else state.reader.clientId = "new-reader"
    const newQueue = health.check(TENANT, "signIn")
    state.account = ADMIN
    state.tenant!.clientId = CLIENT
    state.reader.clientId = READER
    // Observe the return before the original answers arrive, permanently invalidating both queues.
    health.runStarted({ id: "returned" }, { tenantId: TENANT, clientId: CLIENT })
    changed.mockClear()
    for (const answer of answers) answer()
    await Promise.all([running, oldQueue, newQueue])
    const admin = stored()?.connections.find((record) => record.mode === "delegated")
    const reader = stored()?.connections.find((record) => record.mode === "app-only")
    if (field === "reader") {
      expect(admin).toMatchObject({ graph: { permissions: [...SCOPES].sort() }, storage: { permissions: [...SCOPES].sort() } })
      expect(reader).not.toHaveProperty("graph")
      expect(changed.mock.calls.map((call) => call[1])).toEqual(["admin", "storage", "admin", "storage"])
      expect(tokens).toHaveBeenCalledTimes(4)
    } else {
      expect(admin).toBeUndefined()
      expect(reader).toHaveProperty("graph")
      expect(changed.mock.calls.map((call) => call[1])).toEqual(["reader"])
      expect(tokens).toHaveBeenCalledTimes(2)
    }
    expect(readerToken).toHaveBeenCalledTimes(1)
  })
})

describe("the identity rule for every pending item", () => {
  // Each row applies to every pending kind below. True means written, false means dropped.
  const events = [
    { event: "another admin", admin: false, reader: true },
    { event: "admin changed and back", admin: false, reader: true },
    { event: "same admin after sign-out", admin: false, reader: false },
    { event: "registration changed", admin: false, reader: true },
    { event: "registration changed and back", admin: false, reader: true },
    { event: "certificate replaced", admin: true, reader: false },
    { event: "reader removed", admin: true, reader: false },
    { event: "reader removed and set up again", admin: true, reader: false },
    { event: "sign-out", admin: false, reader: false },
    { event: "tenant removal", admin: false, reader: false },
  ] as const
  const kinds = ["check success", "check failure", "queued follow-up", "change notice", "run verification", "run refusal"] as const
  const cells = events.flatMap((event) => (["admin", "reader"] as const).flatMap((connection) => kinds.map((kind) => ({ ...event, connection, kind, written: event[connection] }))))

  it.each(cells)("$connection $kind after $event: written=$written", async ({ connection, kind, event, written }) => {
    const base = setup()
    const { health, state, tokens, readerToken, backing, stored, changed, now, pass } = base
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    const mode = connection === "admin" ? "delegated" : "app-only"
    const request = () => ({ tenantId: TENANT, clientId: state.tenant!.clientId })
    const finish = (id: string, folder: string, refused = false, authMode: ConnectionMode = mode) => health.recordRun({ runId: id, tenantId: TENANT, authMode, trigger: authMode === "app-only" ? "scheduled" : "manual", startedAt: now(), endedAt: now(), status: "Success", coverage: "complete", types: refused ? [{ folder, service: "intune", outcome: "skipped", cause: "role", reason: "Refused", status: 403 }] : [{ folder, service: "intune", outcome: "saved", saved: 1 }] }, request())
    let currentRun = ""
    const change = () => {
      if (event === "another admin" || event === "admin changed and back") state.account = OTHER_ADMIN
      if (event.startsWith("registration changed")) state.tenant!.clientId = "new-client"
      if (event === "certificate replaced") state.reader = { ...state.reader!, credential: "certificate-2", facts: { ...READER_FACTS, verifiedAt: now() } }
      if (event.startsWith("reader removed")) state.reader = null
      if (event === "sign-out" || event === "same admin after sign-out") health.signedOut(TENANT)
      if (event === "tenant removal") health.forget(TENANT)
      health.connectionsChanged(TENANT)
      if (event === "admin changed and back") state.account = ADMIN
      if (event === "registration changed and back") state.tenant!.clientId = CLIENT
      if (event === "reader removed and set up again") state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
      health.connectionsChanged(TENANT)
      pass(1)
      // Record under the identity that is current after the event. No stale write may erase it.
      const currentMode = connection === "reader" && state.reader ? "app-only" : "delegated"
      currentRun = "current-identity-run"
      health.runStarted({ id: currentRun, authMode: currentMode }, request())
      finish(currentRun, "DeviceConfigurations", false, currentMode)
      changed.mockClear()
    }

    if (kind === "run verification" || kind === "run refusal") {
      health.runStarted({ id: "pending-run", authMode: mode }, request())
      change()
      finish("pending-run", "Apps", kind === "run refusal")
      expect(stored()!.connections.some((record) => record.runs.some((run: { runId: string }) => run.runId === "pending-run"))).toBe(written)
    } else {
      let resolve = () => undefined as void
      let reject = () => undefined as void
      if (connection === "admin") tokens.mockImplementationOnce(() => new Promise((yes, no) => { resolve = () => yes(fresh(WITHOUT_APPS)); reject = () => no(new SignInRequiredError(TENANT, CLIENT, "Refused")) }))
      else readerToken.mockImplementationOnce(() => new Promise((yes, no) => { resolve = () => yes(jwt({ roles: ["DeviceManagementApps.Read.All"] })); reject = () => no(new BackupReaderError("Refused", { cause: { errorNo: "700027" } })) }))
      const running = health.check(TENANT, "again")
      const queued = kind === "queued follow-up" ? health.check(TENANT, "again") : undefined
      const target = connection === "admin" ? tokens : readerToken
      if (kind === "change notice") {
        // Stop between the answer's write and its queued notice. The notice must recheck ownership.
        const write = backing.set.bind(backing)
        let intercepted = false
        vi.spyOn(backing, "set").mockImplementation((key, value) => {
          write(key, value)
          if (!intercepted && key === `connectionHealth.${TENANT}` && JSON.parse(value).connections.some((record: { mode: string; graph?: unknown }) => record.mode === mode && record.graph)) {
            intercepted = true
            change()
          }
        })
        resolve()
        await running
        expect(intercepted).toBe(true)
        expect(changed.mock.calls.some((call) => call[1] === connection)).toBe(written)
      } else {
        change()
        if (kind === "check failure") reject()
        else resolve()
        await running
        await queued
        const record = stored()!.connections.find((record) => record.mode === mode && record.clientId === (mode === "delegated" ? CLIENT : READER))
        if (kind === "queued follow-up") expect(target).toHaveBeenCalledTimes(written ? 2 : 1)
        expect(!!record?.graph).toBe(written)
        if (written && kind === "check failure") expect(record!.graph.failure).toBeDefined()
      }
    }
    const kept = stored()!.connections.find((record) => record.runs.some((run: { runId: string }) => run.runId === currentRun))
    expect(kept).toBeDefined()
    expect(kept!.verified.DeviceConfigurations).toBeDefined()
    if (event === "certificate replaced") expect(health.report(TENANT).reader.state).toBe("healthy")
  })
})

describe("the storage connection's identity", () => {
  it.each([false, true])("drops a storage answer when its account changes, including a change back: %s", async (back) => {
    const { health, state, tokens, stored } = setup()
    state.tenant = { clientId: CLIENT, storage: "azure", storageId: "original-storage" }
    let answer = () => undefined as void
    tokens.mockImplementation(async (_tenant, _client, resource) => resource === "graph" ? fresh() : new Promise((resolve) => { answer = () => resolve(fresh(["storage-permission"])) }))
    const waiting = health.check(TENANT, "again")
    state.tenant.storageId = "other-storage"
    health.connectionsChanged(TENANT)
    if (back) {
      state.tenant.storageId = "original-storage"
      health.connectionsChanged(TENANT)
    }
    answer()
    const report = await waiting
    expect(report.graph.state).toBe("healthy")
    expect(report.storage.state).toBe("notChecked")
    expect(stored()!.connections[0]!.graph.permissions).toEqual([...SCOPES].sort())
    expect(stored()!.connections[0]).not.toHaveProperty("storage")
  })
})

describe("the Backup Reader in a check", () => {
  it("is asked for a token only when the admin checks again or a scheduled backup runs with it", async () => {
    const { health, state, readerToken, pass } = setup()
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    for (const trigger of ["launch", "signIn", "opened", "beforeBackup", "afterBackup"] as const) {
      await health.check(TENANT, trigger)
      pass(2 * MINUTE)
    }
    expect(readerToken).not.toHaveBeenCalled()
    await health.check(TENANT, "beforeBackup", { reader: true })
    expect(readerToken).toHaveBeenCalledTimes(1)
    pass(2 * MINUTE)
    const report = await health.check(TENANT, "again")
    expect(readerToken).toHaveBeenCalledTimes(2)
    expect(report.reader).toMatchObject({ state: "healthy", checkedAt: new Date(START.getTime() + 12 * MINUTE).toISOString(), daysLeft: 200 })
  })

  it("answers for a check that would not have asked it, within the minute", async () => {
    const { health, state, tokens, readerToken } = setup()
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    await health.check(TENANT, "beforeBackup", { reader: true })
    await health.check(TENANT, "opened")
    expect(tokens).toHaveBeenCalledTimes(1)
    // A check that did not ask the reader does not answer for one that does.
    await health.check("99999999-9999-9999-9999-999999999999", "opened")
    await health.check("99999999-9999-9999-9999-999999999999", "beforeBackup", { reader: true })
    expect(readerToken).toHaveBeenCalledTimes(2)
  })

  it("is never asked before its first verification, and its facts show without any token request", async () => {
    const { health, state, readerToken } = setup()
    state.reader = { clientId: "", credential: "certificate-1", facts: { ...READER_FACTS, state: "pending", verifiedAt: null, verifiedRoles: null } }
    expect(health.report(TENANT).reader.state).toBe("pending")
    expect((await health.check(TENANT, "again")).reader.state).toBe("pending")
    expect(readerToken).not.toHaveBeenCalled()
  })

  it("shows a renewed or removed reader in the report without a check", async () => {
    const { health, state } = setup()
    state.reader = { clientId: READER, credential: "certificate-1", facts: { ...READER_FACTS, notAfter: new Date(START.getTime() + 5 * DAY).toISOString() } }
    expect(health.report(TENANT).reader).toMatchObject({ state: "certificateExpiring", daysLeft: 5 })
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    expect(health.report(TENANT).reader.state).toBe("healthy")
    state.reader = null
    expect(health.report(TENANT).reader).toEqual({ state: "notSetUp", checkedAt: null })
  })

  it("records Microsoft's refusal of the reader, and nothing when the reader may not be used", async () => {
    const { health, state, readerToken, stored, pass } = setup()
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    readerToken.mockRejectedValueOnce(new BackupReaderError("Microsoft refused the Backup Reader (AADSTS7000112). The Backup Reader app registration is disabled.", { cause: Object.assign(new Error("disabled"), { errorCode: "unauthorized_client", errorNo: "7000112" }) }))
    const refused = await health.check(TENANT, "again")
    expect(refused.reader).toMatchObject({ state: "refused", class: "application", code: "AADSTS7000112", checkedAt: START.toISOString() })
    expect(refused.graph.state).toBe("healthy")
    expect(stored()!.connections.find((record) => record.mode === "app-only")).toMatchObject({ clientId: READER, graph: { failure: { class: "application", code: "AADSTS7000112" } }, reader: { state: "verified" } })
    // No plan or license for the reader: it is not asked, and the last answer stands.
    pass(MINUTE)
    readerToken.mockResolvedValueOnce(null)
    expect((await health.check(TENANT, "again")).reader).toMatchObject({ state: "refused", checkedAt: START.toISOString() })
  })
})

describe("the Backup Reader after a refusal", () => {
  it("is healthy again once the admin verified it, without another check asking for its token", async () => {
    const { health, state, readerToken, pass, now } = setup()
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    // 11:50: Microsoft does not know the certificate.
    readerToken.mockRejectedValueOnce(new BackupReaderError("Microsoft refused the Backup Reader (AADSTS700027).", { cause: Object.assign(new Error("invalid_client"), { errorCode: "invalid_client", errorNo: "700027" }) }))
    expect((await health.check(TENANT, "again")).reader).toMatchObject({ state: "refused", code: "AADSTS700027", checkedAt: START.toISOString() })
    // 11:59: the admin uploaded the right certificate and verified, which asked Microsoft for a new token and got one.
    pass(9 * MINUTE)
    const verifiedAt = now()
    state.reader = { clientId: READER, credential: "certificate-1", facts: { ...READER_FACTS, verifiedAt } }
    // 12:00: a page opens. An ordinary check asks the reader for no token, and the verification stands for the refusal before it.
    pass(MINUTE)
    expect((await health.check(TENANT, "opened")).reader).toMatchObject({ state: "healthy", checkedAt: verifiedAt })
    expect(health.report(TENANT).reader.state).toBe("healthy")
    expect(readerToken).toHaveBeenCalledTimes(1)
  })
})

describe("backup runs", () => {
  const outcomes = (runId: string, endedAt: string, types: Array<Record<string, unknown>>, authMode: "delegated" | "app-only" = "delegated") =>
    ({ runId, tenantId: TENANT, authMode, trigger: "manual" as const, startedAt: endedAt, endedAt, status: "Success", coverage: "complete" as const, types: types as never })
  const saved = (folder: string) => ({ folder, service: "intune", outcome: "saved", saved: 1 })
  const REQUEST = { tenantId: TENANT, clientId: CLIENT }
  /** A run from its start to its end, as the engine hands it over: it got its job, how it ended, and its job ended. */
  const ran = (health: ConnectionHealth, run: ReturnType<typeof outcomes>, permissions?: string[]) => {
    health.runStarted({ id: run.runId, authMode: run.authMode }, REQUEST)
    if (permissions) health.runToken(run.runId, { kind: run.authMode === "delegated" ? "delegated" : "application", permissions: new Set(permissions) })
    health.recordRun(run, REQUEST)
    health.runEnded(run.runId)
  }
  const denied = (folder: string, cause: "permission" | "role" = "permission") => ({ folder, service: "intune", outcome: "skipped", cause, reason: "Access was denied.", status: 403 })

  it("are kept under the connection and the account that ran them", () => {
    const { health, state, stored, now, changed } = setup()
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    ran(health, outcomes("desktop-1", now(), [saved("Apps")]))
    ran(health, outcomes("desktop-2", now(), [saved("Apps")], "app-only"))
    const records = stored()!.connections
    expect(records.find((record) => record.mode === "delegated")).toMatchObject({ clientId: CLIENT, account: ADMIN, runs: [{ runId: "desktop-1", account: ADMIN, read: ["Apps"] }] })
    const reader = records.find((record) => record.mode === "app-only")!
    expect(reader).toMatchObject({ clientId: READER, runs: [{ runId: "desktop-2", read: ["Apps"] }] })
    expect(reader.runs[0]).not.toHaveProperty("account")
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it("of a Backup Reader that is no longer set up are not kept", () => {
    const { health, stored, now } = setup()
    ran(health, outcomes("desktop-1", now(), [saved("Apps")], "app-only"))
    expect(stored()).toBeNull()
  })

  it("are credited to the admin who was signed in when they started, never to whoever is signed in when they end", async () => {
    const { health, state, stored, now, pass, changed } = setup()
    const apps = () => health.report(TENANT).services[0]!.areas.find((area) => area.id === "apps")!
    await health.check(TENANT, "launch")
    pass(DAY)
    health.runStarted({ id: "desktop-1", authMode: "delegated" }, REQUEST)
    // The run read the apps as the first admin. Another admin signs in while it still writes the backup.
    state.account = OTHER_ADMIN
    changed.mockClear()
    health.recordRun(outcomes("desktop-1", now(), [saved("Apps")]), REQUEST)
    health.runEnded("desktop-1")
    // Nothing of it is kept: it is not the new admin's run, and the admin whose run it was is no longer signed in.
    expect(JSON.stringify(stored())).not.toContain("desktop-1")
    expect(stored()!.connections[0]).toMatchObject({ account: ADMIN, runs: [], verified: {} })
    expect(changed).not.toHaveBeenCalled()
    await health.check(TENANT, "signIn")
    expect(stored()!.connections[0]).toMatchObject({ account: OTHER_ADMIN, runs: [], verified: {} })
    expect(apps().verified).toEqual({ state: "noBackup", notVerified: [] })
    // A run the new admin starts and ends is theirs.
    pass(DAY)
    ran(health, outcomes("desktop-2", now(), [saved("Apps")]))
    expect(stored()!.connections[0]).toMatchObject({ account: OTHER_ADMIN, runs: [{ runId: "desktop-2", account: OTHER_ADMIN }] })
    expect(apps().verified.state).toBe("verified")
  })

  it("count for nobody once their sign-in changed while they ran, also when it is back before they end", async () => {
    const { health, state, stored, now } = setup()
    await health.check(TENANT, "launch")
    health.runStarted({ id: "desktop-1", authMode: "delegated" }, REQUEST)
    // Another admin signs in, then the first one again: some of the run may have read as either.
    state.account = OTHER_ADMIN
    await health.check(TENANT, "signIn")
    state.account = ADMIN
    await health.check(TENANT, "signIn")
    health.recordRun(outcomes("desktop-1", now(), [saved("Apps"), denied("ScopeTags")]), REQUEST)
    expect(JSON.stringify(stored())).not.toContain("desktop-1")
    expect(stored()!.connections[0]).toMatchObject({ account: ADMIN, runs: [], verified: {}, refused: {} })
  })

  it.each([false, true])("drops an admin run after its registration changes, also if it returns: %s", async (returns) => {
    const { health, state, stored, now } = setup()
    await health.check(TENANT, "launch")
    health.runStarted({ id: "old-registration", authMode: "delegated" }, REQUEST)
    state.tenant!.clientId = "66666666-6666-6666-6666-666666666666"
    if (returns) {
      await health.check(TENANT, "signIn")
      state.tenant!.clientId = CLIENT
      await health.check(TENANT, "signIn")
    }
    health.recordRun(outcomes("old-registration", now(), [saved("Apps"), denied("ScopeTags")]), REQUEST)
    expect(JSON.stringify(stored())).not.toContain("old-registration")
    expect(stored()!.connections[0]).toMatchObject({ runs: [], verified: {}, refused: {} })
  })

  it("of the Backup Reader are credited to the reader they started with", () => {
    const OTHER_READER = "77777777-7777-7777-7777-777777777777"
    const { health, state, stored, now } = setup()
    state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
    // The reader is looked up as the run starts, not when it ends.
    health.runStarted({ id: "desktop-1", authMode: "app-only" }, REQUEST)
    state.account = OTHER_ADMIN
    health.recordRun(outcomes("desktop-1", now(), [saved("Apps")], "app-only"), REQUEST)
    expect(stored()!.connections).toMatchObject([{ clientId: READER, mode: "app-only", runs: [{ runId: "desktop-1" }] }])
    // A reader that was replaced, or removed, while the run went on: the run is neither one's.
    for (const [index, replaced] of [{ clientId: OTHER_READER, credential: "certificate-1", facts: READER_FACTS }, null].entries()) {
      state.reader = { clientId: READER, credential: "certificate-1", facts: READER_FACTS }
      health.runStarted({ id: `desktop-${index + 2}`, authMode: "app-only" }, REQUEST)
      state.reader = replaced
      health.recordRun(outcomes(`desktop-${index + 2}`, now(), [saved("Apps")], "app-only"), REQUEST)
    }
    expect(stored()!.connections).toHaveLength(1)
    expect(stored()!.connections[0]!.runs.map((run: { runId: string }) => run.runId)).toEqual(["desktop-1"])
  })

  it("that end after their tenant was signed out of or removed are not kept", async () => {
    const { health, backing, stored, now } = setup()
    await health.check(TENANT, "launch")
    health.runStarted({ id: "desktop-1", authMode: "delegated" }, REQUEST)
    health.forget(TENANT)
    health.recordRun(outcomes("desktop-1", now(), [saved("Apps")]), REQUEST)
    expect(backing.get(`connectionHealth.${TENANT}`)).toBeNull()
    // The same admin signs in again before a run that started before the sign-out ends: that sign-in is another one.
    await health.check(TENANT, "signIn")
    health.runStarted({ id: "desktop-2", authMode: "delegated" }, REQUEST)
    health.signedOut(TENANT)
    await health.check(TENANT, "signIn")
    health.recordRun(outcomes("desktop-2", now(), [saved("Apps")]), REQUEST)
    expect(JSON.stringify(stored())).not.toContain("desktop-2")
  })

  it("whose start was never noted, or whose job has ended, are not kept", () => {
    const { health, stored, now } = setup()
    health.recordRun(outcomes("desktop-1", now(), [saved("Apps")]), REQUEST)
    health.runStarted({ id: "desktop-2", authMode: "delegated" }, REQUEST)
    health.runEnded("desktop-2")
    health.recordRun(outcomes("desktop-2", now(), [saved("Apps")]), REQUEST)
    // A run that says it read as the Backup Reader although it started with the admin's sign-in is not kept either.
    health.runStarted({ id: "desktop-3", authMode: "delegated" }, REQUEST)
    health.recordRun(outcomes("desktop-3", now(), [saved("Apps")], "app-only"), REQUEST)
    expect(stored()).toBeNull()
  })

  it("show what the last backup verified, and lost access after two runs that were refused", async () => {
    const { health, pass, now } = setup()
    await health.check(TENANT, "launch")
    pass(DAY)
    ran(health, outcomes("desktop-1", now(), [saved("Apps"), saved("DeviceConfigurations")]))
    expect(health.report(TENANT).services[0]!.areas.find((area) => area.id === "apps")!.verified).toEqual({ state: "verified", at: now(), mode: "delegated", notVerified: [] })
    pass(DAY)
    const firstRefusal = now()
    ran(health, outcomes("desktop-2", now(), [denied("Apps", "role"), saved("DeviceConfigurations")]))
    expect(health.report(TENANT).changes).toEqual([])
    // The same run handed over again is still one run.
    ran(health, outcomes("desktop-2", now(), [denied("Apps", "role"), saved("DeviceConfigurations")]))
    expect(health.report(TENANT).changes).toEqual([])
    pass(DAY)
    ran(health, outcomes("desktop-3", now(), [denied("Apps", "role"), saved("DeviceConfigurations")]))
    const report = health.report(TENANT)
    // The cause is the one the runs found with the token they had: it carried the permission, so they named the account's role.
    expect(report.changes).toEqual([{ kind: "lostAccess", service: "intune", area: "apps", cause: "role", mode: "delegated", folders: ["Apps"], since: firstRefusal }])
    expect(report.services[0]!.areas.find((area) => area.id === "configuration")).toMatchObject({ lostAccess: false, verified: { state: "verified" } })
  })

  it("keep a loss when the backups after it select other types, until a backup reads the type again", async () => {
    const { health, pass, now, stored } = setup()
    await health.check(TENANT, "launch")
    const apps = () => health.report(TENANT).services[0]!.areas.find((area) => area.id === "apps")!
    pass(DAY)
    ran(health, outcomes("desktop-1", now(), [saved("Apps"), saved("DeviceConfigurations")]))
    pass(DAY)
    const since = now()
    ran(health, outcomes("desktop-2", now(), [denied("Apps"), saved("DeviceConfigurations")]))
    pass(DAY)
    ran(health, outcomes("desktop-3", now(), [denied("Apps"), saved("DeviceConfigurations")]))
    expect(apps().lostAccess).toBe(true)
    // Backups whose scope leaves the apps out push the runs that were refused out of the list of the last runs:
    // after four of them one refusal is left there, after six none. The loss does not go by that list.
    for (let index = 4; index <= 9; index++) {
      pass(DAY)
      ran(health, outcomes(`desktop-${index}`, now(), [saved("DeviceConfigurations")]))
      expect(apps()).toMatchObject({ lostAccess: true, verified: { state: "notVerified", notVerified: ["Apps"] } })
      if (index === 7) expect(stored()!.connections[0]!.runs.flatMap((run: { refused: unknown[] }) => run.refused)).toHaveLength(1)
    }
    expect(stored()!.connections[0]!.runs.flatMap((run: { refused: unknown[] }) => run.refused)).toEqual([])
    expect(health.report(TENANT).changes).toMatchObject([{ kind: "lostAccess", service: "intune", area: "apps", folders: ["Apps"], since }])
    // One more refusal is the same loss, since the same day.
    pass(DAY)
    ran(health, outcomes("desktop-10", now(), [denied("Apps")]))
    expect(health.report(TENANT).changes).toMatchObject([{ kind: "lostAccess", area: "apps", since }])
    // Looking at the changes ends the notice, not the state.
    expect(health.acknowledge(TENANT).changes).toEqual([])
    expect(apps().lostAccess).toBe(true)
    // It ends with the backup that reads the apps again.
    pass(DAY)
    ran(health, outcomes("desktop-11", now(), [saved("Apps")]))
    expect(apps()).toMatchObject({ lostAccess: false, verified: { state: "verified", at: now() } })
    expect(health.report(TENANT).changes).toEqual([])
  })

  it("keep the cause they found, and say not verified yet once the permission a run lacked is there", async () => {
    const { health, tokens, pass, now } = setup()
    const apps = () => health.report(TENANT).services[0]!.areas.find((area) => area.id === "apps")!
    tokens.mockResolvedValueOnce(fresh(WITHOUT_APPS))
    await health.check(TENANT, "launch")
    pass(DAY)
    const refusedAt = now()
    ran(health, outcomes("desktop-1", now(), [denied("Apps"), saved("DeviceConfigurations")]), WITHOUT_APPS)
    expect(apps()).toMatchObject({ permissions: "missing", verified: { state: "notVerified", cause: "permission" } })
    // The permission is added to the app registration, and a check sees it. No backup ran since.
    pass(DAY)
    await health.check(TENANT, "again")
    expect(apps()).toMatchObject({ permissions: "present", verified: { state: "notVerified", at: refusedAt, cause: "notVerifiedYet", mode: "delegated", notVerified: ["Apps"] } })
    // The next backup reads the type.
    pass(DAY)
    ran(health, outcomes("desktop-2", now(), [saved("Apps"), saved("DeviceConfigurations")]))
    expect(apps().verified).toEqual({ state: "verified", at: now(), mode: "delegated", notVerified: [] })
  })

  it("keeps permission evidence from the run's own tokens and treats conflicting tokens as unknown", async () => {
    const { health, now, stored } = setup()
    await health.check(TENANT, "launch")
    health.runToken("not-started", { kind: "delegated", permissions: new Set() })
    health.runStarted({ id: "mixed", authMode: "delegated" }, REQUEST)
    for (const scopes of [WITHOUT_APPS, SCOPES, WITHOUT_APPS]) health.runToken("mixed", { kind: "delegated", permissions: new Set(scopes) })
    health.recordRun(outcomes("mixed", now(), [denied("Apps")]), REQUEST)
    expect(stored()!.connections[0]!.runs[0].refused[0]).not.toHaveProperty("permissionHeld")
    expect(health.report(TENANT).services[0]!.areas.find((area) => area.id === "apps")!.verified.cause).toBe("refusedWithPermission")
  })

  it("of another admin count for nothing once someone else signed in", async () => {
    const { health, state, pass, now } = setup()
    await health.check(TENANT, "launch")
    ran(health, outcomes("desktop-1", now(), [saved("Apps")]))
    pass(DAY)
    state.account = OTHER_ADMIN
    ran(health, outcomes("desktop-2", now(), [denied("Apps")]))
    pass(DAY)
    ran(health, outcomes("desktop-3", now(), [denied("Apps")]))
    const report = health.report(TENANT)
    expect(report.changes).toEqual([])
    expect(report.services[0]!.areas.find((area) => area.id === "apps")).toMatchObject({ lostAccess: false, verified: { state: "notVerified", cause: "permission" } })
  })
})

describe("changes", () => {
  it("are none after the first check, and name what changed after a later one", async () => {
    const { health, tokens, pass } = setup()
    tokens.mockResolvedValueOnce(fresh(WITHOUT_APPS))
    const first = await health.check(TENANT, "launch")
    expect(first.changes).toEqual([])
    expect(first.since).toBe(START.toISOString())
    pass(DAY)
    const second = await health.check(TENANT, "launch")
    expect(second.changes).toEqual([{ kind: "permissionsAdded", permissions: ["DeviceManagementApps.ReadWrite.All"] }, { kind: "becameReady", service: "intune" }])
    expect(second.since).toBe(START.toISOString())
    // They stay until they were looked at, however often the tenant is checked.
    pass(DAY)
    expect((await health.check(TENANT, "launch")).changes).toHaveLength(2)
    expect(health.acknowledge(TENANT).changes).toEqual([])
    expect(health.report(TENANT)).toMatchObject({ changes: [], since: new Date(START.getTime() + 2 * DAY).toISOString() })
  })

  it("report nothing when another admin signs in with other permissions", async () => {
    const { health, state, tokens, pass } = setup()
    await health.check(TENANT, "launch")
    pass(DAY)
    state.account = OTHER_ADMIN
    tokens.mockResolvedValueOnce(fresh(WITHOUT_APPS))
    const report = await health.check(TENANT, "signIn")
    expect(report.changes).toEqual([])
    expect(report.granted).toEqual([...WITHOUT_APPS].sort())
  })

  it("keep a change nobody looked at when another admin signs in, and take none from their token", async () => {
    const { health, state, tokens, pass } = setup()
    const WITHOUT_RBAC = SCOPES.filter((permission) => !permission.startsWith("DeviceManagementRBAC"))
    tokens.mockResolvedValueOnce(fresh(WITHOUT_APPS))
    await health.check(TENANT, "launch")
    pass(DAY)
    const unseen = (await health.check(TENANT, "launch")).changes
    expect(unseen).toEqual([{ kind: "permissionsAdded", permissions: ["DeviceManagementApps.ReadWrite.All"] }, { kind: "becameReady", service: "intune" }])
    const carried = unseen.map((change) => ({ ...change, earlierSignIn: true, foundAt: new Date(START.getTime() + DAY).toISOString() }))
    // Another check must keep when these notices were first found.
    pass(MINUTE)
    await health.check(TENANT, "again")
    // Nobody looked at them before another admin signed in, whose own consent differs.
    pass(DAY)
    state.account = OTHER_ADMIN
    tokens.mockResolvedValue(fresh(WITHOUT_RBAC))
    const report = await health.check(TENANT, "signIn")
    expect(report.changes).toEqual(carried)
    expect(report.services[0]!.permissions).toBe("missing")
    expect(JSON.stringify(report.changes)).not.toMatch(/aaaaaaaa|bbbbbbbb/)
    expect(report.since).toBe(START.toISOString())
    expect(report.granted).toEqual([...WITHOUT_RBAC].sort())
    pass(DAY)
    expect((await health.check(TENANT, "launch")).changes).toEqual(carried)
    expect(health.acknowledge(TENANT).changes).toEqual([])
    expect((await health.check(TENANT, "again")).changes).toEqual([])
  })

  it("keep a change nobody looked at when the admin signed out before another one signed in", async () => {
    const { health, state, tokens, pass } = setup()
    tokens.mockResolvedValueOnce(fresh(WITHOUT_APPS))
    await health.check(TENANT, "launch")
    pass(DAY)
    const unseen = (await health.check(TENANT, "launch")).changes
    expect(unseen).toHaveLength(2)
    health.signedOut(TENANT)
    pass(DAY)
    state.account = OTHER_ADMIN
    expect((await health.check(TENANT, "signIn")).changes).toEqual(unseen.map((change) => ({ ...change, earlierSignIn: true, foundAt: new Date(START.getTime() + DAY).toISOString() })))
    expect(health.acknowledge(TENANT).changes).toEqual([])
  })

  it("name a registration that replaced another, with what it lacks, until they were looked at", async () => {
    const { health, state, tokens, pass, stored } = setup()
    await health.check(TENANT, "launch")
    pass(DAY)
    const NEW_CLIENT = "66666666-6666-6666-6666-666666666666"
    state.tenant = { clientId: NEW_CLIENT, storage: "local" }
    tokens.mockResolvedValue(fresh(WITHOUT_APPS))
    const report = await health.check(TENANT, "signIn")
    expect(report.clientId).toBe(NEW_CLIENT)
    expect(report.changes).toEqual([{ kind: "registrationReplaced", previousClientId: CLIENT, lacks: ["DeviceManagementApps.ReadWrite.All"] }])
    // The earlier registration's record is gone; the snapshot carries what it had.
    expect(stored()!.connections.map((record) => record.clientId)).toEqual([NEW_CLIENT])
    pass(DAY)
    expect((await health.check(TENANT, "launch")).changes).toHaveLength(1)
    expect(health.acknowledge(TENANT).changes).toEqual([])
  })

  it("name a registration that replaced another after the admin signed out in between", async () => {
    const { health, state, tokens, pass } = setup()
    await health.check(TENANT, "launch")
    health.signedOut(TENANT)
    pass(DAY)
    state.tenant = { clientId: "66666666-6666-6666-6666-666666666666", storage: "local" }
    tokens.mockResolvedValueOnce(fresh(WITHOUT_APPS))
    expect((await health.check(TENANT, "signIn")).changes).toEqual([{ kind: "registrationReplaced", previousClientId: CLIENT, lacks: ["DeviceManagementApps.ReadWrite.All"] }])
  })

  it("start over for a tenant that was removed and connected again", async () => {
    const { health, state, tokens, backing } = setup()
    await health.check(TENANT, "launch")
    health.forget(TENANT)
    expect(backing.get(`connectionHealth.${TENANT}`)).toBeNull()
    state.tenant = { clientId: "66666666-6666-6666-6666-666666666666", storage: "local" }
    tokens.mockResolvedValueOnce(fresh(WITHOUT_APPS))
    // Forgetting also forgets when the tenant was last checked, so this check asks Microsoft.
    expect((await health.check(TENANT, "launch")).changes).toEqual([])
    expect(tokens).toHaveBeenCalledTimes(2)
  })
})

describe("the tenant that is checked at launch", () => {
  const tenants = JSON.stringify([{ id: 1, name: "Contoso", credentials: { tenantId: TENANT } }, { id: 2, name: "Fabrikam", credentials: { tenantId: "22222222-2222-2222-2222-222222222222" } }])

  it("is the one the admin has open", () => {
    expect(selectedTenant(tenants, "2")).toBe("22222222-2222-2222-2222-222222222222")
    expect(selectedTenant(tenants, "1")).toBe(TENANT)
  })

  it.each([[tenants, null], [tenants, "7"], [null, "1"], ["{", "1"], ["{}", "1"], [JSON.stringify([{ id: 1 }, null, "x"]), "1"]])("is none for %j with %j selected", (list, selected) => {
    expect(selectedTenant(list, selected)).toBeNull()
  })
})

// The engine with the same three hooks the main process wires: the run's sign-in and a check as a
// backup starts, the outcomes when it ended, and a check after it.
describe("with the backup engine", () => {
  function wired(routes: () => Record<string, unknown>) {
    const base = setup()
    const { health } = base
    const checks: Array<Promise<unknown>> = []
    const backups = fixture(scriptedGraph(new Proxy({}, { get: (_target, path: string) => routes()[path], has: (_target, path: string) => path in routes() })), {
      now: () => new Date(base.now()),
      getToken: async () => jwt({ scp: SCOPES.join(" ") }),
      services: () => ({ services: ["intune"] }),
      onStarted: (job, request) => {
        health.runStarted(job, request)
        checks.push(health.check(request.tenantId, "beforeBackup", { reader: job.authMode === "app-only" }).catch(() => undefined))
      },
      onOutcomes: (outcomes, request) => health.recordRun(outcomes, request),
      onToken: (runId, granted) => health.runToken(runId, granted),
      onFinished: (job, request) => {
        health.runEnded(job.id)
        checks.push(health.check(request.tenantId, "afterBackup", { reader: job.authMode === "app-only", failed: job.status === "Failed" }).catch(() => undefined))
      },
    })
    return { ...base, backups, settled: () => Promise.all(checks) }
  }

  it("checks the connection as a backup starts and keeps how the run ended", async () => {
    const { health, backups, tokens, settled, stored } = wired(() => ({}))
    const job = await backups.run()
    await settled()
    expect(job.status).toBe("Completed")
    // One token request: the check after a backup that worked, within the minute, needs none.
    expect(tokens).toHaveBeenCalledTimes(1)
    const [record] = stored()!.connections
    expect(record).toMatchObject({ account: ADMIN, runs: [{ runId: job.id, trigger: "manual" }] })
    expect(record!.runs[0].read).toContain("DeviceConfigurations")
    const report = health.report(TENANT)
    expect(report.graph.state).toBe("healthy")
    expect(report.services[0]).toMatchObject({ id: "intune", verified: { state: "verified" } })
  })

  it("credits a real run to the admin it started with: one who signs in while it runs gets no verification from it", async () => {
    let signIn = () => undefined as void
    // Another admin signs in while the run reads the tenant.
    const base = wired(() => ({ "/beta/deviceAppManagement/mobileAppCategories": () => { signIn(); return Response.json({ value: [] }) } }))
    signIn = () => { base.state.account = OTHER_ADMIN }
    await base.health.check(TENANT, "launch")
    base.pass(DAY)
    const job = await base.backups.run()
    await base.settled()
    expect(job.status).toBe("Completed")
    expect(base.state.account).toBe(OTHER_ADMIN)
    expect(JSON.stringify(base.stored())).not.toContain(job.id)
    expect(base.health.report(TENANT).services[0]).toMatchObject({ id: "intune", verified: { state: "noBackup" } })
    // The next run is the new admin's from start to end.
    signIn = () => undefined
    const next = await base.backups.run()
    await base.settled()
    expect(base.stored()!.connections[0]).toMatchObject({ account: OTHER_ADMIN, runs: [{ runId: next.id, account: OTHER_ADMIN }] })
  })

  it("never keeps a backup from running, whatever the check finds", async () => {
    const base = wired(() => ({}))
    base.tokens.mockRejectedValue(new SignInRequiredError(TENANT, CLIENT, "Sign in again to continue.", undefined, { errorNo: "53003", errorCode: "interaction_required" }))
    const job = await base.backups.run()
    await base.settled()
    expect(job.status).toBe("Completed")
    expect(base.health.report(TENANT).graph.state).toBe("blockedByConditionalAccess")
  })

  it("never lets a check that throws change how a backup ends", async () => {
    const base = wired(() => ({}))
    base.state.tenant = null
    const job = await base.backups.run()
    await base.settled()
    expect(job.status).toBe("Completed")
  })

  it("reports lost access from what three real runs were answered", async () => {
    let denied = false
    const base = wired(() => (denied ? { "/beta/deviceAppManagement/mobileAppCategories": refusal(403, "Forbidden", "Access is denied for admin@contoso.com.") } : {}))
    const { health, backups, pass, settled } = base
    await health.check(TENANT, "launch")
    pass(DAY)
    await backups.run()
    pass(DAY)
    denied = true
    await backups.run()
    await settled()
    expect(health.report(TENANT).changes).toEqual([])
    pass(DAY)
    await backups.run()
    await settled()
    const report = health.report(TENANT)
    // A denied Intune read does not say whether the permission or the account's role was missing, and the runs
    // recorded no role. Their own token held the permission, so nothing says the cause is gone.
    expect(report.changes).toMatchObject([{ kind: "lostAccess", service: "intune", area: "apps", cause: "refusedWithPermission", mode: "delegated", folders: ["AppCategories"] }])
    expect(base.stored()!.connections[0]!.refused.AppCategories).toEqual(expect.arrayContaining([expect.objectContaining({ permissionHeld: true })]))
    expect(JSON.stringify(base.stored())).not.toContain("contoso")
  })
})
