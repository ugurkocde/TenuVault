import { describe, expect, it } from "vitest"
import { comparisonCounts } from "../src/shared/compliance/native"
import { routes } from "../src/main/features/scores"
import { buildTrend, compatibility, identityOf, scoreFromCounts, scoreRun, freshness } from "../src/main/features/scores/formula"
import { call, fakeDeps, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"
import { fakeFrameworksApi, makeRun } from "./feature-scores-fixtures"

const NOW = new Date("2026-09-30T12:00:00Z")
const empty = { matching: 0, different: 0, missing: 0, unknown: 0, outsideScope: 0 }

describe("score formula", () => {
  it("scores matching over evaluated and reports unknown as coverage", () => {
    const score = scoreFromCounts({ matching: 6, different: 2, missing: 2, unknown: 10, outsideScope: 7 })
    expect(score.score).toBe(60)
    expect(score.coverage).toBe(50)
    expect(score.evaluated).toBe(10)
    expect(score.assessed).toBe(20)
    expect(score.state).toBe("scored")
  })

  it("never scores a run with no evaluable settings", () => {
    const allUnknown = scoreFromCounts({ ...empty, unknown: 12 })
    expect(allUnknown).toMatchObject({ score: null, coverage: 0, state: "not-scored" })
    const nothing = scoreFromCounts({ ...empty, outsideScope: 4 })
    expect(nothing).toMatchObject({ score: null, coverage: null, state: "not-scored" })
    const run = makeRun({ runId: "r", tenantId: TENANT_A, caps: { a: ["unknown", "unknown"], b: ["outside"] } })
    expect(scoreRun(run).score).toBeNull()
  })

  it("counts like the Frameworks page", () => {
    const run = makeRun({ runId: "r", tenantId: TENANT_A, caps: { a: ["matches", "different"], b: ["missing", "unknown"], c: ["outside"] } })
    const page = comparisonCounts(run)
    expect(scoreRun(run).counts).toEqual({ matching: page.matches, different: page.different, missing: page.missing, unknown: page.unableToCheck, outsideScope: page.outsideScope })
    // Each capability now contributes one vote, using its best assigned evidence.
    expect(scoreRun(run).score).toBe(50)
  })

  it("counts unavailable control rows as unknown or outside scope", () => {
    const run = makeRun({ runId: "r", tenantId: TENANT_A, caps: {} })
    run.assessment.frameworks[0]!.controls = ["unableToCheck", "outsideScope"].map((status, index) => ({
      control: { id: `unavailable-${index}`, title: "Unavailable control", summary: "", evidenceStrength: "direct" },
      capabilityIds: [], enforcedCapabilityIds: [], excludedCapabilityIds: [], status: "notAssessed", unassessedAspects: [],
      unavailableCheck: { assessmentStatus: status as "unableToCheck" | "outsideScope", result: null, settingId: `unavailable-${index}`, expectedValue: "", actualValue: null },
    }))
    expect(comparisonCounts(run)).toEqual({ matches: 0, different: 0, missing: 0, unableToCheck: 1, outsideScope: 1 })
    expect(scoreRun(run).counts).toMatchObject({ unknown: 1, outsideScope: 1 })
    expect(scoreRun(run).score).toBeNull()
  })

  it("ignores negative or non-finite counts instead of inflating the score", () => {
    expect(scoreFromCounts({ matching: 3, different: -5, missing: Number.NaN, unknown: 0, outsideScope: 0 }).score).toBe(100)
    expect(scoreFromCounts({ matching: -1, different: 0, missing: 0, unknown: 0, outsideScope: 0 }).score).toBeNull()
  })
})

describe("trend compatibility", () => {
  it("connects only runs with the same version, ruleset, profile and platforms", () => {
    const runs = [
      makeRun({ runId: "new", tenantId: TENANT_A, at: "2026-09-29T00:00:00Z", caps: { a: ["matches"] } }),
      makeRun({ runId: "old", tenantId: TENANT_A, at: "2026-09-01T00:00:00Z", caps: { a: ["different"] } }),
      makeRun({ runId: "ver", tenantId: TENANT_A, at: "2026-08-01T00:00:00Z", version: "1.1" }),
      makeRun({ runId: "rules", tenantId: TENANT_A, at: "2026-07-01T00:00:00Z", ruleset: "ruleset-2" }),
      makeRun({ runId: "scope", tenantId: TENANT_A, at: "2026-06-01T00:00:00Z", platforms: ["windows"] }),
    ]
    const { trend, incompatible } = buildTrend(runs)
    expect(trend.map((point) => point.runId)).toEqual(["old", "new"])
    expect(trend.map((point) => point.score)).toEqual([0, 100])
    expect(incompatible.map((run) => run.runId)).toEqual(["ver", "rules", "scope"])
    expect(incompatible[0]!.reasons[0]).toMatch(/Framework version changed/)
    expect(incompatible[1]!.reasons[0]).toMatch(/ruleset version changed/)
    expect(incompatible[2]!.reasons[0]).toMatch(/platforms changed/)
  })

  it("treats the profile as part of the identity only where it applies", () => {
    const e8a = identityOf(makeRun({ runId: "a", tenantId: TENANT_A, frameworkId: "essential-eight", maturity: 1 }))
    const e8b = identityOf(makeRun({ runId: "b", tenantId: TENANT_A, frameworkId: "essential-eight", maturity: 2 }))
    expect(compatibility(e8a, e8b).compatible).toBe(false)
    const nistA = identityOf(makeRun({ runId: "a", tenantId: TENANT_A, maturity: 1 }))
    const nistB = identityOf(makeRun({ runId: "b", tenantId: TENANT_A, maturity: 3 }))
    expect(compatibility(nistA, nistB).compatible).toBe(true)
  })

  it("marks old or undated comparisons stale", () => {
    expect(freshness(makeRun({ runId: "a", tenantId: TENANT_A, at: "2026-08-01T00:00:00Z" }), NOW).stale).toBe(true)
    expect(freshness(makeRun({ runId: "a", tenantId: TENANT_A, at: "2026-09-25T00:00:00Z" }), NOW).stale).toBe(false)
    expect(freshness(makeRun({ runId: "a", tenantId: TENANT_A, at: "not a date" }), NOW)).toMatchObject({ stale: true, ageDays: null })
  })
})

describe("/api/scores route", () => {
  it("resets current scores and trend history while reporting the older history notice", async () => {
    const old = makeRun({ runId: "old", tenantId: TENANT_A });
    const current = makeRun({ runId: "current", tenantId: TENANT_A, at: "2026-10-12T10:00:00Z" });
    const base = fakeFrameworksApi({ [`${TENANT_A}:nist-csf`]: [current, old] }).api;
    const api: typeof base = async (path, tenant, body = {}) => {
      const response = await base(path, tenant, body);
      if (body.frameworkId !== "nist-csf") return response;
      return Response.json({ ...(await response.json()), scoringChanged: true, currentRunIds: [current.runId] });
    };
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api });
    const { body } = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" });
    expect(body.scoringChanged).toBe(true);
    expect(body.frameworks.find((framework: any) => framework.frameworkId === "nist-csf").trend.map((point: any) => point.runId)).toEqual(["current"]);
    expect((await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "nist-csf", runId: "old" })).status).toBe(404);
  });

  it("answers 402 for Community and allows Pro", async () => {
    const { api } = fakeFrameworksApi({})
    const community = fakeDeps({ plans: { [TENANT_A]: "community" }, api })
    expect((await call(routes(community), "/api/scores", { tenantId: TENANT_A, action: "summary" })).status).toBe(402)
    expect((await call(routes(community), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "nist-csf" })).status).toBe(402)
    const pro = fakeDeps({ plans: { [TENANT_A]: "pro" }, api })
    const ok = await call(routes(pro), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    expect(ok.status).toBe(200)
    expect(ok.body.frameworks.every((f: any) => f.state === "not-assessed" && f.latest === null)).toBe(true)
  })

  it("shows partial collection and keeps unavailable frameworks visible without a score", async () => {
    const run = makeRun({ runId: "r1", tenantId: TENANT_A, incomplete: true, caps: { a: ["matches", "unknown"] } })
    const { api } = fakeFrameworksApi({ [`${TENANT_A}:nist-csf`]: [run] })
    const failing: typeof api = async (path, tenantId, body = {}) => (body.frameworkId === "iso-27001" ? Response.json({ error: "Denied" }, { status: 403 }) : api(path, tenantId, body))
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: failing, now: () => NOW })
    const { body } = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    const nist = body.frameworks.find((f: any) => f.frameworkId === "nist-csf")
    expect(nist.latest.incompleteCollection).toEqual(["settingsCatalog: incomplete"])
    // A readable assigned match wins over an unknown observation of the same capability.
    expect(nist.latest.score).toMatchObject({ score: 100, coverage: 100 })
    expect(nist.latest.identity).toMatchObject({ frameworkVersion: "2.0", profile: "Default", platforms: ["tenant", "windows"] })
    const iso = body.frameworks.find((f: any) => f.frameworkId === "iso-27001")
    expect(iso).toMatchObject({ state: "unavailable", message: "Denied", latest: null })
  })

  it("drills down to source controls and rejects unknown frameworks", async () => {
    const run = makeRun({ runId: "r1", tenantId: TENANT_A, caps: { a: ["matches"], b: ["different"] } })
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: fakeFrameworksApi({ [`${TENANT_A}:nist-csf`]: [run] }).api, now: () => NOW })
    const detail = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "nist-csf" })
    expect(detail.body.detail.controls.find((c: any) => c.id === "CTRL-b").gapCapabilityIds).toEqual(["b"])
    expect(detail.body.detail.gaps[0].settings[0]).toMatchObject({ result: "different", observed: "false" })
    expect((await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "nist-csf", runId: "missing" })).status).toBe(404)
    expect((await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "detail", frameworkId: "../etc" })).status).toBe(400)
  })

  it("ignores runs of another tenant even if the source returned them", async () => {
    const foreign = makeRun({ runId: "b", tenantId: TENANT_B, caps: { a: ["matches"] } })
    const deps = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: fakeFrameworksApi({ [`${TENANT_A}:nist-csf`]: [foreign] }).api, now: () => NOW })
    const { body } = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "summary" })
    expect(body.frameworks.find((f: any) => f.frameworkId === "nist-csf").state).toBe("not-assessed")
  })
})

