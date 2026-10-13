import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { apiBody } from "../src/main/features/deps"
import { routes } from "../src/main/features/health-review"
import { POST as listBackupsRoute } from "../src/portal/app/api/list-backups/route"
import { checkBackups, checkSignals, isDue, missedWindows, redactIdentifiers, validateWebhookUrl } from "../src/main/features/health-review/rules"
import { collectSignals, notifyEndpoints, runReview, tick } from "../src/main/features/health-review/service"
import { DOMAINS } from "../src/main/features/domains"
import type { Plan } from "../src/shared/plans"
import { call, fakeDeps, TENANT_A, TENANT_B } from "./feature-helpers"

const PATH = "/api/health-review"
const NOW = new Date("2026-09-30T12:00:00Z")
const hoursBefore = (date: Date, hours: number) => new Date(date.getTime() - hours * 3_600_000).toISOString()
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const noSleep = async () => undefined

/** A test world with a movable clock, a fake backup list and a recording webhook. */
function world(options: { plans?: Record<string, Plan>; signedIn?: boolean; webhookStatus?: number | "throw" } = {}) {
  let now = NOW
  let backupHours: number | null = 2
  let backupStatus = 200
  const posts: Array<{ url: string; init: RequestInit }> = []
  let webhookStatus = options.webhookStatus ?? 204
  const deps = fakeDeps({
    plans: options.plans ?? { [TENANT_A]: "pro" },
    now: () => now,
    actor: (tenantId) => (options.signedIn === false ? null : { id: `admin@${tenantId.slice(0, 4)}`, name: "Admin" }),
    api: async (path) => {
      if (path !== "/api/list-backups") return Response.json({ error: "unexpected" }, { status: 500 })
      if (backupStatus !== 200) return Response.json({ error: "Failed to authenticate with Azure" }, { status: backupStatus })
      return Response.json({ backups: backupHours === null ? [] : [{ timestamp: hoursBefore(now, backupHours), status: "Success" }] })
    },
    externalFetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, init })
      if (webhookStatus === "throw") throw new Error("connect ECONNREFUSED")
      return new Response(null, { status: webhookStatus })
    }) as unknown as typeof fetch,
  })
  return {
    deps,
    routes: routes(deps),
    posts,
    setNow: (value: Date) => void (now = value),
    advanceHours: (hours: number) => void (now = new Date(now.getTime() + hours * 3_600_000)),
    setBackupAge: (hours: number | null) => void (backupHours = hours),
    setBackupStatus: (status: number) => void (backupStatus = status),
    setWebhook: (status: number | "throw") => void (webhookStatus = status),
  }
}

