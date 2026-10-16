import { describe, expect, it } from "vitest"
import { isFullValidation, type ValidationRun, type PolicyValidation } from "../src/shared/oib/types"
import { compareSettings } from "../src/shared/oib/compare"
import { routes, signals } from "../src/main/features/scores"
import { oibFrameworkDetail, oibFrameworkScore, oibVersion } from "../src/main/features/scores/oib"
import { keepValidations } from "../src/main/oib/service"
import { call, fakeDeps, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"
import { fakeFrameworksApi } from "./feature-scores-fixtures"

const NOW = new Date("2026-09-30T12:00:00Z")
const COMMIT = "a".repeat(40)
const policy = (overrides: Partial<PolicyValidation> = {}): PolicyValidation => ({
  source: "WINDOWS/Policy.json", name: "OIB Policy", folder: "SettingsCatalog", tenantPolicyId: "policy-1", tenantPolicyName: "Tenant policy", status: "drifted", expectedSettings: 4,
  result: { totalOib: 4, totalTenant: 4, matched: 2, different: 1, missing: 1, extra: 1, mismatches: [{ settingDefinitionId: "s3", label: "Setting 3", oibValue: "true", tenantValue: "false" }], oibOnly: [{ settingDefinitionId: "s4", label: "Setting 4", oibValue: "true" }], tenantOnly: [{ settingDefinitionId: "extra", label: "Extra", tenantValue: "true" }], compliant: false }, ...overrides,
})
const run = (overrides: Partial<ValidationRun> = {}): ValidationRun => ({ runId: "new", tenantId: TENANT_A, platform: "windows", commit: COMMIT, reference: "OIB Windows", validatedAt: "2026-09-29T00:00:00Z", validationVersion: 1, selection: "all", results: [policy()], ...overrides })

describe("saved OIB score projections", () => {
  it("scores expected root settings and drills down without inventing control or assignment evidence", () => {
    const detail = oibFrameworkDetail(run(), NOW)
    expect(detail.score).toMatchObject({ counts: { matching: 2, different: 1, missing: 1, unknown: 0 }, score: 50, coverage: 100 })
    expect(detail.controls).toEqual([])
    expect(detail.gaps).toHaveLength(1)
    expect(detail.gaps[0]).toMatchObject({ controls: [], policies: [{ assignment: "unknown" }], settings: [{ result: "different", observed: "false" }, { result: "missing" }] })
    expect(detail.unassessedNote).toContain("Selected deployed policies only")
  })

  it("keeps failed expected settings unknown and withholds coverage when their size is unknown", () => {
    const failed = policy({ source: "other", status: "error", result: undefined, expectedSettings: 4 })
    expect(oibFrameworkDetail(run({ results: [policy(), failed] }), NOW).score).toMatchObject({ score: 50, coverage: 50, counts: { unknown: 4 } })
    const unsupported = policy({ source: "unsupported", status: "unsupported", result: undefined, expectedSettings: undefined })
    const detail = oibFrameworkDetail(run({ results: [policy(), unsupported] }), NOW)
    expect(detail.score).toMatchObject({ score: 50, coverage: null })
    expect(detail.incompleteCollection).toContain("OIB Policy: unsupported")
    expect(oibFrameworkDetail(run({ results: [failed] }), NOW).score).toMatchObject({ score: null, state: "not-scored" })
  })

  it("never treats missing legacy difference detail as matching", () => {
    const historic = policy()
    historic.result = { ...historic.result!, different: undefined, missing: undefined, mismatches: [], oibOnly: [] }
    expect(oibFrameworkDetail(run({ results: [historic], validationVersion: undefined }), NOW).score).toMatchObject({ score: 100, coverage: 50, counts: { matching: 2, unknown: 2 } })
    const inconsistent = policy({ result: { ...policy().result!, totalOib: 1 } })
    expect(oibFrameworkDetail(run({ results: [inconsistent] }), NOW).score.score).toBeNull()
  })

  it("separates trends by source commit, selected policies and validation version, independent of policy order", () => {
    const second = policy({ source: "second", tenantPolicyId: "policy-2" })
    const anchor = run({ results: [policy(), second] })
    const older = run({ runId: "old", validatedAt: "2026-09-28T00:00:00Z", results: [second, policy()] })
    const changed = [run({ runId: "commit", commit: "b".repeat(40) }), run({ runId: "selection" }), run({ runId: "version", results: anchor.results, validationVersion: undefined })].map((entry, index) => ({ ...entry, validatedAt: `2026-09-2${index + 1}T00:00:00Z` }))
    const score = oibFrameworkScore({ platform: "windows", runs: [older, anchor, ...changed], skipped: 0, error: null }, NOW)
    expect(score.trend.map((point) => point.runId)).toEqual(["old", "new"])
    expect(score.incompatible.map((point) => point.runId)).toEqual(["version", "selection", "commit"])
    expect(score.incompatible.find((entry) => entry.runId === "selection")?.reasons).toContain("Selected policies changed.")
  })

  it("counts each root once even when many leaf diffs or missing settings exceed the detail limit", () => {
    const setting = (id: string, value: number) => ({ settingInstance: { settingDefinitionId: id, simpleSettingValue: { value } } })
    const result = compareSettings(Array.from({ length: 650 }, (_, index) => setting(`s${index}`, 1)) as never, [])
    expect(result.oibOnly).toHaveLength(500)
    expect(result).toMatchObject({ totalOib: 650, matched: 0, different: 0, missing: 650 })
    expect(oibFrameworkDetail(run({ results: [policy({ result })] }), NOW).score).toMatchObject({ score: 0, counts: { missing: 650, unknown: 0 } })
    const nested = { settingInstance: { settingDefinitionId: "parent", child: { value1: 1, value2: 2 } } }
    const changed = { settingInstance: { settingDefinitionId: "parent", child: { value1: 3, value2: 4 } } }
    const multi = compareSettings([nested] as never, [changed] as never)
    expect(multi.mismatches).toHaveLength(2)
    expect(multi.different).toBe(1)
  })
})

describe("OIB full validations and release versions", () => {
  const compliant = (source: string, id: string) => policy({ source, tenantPolicyId: id, status: "compliant", result: { ...policy().result!, matched: 4, different: 0, missing: 0, mismatches: [], oibOnly: [] } })

  it("scores the card and trend from full validations only; a single-policy check stays in history", () => {
    const full = run({ runId: "full", validatedAt: "2026-09-20T00:00:00Z" })
    const single = run({ runId: "single", selection: "single", validatedAt: "2026-09-29T00:00:00Z", results: [compliant("WINDOWS/Policy.json", "policy-1")] })
    const score = oibFrameworkScore({ platform: "windows", runs: [single, full], skipped: 0, error: null }, NOW)
    expect(score.latest?.identity.runId).toBe("full")
    expect(score.latest?.score.score).toBe(50)
    expect(score.trend.map((point) => point.runId)).toEqual(["full"])
    expect(score.historyOnly).toEqual([{ runId: "single", assessedAt: "2026-09-29T00:00:00Z", reason: expect.stringContaining("Single-policy validation") }])
    const only = oibFrameworkScore({ platform: "windows", runs: [single], skipped: 0, error: null }, NOW)
    expect(only).toMatchObject({ state: "history-only", latest: null, trend: [] })
    expect(only.message).toMatch(/Validate all/)
  })

  it("treats a saved run without a recorded selection as single only when it holds one policy", () => {
    const legacySingle = run({ runId: "legacy-1", selection: undefined })
    const legacyFull = run({ runId: "legacy-2", selection: undefined, results: [policy(), policy({ source: "second", tenantPolicyId: "policy-2" })] })
    expect(isFullValidation(legacySingle)).toBe(false)
    expect(isFullValidation(legacyFull)).toBe(true)
    expect(isFullValidation(run({ selection: "all" }))).toBe(true)
  })

  it("uses the release tag as the version so validations of one release connect across commits", () => {
    const reference = (commit: string) => `OpenIntuneBaseline Windows v4.0 · windows-v4.0 @ ${commit.slice(0, 7)}`
    const first = run({ runId: "first", commit: "1cc71a9".padEnd(40, "0"), reference: reference("1cc71a9"), validatedAt: "2026-09-20T00:00:00Z" })
    const second = run({ runId: "second", commit: "2dd82b0".padEnd(40, "0"), reference: reference("2dd82b0") })
    const score = oibFrameworkScore({ platform: "windows", runs: [first, second], skipped: 0, error: null }, NOW)
    expect(score.latest?.identity.frameworkVersion).toBe("windows-v4.0")
    expect(score.latest?.versionDetail).toBe(`Commit ${"2dd82b0".padEnd(40, "0")}`)
    expect(score.trend.map((point) => point.runId)).toEqual(["first", "second"])
    expect(score.incompatible).toEqual([])
    expect(oibVersion({ reference: "OIB Windows", commit: COMMIT })).toBe(`main @ ${COMMIT.slice(0, 7)}`)
    expect(oibVersion({ reference: `OpenIntuneBaseline Windows · main @ ${COMMIT.slice(0, 7)}`, commit: COMMIT })).toBe(`main @ ${COMMIT.slice(0, 7)}`)
  })

  it("keeps a moving beta branch on separate trends per commit, with the reason", () => {
    const reference = (commit: string) => `OpenIntuneBaseline macOS v2.0 beta · macos-v2.0-beta @ ${commit.slice(0, 7)}`
    const first = run({ runId: "first", platform: "macos", commit: "1cc71a9".padEnd(40, "0"), reference: reference("1cc71a9"), validatedAt: "2026-09-20T00:00:00Z" })
    const moved = run({ runId: "moved", platform: "macos", commit: "2dd82b0".padEnd(40, "0"), reference: reference("2dd82b0"), results: [policy({ status: "drifted", result: { ...policy().result!, matched: 0, different: 4, missing: 0, mismatches: [], oibOnly: [] } })] })
    const score = oibFrameworkScore({ platform: "macos", runs: [first, moved], skipped: 0, error: null }, NOW)
    expect(score.latest?.identity.frameworkVersion).toBe("macos-v2.0-beta @ 2dd82b0")
    expect(score.trend.map((point) => point.runId)).toEqual(["moved"])
    expect(score.incompatible).toEqual([expect.objectContaining({ runId: "first", reasons: ["Framework version changed (macos-v2.0-beta @ 2dd82b0 and macos-v2.0-beta @ 1cc71a9)."] })])
    expect(oibVersion({ reference: "OpenIntuneBaseline Windows v4.0 · windows-v4.0 @ 1cc71a9", commit: COMMIT })).toBe("windows-v4.0")
  })

  it("never removes a full validation to keep a single-policy check", () => {
    const full = run({ runId: "full", selection: "all", validatedAt: "2026-09-01T00:00:00Z" })
    const singles = Array.from({ length: 49 }, (_, index) => run({ runId: `single-${index}`, selection: "single", validatedAt: `2026-09-${String(index % 28 + 2).padStart(2, "0")}T00:00:00Z` }))
    // Newest first, as saved: 49 single checks after one full validation, then one more single check.
    const kept = keepValidations([run({ runId: "newest", selection: "single" }), ...singles, full], 50)
    expect(kept).toHaveLength(50)
    expect(kept.some((entry) => entry.runId === "full")).toBe(true)
    expect(kept.some((entry) => entry.runId === "single-48")).toBe(false)
    const allFull = Array.from({ length: 50 }, (_, index) => run({ runId: `full-${index}`, selection: "all" }))
    expect(keepValidations([run({ runId: "check", selection: "single" }), ...allFull], 50).map((entry) => entry.runId)).toEqual(allFull.map((entry) => entry.runId))
    expect(keepValidations([run({ runId: "new-full", selection: "all" }), ...allFull], 50).at(-1)?.runId).toBe("full-48")
    const sized = keepValidations([run({ runId: "a", selection: "single" }), full], 50, JSON.stringify([full]).length)
    expect(sized.map((entry) => entry.runId)).toEqual(["full"])
  })

  it("skips only a malformed validation instead of hiding the platform", async () => {
    const source = api({ [TENANT_A]: [run(), run({ runId: "broken", results: [null as never] })] })
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: source.handler, now: () => NOW })
    const summary = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    const windows = summary.body.frameworks.find((entry: any) => entry.frameworkId === "oib-windows")
    expect(windows).toMatchObject({ state: "scored", latest: { score: { score: 50 } } })
    expect(windows.message).toContain("1 unreadable saved validation was left out.")
  })
})