describe("portfolio scores", () => {
  it("needs MSP and reads only the named tenants, with per-tenant freshness and coverage", async () => {
    const saved = {
      [`${TENANT_A}:nist-csf`]: [makeRun({ runId: "a", tenantId: TENANT_A, at: "2026-09-29T00:00:00Z", caps: { x: ["matches", "unknown"] } })],
      [`${TENANT_B}:nist-csf`]: [makeRun({ runId: "b", tenantId: TENANT_B, at: "2026-07-01T00:00:00Z", caps: { x: ["different"] } })],
      [`${TENANT_C}:nist-csf`]: [makeRun({ runId: "c", tenantId: TENANT_C, caps: { x: ["matches"] } })],
    }
    const pro = fakeDeps({ plans: { [TENANT_A]: "pro" }, api: fakeFrameworksApi(saved).api })
    expect((await call(routes(pro), "/api/scores", { tenantId: TENANT_A, action: "portfolio-summary" })).status).toBe(402)

    const fake = fakeFrameworksApi(saved)
    const deps = fakeDeps({ plans: { [TENANT_A]: "msp", [TENANT_B]: "msp", [TENANT_C]: "msp" }, api: fake.api, now: () => NOW })
    const { status, body } = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "portfolio-summary", targetTenants: [{ tenantId: TENANT_B }] })
    expect(status).toBe(200)
    expect(body.tenants.map((t: any) => t.tenantId)).toEqual([TENANT_A, TENANT_B])
    expect(new Set(fake.calls.map((c) => c.tenantId))).toEqual(new Set([TENANT_A, TENANT_B]))
    const a = body.tenants[0].frameworks.find((f: any) => f.frameworkId === "nist-csf")
    const b = body.tenants[1].frameworks.find((f: any) => f.frameworkId === "nist-csf")
    // Unknown observations no longer add votes beside a matching capability.
    expect(a).toMatchObject({ score: 100, coverage: 100, unknown: 0, stale: false })
    expect(b).toMatchObject({ score: 0, coverage: 100, stale: true, gapCount: 1 })
  })

  it("reports a denied tenant as unavailable without hiding the others", async () => {
    const saved = { [`${TENANT_A}:nist-csf`]: [makeRun({ runId: "a", tenantId: TENANT_A })] }
    const deps = fakeDeps({ plans: { [TENANT_A]: "msp", [TENANT_B]: "msp" }, api: fakeFrameworksApi(saved, [TENANT_B]).api, now: () => NOW })
    const { body } = await call(routes(deps), "/api/scores", { tenantId: TENANT_A, action: "portfolio-summary", targetTenants: [{ tenantId: TENANT_B }] })
    expect(body.tenants[0].frameworks.find((f: any) => f.frameworkId === "nist-csf").score).toBe(100)
    expect(body.tenants[1].frameworks.every((f: any) => f.state === "unavailable" && f.score === null)).toBe(true)
  })
})