describe("health review rules", () => {
  it("classifies backup age with the dashboard thresholds and keeps unreadable evidence unknown", () => {
    const at = (hours: number) => checkBackups(TENANT_A, { outcome: "ok", backups: [{ timestamp: hoursBefore(NOW, hours), status: "Success" }] }, NOW)
    expect(at(10).findings).toEqual([])
    expect(at(30).findings[0]).toMatchObject({ severity: "medium", state: "open", check: "backup-stale" })
    expect(at(50).findings[0]).toMatchObject({ severity: "critical", state: "open" })
    expect(checkBackups(TENANT_A, { outcome: "ok", backups: [] }, NOW).findings[0]).toMatchObject({ severity: "high", check: "backup-missing" })
    const auth = checkBackups(TENANT_A, { outcome: "auth", backups: [] }, NOW)
    expect(auth.evaluated).toBe(false)
    expect(auth.findings[0]).toMatchObject({ state: "unknown", observedAt: null, title: "Could not authenticate to read backups" })
  })

  it("counts missed windows and is never due while disabled", () => {
    const schedule = { enabled: true, intervalHours: 24, lastReviewAt: null, nextDueAt: hoursBefore(NOW, 80) }
    expect(isDue(schedule, NOW)).toBe(true)
    expect(missedWindows(schedule, NOW)).toBe(3)
    expect(isDue({ ...schedule, enabled: false }, NOW)).toBe(false)
  })

  it("accepts only https webhooks without embedded credentials", () => {
    expect(validateWebhookUrl("http://hooks.example.com/x").ok).toBe(false)
    expect(validateWebhookUrl("https://user:pw@hooks.example.com/x").ok).toBe(false)
    expect(validateWebhookUrl("ftp://x").ok).toBe(false)
    expect(validateWebhookUrl("https://hooks.example.com/x").ok).toBe(true)
    expect(redactIdentifiers(`backup-stale:${TENANT_A}`)).not.toMatch(GUID)
  })

  it("rejects webhooks to this computer, private networks and link-local addresses", () => {
    const blocked = [
      "https://localhost/x", "https://LOCALHOST./x", "https://api.localhost/x",
      "https://127.0.0.1/x", "https://127.8.9.10/x", "https://2130706433/x", "https://0x7f.1/x", "https://0.0.0.0/x",
      "https://10.1.2.3/x", "https://172.16.0.1/x", "https://172.31.255.255/x", "https://192.168.1.10/x",
      "https://100.64.0.1/x", "https://100.127.255.254/x", "https://169.254.169.254/latest/meta-data", "https://169.254.1.1/x",
      "https://[::1]/x", "https://[::]/x", "https://[0:0:0:0:0:0:0:1]/x", "https://[fc00::1]/x", "https://[fd12:3456::1]/x",
      "https://[fe80::1]/x", "https://[febf::1]/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:169.254.169.254]/x",
    ]
    for (const url of blocked) expect(validateWebhookUrl(url), url).toMatchObject({ ok: false, error: expect.stringContaining("public address") })
    const allowed = ["https://hooks.slack.com/services/x", "https://172.32.0.1/x", "https://100.128.0.1/x", "https://11.0.0.1/x", "https://[2001:db8::1]/x", "https://[::ffff:8.8.8.8]/x", "https://localhost.example.com/x"]
    for (const url of allowed) expect(validateWebhookUrl(url).ok, url).toBe(true)
  })
})

describe("health review runs and findings", () => {
  it("persists findings once, deduplicates repeated reviews and resolves or reopens only from fresh evidence", async () => {
    const w = world()
    w.setBackupAge(50)
    const first = await call(w.routes, PATH, { tenantId: TENANT_A, action: "run-review" })
    expect(first.status).toBe(200)
    expect(first.body.run.status).toBe("completed")
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "run-review" })
    let findings = (await call(w.routes, PATH, { tenantId: TENANT_A, action: "list-findings" })).body.findings
    const stale = findings.filter((finding: any) => finding.key === `backup-stale:${TENANT_A}`)
    expect(stale).toHaveLength(1)
    expect(stale[0]).toMatchObject({ severity: "critical", occurrence: 1, state: "open" })
    // Only backup checks run; no other check family reports findings.
    expect(findings.every((finding: any) => finding.family === "backup")).toBe(true)

    w.setBackupAge(1)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "run-review" })
    findings = (await call(w.routes, PATH, { tenantId: TENANT_A, action: "list-findings" })).body.findings
    expect(findings.find((finding: any) => finding.key === `backup-stale:${TENANT_A}`)).toMatchObject({ state: "resolved" })

    w.setBackupAge(60)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "run-review" })
    findings = (await call(w.routes, PATH, { tenantId: TENANT_A, action: "list-findings" })).body.findings
    const reopened = findings.find((finding: any) => finding.key === `backup-stale:${TENANT_A}`)
    expect(reopened).toMatchObject({ state: "open", occurrence: 2, resolvedAt: null })
    expect(reopened.history.map((entry: any) => entry.reason)).toContain("Reopened: fresh evidence shows the problem again")
  })

  it("keeps stored findings from nesting history on repeated reviews", async () => {
    const w = world()
    w.setBackupAge(50)
    for (let index = 0; index < 12; index++) await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    const stored = w.deps.records.list<{ key: string }>(DOMAINS.healthFindings, TENANT_A).find((finding) => finding.key === `backup-stale:${TENANT_A}`)!
    expect(stored.history).toHaveLength(12)
    expect(stored.history.every((entry) => !("history" in (entry.snapshot as object)))).toBe(true)
    expect(JSON.stringify(stored).length).toBeLessThan(20_000)
  })

  it("records could not authenticate and keeps earlier findings instead of resolving them", async () => {
    const w = world()
    w.setBackupAge(50)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "run-review" })
    w.setBackupStatus(401)
    const run = await call(w.routes, PATH, { tenantId: TENANT_A, action: "run-review" })
    expect(run.body.run.status).toBe("could-not-authenticate")
    const findings = run.body.findings
    expect(findings.find((finding: any) => finding.key === `backup-stale:${TENANT_A}`).state).toBe("open")
    expect(findings.find((finding: any) => finding.key === `backup-unavailable:${TENANT_A}`)).toMatchObject({ state: "unknown", title: "Could not authenticate to read backups" })
    const status = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })
    expect(status.body.schedule.lastOutcome).toBe("could-not-authenticate")
    expect(status.body.readiness.note).toMatch(/only while TenuVault is running/)
  })

  it("shows sign-in required readiness when signed out", async () => {
    const w = world({ signedIn: false })
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "update-schedule", enabled: true })
    const status = await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })
    expect(status.body.readiness).toMatchObject({ state: "sign-in-required", signedIn: false })
    const run = await call(w.routes, PATH, { tenantId: TENANT_A, action: "run-review" })
    expect(run.body.run.status).toBe("could-not-authenticate")
  })
})