function api(saved: Record<string, unknown[]>, denied: string[] = []) {
  const native = fakeFrameworksApi({})
  const calls: string[] = []
  return { calls, handler: async (path: string, tenant: string, body: Record<string, unknown> = {}) => {
    if (path !== "/api/oib") return native.api(path, tenant, body)
    calls.push(tenant)
    return denied.includes(tenant) ? Response.json({ error: "Denied" }, { status: 403 }) : Response.json({ runs: saved[tenant] ?? [] })
  } }
}

describe("score work signals", () => {
  it("reports only stale saved scores as unknown, never fresh or missing ones", async () => {
    const stale = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: api({ [TENANT_A]: [run({ validatedAt: "2026-07-01T00:00:00Z" })] }).handler, now: () => NOW })
    const found = await signals(stale, TENANT_A)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ key: "score-stale:oib-windows", source: "score", severity: "low", state: "unknown", observedAt: "2026-07-01T00:00:00Z" })
    const fresh = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: api({ [TENANT_A]: [run()] }).handler, now: () => NOW })
    expect(await signals(fresh, TENANT_A)).toEqual([])
    const missing = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: api({}).handler, now: () => NOW })
    expect(await signals(missing, TENANT_A)).toEqual([])
  })
})

describe("OIB scores API and portfolio", () => {
  it("returns saved platform scores on Pro, serves detail and blocks Community", async () => {
    const source = api({ [TENANT_A]: [run(), run({ runId: "mac", platform: "macos" })] })
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: source.handler, now: () => NOW })
    const summary = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    expect(summary.body.frameworks.find((entry: any) => entry.frameworkId === "oib-windows").latest.score.score).toBe(50)
    expect(summary.body.frameworks.find((entry: any) => entry.frameworkId === "oib-macos").latest.identity.platforms).toEqual(["macos"])
    expect((await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "oib-windows" })).body.detail.identity.runId).toBe("new")
    expect((await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "oib-windows", runId: "mac" })).status).toBe(404)
    const community = fakeDeps({ plans: { [TENANT_A]: "community" }, api: source.handler })
    expect((await call(routes(community), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "oib-windows" })).status).toBe(402)
  })

  it("discards foreign records and reports corrupt or denied history as unavailable", async () => {
    const source = api({ [TENANT_A]: [run({ tenantId: TENANT_B }), run({ runId: "broken", results: [null as never] })] })
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: source.handler })
    const summary = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    expect(summary.body.frameworks.find((entry: any) => entry.frameworkId === "oib-windows")).toMatchObject({ state: "unavailable", latest: null })
    expect((await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "oib-windows" })).status).toBe(502)
    const foreign = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: api({ [TENANT_A]: [run({ tenantId: TENANT_B })] }).handler })
    expect((await call(routes(foreign), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "oib-windows" })).status).toBe(404)
  })

  it("includes OIB in MSP portfolios only for named tenants, retaining unavailable and stale states", async () => {
    const source = api({ [TENANT_A]: [run()], [TENANT_B]: [run({ tenantId: TENANT_B, validatedAt: "2026-07-01T00:00:00Z" })] })
    const deps = fakeDeps({ plans: { [TENANT_A]: "msp", [TENANT_B]: "msp", [TENANT_C]: "msp" }, api: source.handler, now: () => NOW })
    const summary = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "portfolio-summary", targetTenants: [{ tenantId: TENANT_B }] })
    expect(source.calls).toEqual([TENANT_A, TENANT_B])
    expect(summary.body.tenants[1].frameworks.find((entry: any) => entry.frameworkId === "oib-windows")).toMatchObject({ score: 50, stale: true })
    const denied = fakeDeps({ plans: { [TENANT_A]: "msp" }, api: api({}, [TENANT_A]).handler })
    const result = await call(routes(denied), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    expect(result.body.frameworks.filter((entry: any) => entry.frameworkId.startsWith("oib-")).every((entry: any) => entry.state === "unavailable" && entry.latest === null)).toBe(true)
  })
})