describe("health review schedule", () => {
  it("runs one catch-up review after missed windows, then waits a full interval", async () => {
    const w = world()
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "update-schedule", enabled: true, intervalHours: 24 })
    await tick(w.deps, { sleep: noSleep })
    let runs = (await call(w.routes, PATH, { tenantId: TENANT_A, action: "list-runs" })).body.runs
    expect(runs).toHaveLength(1)
    expect(runs[0].trigger).toBe("scheduled")

    // The app was closed for three days.
    w.advanceHours(24 * 3 + 5)
    await tick(w.deps, { sleep: noSleep })
    await tick(w.deps, { sleep: noSleep })
    runs = (await call(w.routes, PATH, { tenantId: TENANT_A, action: "list-runs" })).body.runs
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ trigger: "catch-up", missedWindows: 2 })
    const status = (await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })).body
    expect(Date.parse(status.schedule.nextDueAt)).toBe(w.deps.now().getTime() + 24 * 3_600_000)

    w.advanceHours(23)
    await tick(w.deps, { sleep: noSleep })
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "list-runs" })).body.runs).toHaveLength(2)
  })

  it("skips a tenant whose license expired, keeps its findings readable and refuses paid actions", async () => {
    const plans: Record<string, Plan> = { [TENANT_A]: "pro" }
    const w = world({ plans })
    w.setBackupAge(50)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "update-schedule", enabled: true })
    await tick(w.deps, { sleep: noSleep })
    const expired = fakeDeps({ plans: { [TENANT_A]: "community" }, records: w.deps.records, now: () => w.deps.now() })
    const expiredRoutes = routes(expired)
    expect((await call(expiredRoutes, PATH, { tenantId: TENANT_A, action: "run-review" })).status).toBe(402)
    expect((await call(expiredRoutes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "local" })).status).toBe(402)
    const findings = await call(expiredRoutes, PATH, { tenantId: TENANT_A, action: "list-findings" })
    expect(findings.status).toBe(200)
    expect(findings.body.findings.length).toBeGreaterThan(0)
    const before = (await call(expiredRoutes, PATH, { tenantId: TENANT_A, action: "list-runs" })).body.runs.length
    expired.now = () => new Date(NOW.getTime() + 48 * 3_600_000)
    await tick(expired, { sleep: noSleep })
    expect((await call(expiredRoutes, PATH, { tenantId: TENANT_A, action: "list-runs" })).body.runs.length).toBe(before)
    const status = (await call(expiredRoutes, PATH, { tenantId: TENANT_A, action: "get-status" })).body
    expect(status.schedule.lastOutcome).toBe("not-licensed")
    expect(status.readiness.state).toBe("not-licensed")
  })
})

describe("health review notifications", () => {
  it("sends a finding once per occurrence, again only after it resolves and reopens", async () => {
    const w = world()
    w.setBackupAge(50)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "local", minSeverity: "critical" })
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(w.deps.notifications).toHaveLength(1)
    expect(w.deps.notifications[0]).toMatch(/1 finding needs attention \(1 critical\)/)
    w.setBackupAge(1)
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    w.setBackupAge(50)
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(w.deps.notifications).toHaveLength(2)
  })

  it("retries a failing webhook at most three times, shows the error and leaves findings alone", async () => {
    const w = world({ webhookStatus: 503 })
    w.setBackupAge(50)
    const added = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "webhook", url: "https://hooks.example.com/tv" })
    const { findings } = await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(w.posts).toHaveLength(3)
    const status = (await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })).body
    const endpoint = status.endpoints.find((entry: any) => entry.id === added.body.endpoint.id)
    expect(endpoint.lastDelivery).toMatchObject({ ok: false, attempts: 3, status: 503, error: "The endpoint answered HTTP 503." })
    expect(findings.find((finding) => finding.key === `backup-stale:${TENANT_A}`)?.state).toBe("open")
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "list-runs" })).body.runs[0].deliveries[0]).toMatchObject({ ok: false, attempts: 3 })

    // Non-retryable answers stop after one attempt; the next review tries again, then succeeds once.
    w.setWebhook(400)
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(w.posts).toHaveLength(4)
    w.setWebhook(204)
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(w.posts).toHaveLength(5)
  })

  it("stops on network errors after the retry cap and on disabled or removed endpoints", async () => {
    const w = world({ webhookStatus: "throw" })
    w.setBackupAge(50)
    const added = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "webhook", url: "https://hooks.example.com/tv" })
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(w.posts).toHaveLength(3)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "update-endpoint", endpointId: added.body.endpoint.id, enabled: false })
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(w.posts).toHaveLength(3)
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "revoke-endpoint", endpointId: added.body.endpoint.id })).status).toBe(200)
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "get-status" })).body.endpoints).toEqual([])
  })

  it("sends only allowed metadata, redacts identifiers unless opted in and never returns the secret", async () => {
    const w = world()
    w.setBackupAge(50)
    const secret = "s3cr3t-header-value-123"
    const added = await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "webhook", url: "https://hooks.example.com/tv", headerName: "X-Hook-Key", headerValue: secret })
    expect(JSON.stringify(added.body)).not.toContain(secret)
    expect(added.body.endpoint.hasSecretHeader).toBe(true)
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(w.posts).toHaveLength(1)
    const sent = w.posts[0]!
    expect((sent.init.headers as Record<string, string>)["X-Hook-Key"]).toBe(secret)
    const body = String(sent.init.body)
    expect(body).not.toMatch(GUID)
    expect(body).not.toContain(secret)
    expect(body).not.toContain("token")
    const parsed = JSON.parse(body)
    expect(Object.keys(parsed).sort()).toEqual(["counts", "findings", "generatedAt", "review", "schema", "tenant", "test"])
    expect(parsed.tenant).toEqual({})
    expect(Object.keys(parsed.findings[0]).sort()).toEqual(["check", "evidenceAt", "firstSeenAt", "key", "lastSeenAt", "severity", "state"])

    const preview = await call(w.routes, PATH, { tenantId: TENANT_A, action: "preview-payload", endpointId: added.body.endpoint.id, includeIdentifiers: true, includeTenantName: true })
    expect(preview.body.payload.tenant).toEqual({ name: w.deps.tenant(TENANT_A)!.name, id: TENANT_A })
    expect(preview.body.body).toMatch(GUID)
    for (const action of ["get-status", "list-findings", "list-runs"]) {
      expect(JSON.stringify((await call(w.routes, PATH, { tenantId: TENANT_A, action })).body)).not.toContain(secret)
    }
  })

  it("rejects non-https endpoints and header injection", async () => {
    const w = world()
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "webhook", url: "http://hooks.example.com" })).status).toBe(400)
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "webhook", url: "https://hooks.example.com", headerName: "Host", headerValue: "x" })).status).toBe(400)
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "webhook", url: "https://hooks.example.com", headerName: "X-Key", headerValue: "a\r\nb" })).status).toBe(400)
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "carrier-pigeon" })).status).toBe(400)
  })

  it("does not change findings when delivery is attempted directly", async () => {
    const w = world({ webhookStatus: 500 })
    w.setBackupAge(50)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "webhook", url: "https://hooks.example.com/tv" })
    const { findings } = await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    const before = JSON.stringify(w.deps.records.list(DOMAINS.healthFindings, TENANT_A))
    await notifyEndpoints(w.deps, TENANT_A, findings, { reviewedAt: NOW.toISOString(), status: "completed" }, { sleep: noSleep })
    expect(JSON.stringify(w.deps.records.list(DOMAINS.healthFindings, TENANT_A))).toBe(before)
  })
})

describe("health review ownership and isolation", () => {
  it("keeps owners and acknowledgements per customer and never crosses tenants", async () => {
    const w = world({ plans: { [TENANT_A]: "msp", [TENANT_B]: "msp" } })
    w.setBackupAge(50)
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    await runReview(w.deps, TENANT_B, "manual", null, { sleep: noSleep })
    const findingA = (await call(w.routes, PATH, { tenantId: TENANT_A, action: "list-findings" })).body.findings.find((finding: any) => finding.key.startsWith("backup-stale"))
    const owned = await call(w.routes, PATH, { tenantId: TENANT_A, action: "set-finding-owner", findingId: findingA.id, owner: "Customer A team" })
    expect(owned.body.finding.owner).toBe("Customer A team")
    expect((await call(w.routes, PATH, { tenantId: TENANT_B, action: "set-finding-owner", findingId: findingA.id, owner: "x" })).status).toBe(404)
    expect((await call(w.routes, PATH, { tenantId: TENANT_B, action: "acknowledge-finding", findingId: findingA.id })).status).toBe(404)
    const ack = await call(w.routes, PATH, { tenantId: TENANT_A, action: "acknowledge-finding", findingId: findingA.id })
    expect(ack.body.finding.acknowledgedBy).toBe("Admin")

    const portfolio = await call(w.routes, PATH, { tenantId: TENANT_A, action: "portfolio-status", targetTenants: [{ tenantId: TENANT_B }] })
    expect(portfolio.body.tenants.map((tenant: any) => [tenant.tenantId, tenant.owners])).toEqual([[TENANT_A, ["Customer A team"]], [TENANT_B, []]])
  })

  it("keeps portfolio triage MSP only", async () => {
    const w = world({ plans: { [TENANT_A]: "pro", [TENANT_B]: "pro" } })
    expect((await call(w.routes, PATH, { tenantId: TENANT_A, action: "portfolio-status", targetTenants: [{ tenantId: TENANT_B }] })).status).toBe(402)
  })
})

const META = { actor: null, reason: "Seeded for the health review test" }

function seedSignals(deps: ReturnType<typeof world>["deps"]) {
  const install: { id: string } = deps.records.create(DOMAINS.baselineInstalls, TENANT_A, {
    kind: "install", title: "Windows baseline", status: "tracked", summary: "Installed.", origin: { type: "workspace", frameworkId: "cis" }, platform: "windows",
    commit: "a".repeat(40), reference: "v1", sourceId: "source-1", policies: [], customizationVersion: 1, customizationHash: null,
    latestKnownRelease: { commit: "b".repeat(40), reference: "v2", tag: "v2", checkedAt: NOW.toISOString() }, lastUpgradeId: null,
  } as never, META)
  const upgrade: { id: string } = deps.records.create(DOMAINS.baselineUpgrades, TENANT_A, {
    title: "Upgrade to v2", status: "review", summary: "Waiting for resolutions.", installId: install.id, mode: "three-way",
    from: { commit: "a".repeat(40), reference: "v1", sourceId: "source-1" }, to: { platform: "windows", commit: "b".repeat(40), reference: "v2", sourceId: "source-2" },
    comparisonId: "comparison-1", comparedAt: NOW.toISOString(), policies: [], unresolved: 3, batches: [], customizationVersionFrom: 1, customizationVersionTo: null, resultingCustomizationHash: null, finalized: false,
  } as never, META)
  const adoption: { id: string } = deps.records.create(DOMAINS.adoptions, TENANT_A, {
    title: "Customer standard", status: "adopted", summary: "Adopted.", standardKey: "standard-a", versionId: "version-1", version: 1,
    adoptedVersionId: "version-1", adoptedVersion: 1, adoptedAt: NOW.toISOString(), parameters: {}, overlay: { settings: [], removals: [], exceptions: [] }, overlayVersion: 1,
    mappings: [], migrationNotes: [], pending: null, adoptedParameters: {}, adoptedOverlay: { settings: [], removals: [] }, adoptedChangeSetId: null, previousAdopted: null,
    lastAssessment: { at: NOW.toISOString(), versionId: "version-1", counts: {}, policies: [{ policyKey: "policy-1", state: "assessed", deviations: 2, message: null }] },
  } as never, META)
  const hygiene: { id: string } = deps.records.create(DOMAINS.hygieneFindings, TENANT_A, {
    kind: "finding", title: "Policy A is not assigned", summary: "Unassigned.", status: "open", ruleId: "unassigned-policy", fingerprint: "unassigned-policy:ConfigurationPolicies/p1",
    classification: "definite", severity: "low", explanation: "This policy has no assignments.", policies: [], settings: [], details: {}, evidenceSha256: "hash",
    backupId: "backup-1", collectedAt: NOW.toISOString(), scanId: "scan-1", firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), review: null,
  } as never, META)
  return { install, upgrade, adoption, hygiene }
}

describe("health review work signals", () => {
  it("maps work signals to findings with the signal severity and state", () => {
    const result = checkSignals(TENANT_A, [{ key: "standard-deviation:abc", tenantId: TENANT_A, source: "standard", severity: "medium", state: "open", title: "2 settings deviate", reason: "Live settings differ.", observedAt: NOW.toISOString(), link: "/portal/governance/standards", evidence: ["standard-adoptions:abc"] }], true)
    expect(result).toMatchObject({ family: "signals", evaluated: true })
    expect(result.findings[0]).toMatchObject({ family: "signals", check: "standard-deviation", severity: "medium", state: "open", evidenceAt: NOW.toISOString() })
    const failed = checkSignals(TENANT_A, [], false)
    expect(failed.evaluated).toBe(false)
    expect(failed.findings[0]).toMatchObject({ check: "signals-unavailable", state: "unknown", observedAt: null })
  })

  it("surfaces pending upgrades, conflicts, deviations and hygiene findings, then resolves them from fresh evidence", async () => {
    const w = world({ plans: { [TENANT_A]: "msp" } })
    const seeded = seedSignals(w.deps)
    const first = await call(w.routes, PATH, { tenantId: TENANT_A, action: "run-review" })
    expect(first.body.run.checks).toContainEqual(expect.objectContaining({ family: "signals", evaluated: true }))
    let findings = first.body.findings as Array<any>
    expect(findings.find((finding) => finding.key === `baseline-upgrade-available:${seeded.install.id}`)).toMatchObject({ family: "signals", check: "baseline-upgrade-available", severity: "low", state: "open" })
    expect(findings.find((finding) => finding.key === `baseline-conflicts:${seeded.upgrade.id}`)).toMatchObject({ family: "signals", severity: "medium", state: "open", title: expect.stringContaining("3 unresolved") })
    expect(findings.find((finding) => finding.key === `standard-deviation:${seeded.adoption.id}`)).toMatchObject({ family: "signals", severity: "medium", state: "open" })
    expect(findings.find((finding) => finding.key.startsWith("hygiene-finding:"))).toMatchObject({ family: "signals", severity: "low", state: "open" })
    expect(first.body.run.counts).toMatchObject({ medium: 2, low: 2 })

    w.deps.records.remove(DOMAINS.baselineInstalls, TENANT_A, seeded.install.id)
    w.deps.records.remove(DOMAINS.baselineUpgrades, TENANT_A, seeded.upgrade.id)
    w.deps.records.remove(DOMAINS.adoptions, TENANT_A, seeded.adoption.id)
    w.deps.records.remove(DOMAINS.hygieneFindings, TENANT_A, seeded.hygiene.id)
    const second = await call(w.routes, PATH, { tenantId: TENANT_A, action: "run-review" })
    findings = second.body.findings as Array<any>
    expect(findings.filter((finding) => finding.family === "signals").every((finding) => finding.state === "resolved")).toBe(true)
  })

  it("does not run the standards provider on Pro and runs no provider on Community", async () => {
    const pro = world({ plans: { [TENANT_A]: "pro" } })
    const seeded = seedSignals(pro.deps)
    const collected = await collectSignals(pro.deps, TENANT_A)
    expect(collected.signals.some((signal) => signal.key === `baseline-upgrade-available:${seeded.install.id}`)).toBe(true)
    expect(collected.signals.some((signal) => signal.key.startsWith("standard-"))).toBe(false)
    expect(collected.signals.some((signal) => signal.key.startsWith("hygiene-"))).toBe(true)

    const community = world({ plans: { [TENANT_A]: "community" } })
    seedSignals(community.deps)
    expect(await collectSignals(community.deps, TENANT_A)).toEqual({ signals: [], evaluated: true })
  })

  it("sends new signal findings to webhooks with the existing payload shape", async () => {
    const w = world({ plans: { [TENANT_A]: "msp" } })
    seedSignals(w.deps)
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "add-endpoint", kind: "webhook", url: "https://hooks.example.com/tv", minSeverity: "low" })
    await runReview(w.deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(w.posts).toHaveLength(1)
    const payload = JSON.parse(String(w.posts[0]!.init.body))
    expect(payload.findings.map((finding: any) => finding.check)).toEqual(expect.arrayContaining(["baseline-upgrade-available", "baseline-conflicts", "standard-deviation", "hygiene-finding"]))
    expect(Object.keys(payload.findings[0]).sort()).toEqual(["check", "evidenceAt", "firstSeenAt", "key", "lastSeenAt", "severity", "state"])
  })

  it("surfaces signals in a scheduled review without extra tenant writes", async () => {
    const w = world({ plans: { [TENANT_A]: "msp" } })
    const seeded = seedSignals(w.deps)
    const apiCalls: string[] = []
    const originalApi = w.deps.api
    w.deps.api = async (path, tenantId, body) => { apiCalls.push(path); return originalApi(path, tenantId, body) }
    await call(w.routes, PATH, { tenantId: TENANT_A, action: "update-schedule", enabled: true })
    await tick(w.deps, { sleep: noSleep })
    const findings = (await call(w.routes, PATH, { tenantId: TENANT_A, action: "list-findings" })).body.findings as Array<any>
    expect(findings.some((finding) => finding.key === `baseline-conflicts:${seeded.upgrade.id}` && finding.state === "open")).toBe(true)
    expect(apiCalls).toContain("/api/list-backups")
    expect(apiCalls.every((path) => ["/api/list-backups", "/api/frameworks", "/api/oib"].includes(path))).toBe(true)
  })
})

describe("health review reads backups through the real list-backups route", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends the fields the route requires, so the backup check is evaluated", async () => {
    const name = "backup-2026-09-30-100000"
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
      if (url.pathname.endsWith("metadata.json")) return Response.json({ Status: "Success", TenantId: TENANT_A })
      if (url.searchParams.get("delimiter")) return new Response(`<BlobPrefix><Name>${name}/</Name></BlobPrefix>`)
      return new Response(`<Blobs><Blob><Name>${name}/metadata.json</Name><Properties><Content-Length>7</Content-Length></Properties></Blob></Blobs>`)
    }))
    const deps = fakeDeps({
      api: async (path, tenantId, body) => {
        if (path !== "/api/list-backups") return Response.json({ error: "unexpected" }, { status: 500 })
        const profile = deps.tenant(tenantId)!
        return listBackupsRoute(new NextRequest(`http://tenuvault.internal${path}`, { method: "POST", body: JSON.stringify(apiBody(tenantId, profile, body)) }))
      },
    })
    const { run, findings } = await runReview(deps, TENANT_A, "manual", null, { sleep: noSleep })
    expect(run.checks.find((check) => check.family === "backup")).toMatchObject({ evaluated: true })
    expect(findings.some((finding) => finding.check === "backup-unavailable")).toBe(false)
  })

  it("keeps caller fields and fills credentials the caller cannot override", () => {
    const profile = { clientId: "app", storageAccountName: "store" }
    expect(apiBody(TENANT_A, profile)).toMatchObject({ subscriptionId: "local", resourceGroupName: "local", tenantId: TENANT_A, appId: "app", storageAccountName: "store" })
    expect(apiBody(TENANT_A, profile, { subscriptionId: "sub", backupId: "b", storageAccountName: "other" })).toMatchObject({ subscriptionId: "sub", backupId: "b", storageAccountName: "store" })
  })
})
