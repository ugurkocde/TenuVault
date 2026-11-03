import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyCisRemediation, approveCisRemediation, createCisRollback, planCisRemediation, previewCisRemediation, previewCisRollback } from "../src/main/features/cis-remediation/engine"
import { applyChangeSet, approveChangeSet, createChangeSet, previewChangeSet } from "../src/main/features/change-sets/engine"
import { backupAuthorization, featureAccess, inRecovery, tenantAuthorizer, withRecoveryBackups } from "../src/main/features/recovery"
import { planGuard } from "../src/main/api/plan-gates"
import { LicenseService } from "../src/main/license/service"
import { setCisBenchmarksPlanProvider, setInternalCisBenchmarksEnabled } from "../src/main/frameworks/service"
import { CommunityLimitError } from "../src/shared/plan-errors"
import type { Finding } from "../src/shared/frameworks/policies"
import { COMPLETE_BACKUP_METADATA, FakeTenant, setting } from "./feature-change-sets-fakes"
import { fakeDeps, TENANT_A, TENANT_B, TENANT_C } from "./feature-helpers"
import { memoryStore } from "./helpers"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { BackupEngine } from "../src/main/backup/engine"
import { backupRoutes } from "../src/main/api/desktop-routes"
import { ApiHost } from "../src/main/api/host"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { DOMAINS } from "../src/main/features/domains"

// Synthetic fixtures only: no CIS recommendation text.
const DEF = "fakebook_setting_alpha"
const choice = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policies = [{ name: "Fakebook Alpha", platforms: "windows10", technologies: "mdm", description: "synthetic", settings: [{ settingInstance: { "@odata.type": choice, settingDefinitionId: DEF, choiceSettingValue: { value: "fake-on" } } }] }]
const findings: Finding[] = [{ key: "0:0", policyIndex: 0, settingIndex: 0, status: "Missing", policyName: "Fakebook Alpha", settingId: DEF, recommended: null, observed: [] }]

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const INSTALL = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const APP_ID = "99999999-9999-9999-9999-999999999999"
const GRAPH = "https://graph.microsoft.com/beta/"

function token(tenantId: string): string {
  const iat = Math.floor(Date.now() / 1000)
  const body = Buffer.from(JSON.stringify({ v: 1, sub: "sub", act: `act-${tenantId}`, plan: "msp", tenantId, installId: INSTALL, tenants: 10, status: "granted", iat, exp: iat + 14 * 86400 })).toString("base64url")
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`
}

/**
 * The production wiring of src/main/index.ts around a real LicenseService: featureAccess for
 * Graph and the app routes, the plan guard of the API host, and the tenant authorizer the fetch
 * bridge and the backup engine use. Graph answers come from fake tenants behind the real Graph
 * caller. The backup routes authorize the tenant as the backup engine does: the job checks it
 * after the start request has returned.
 */
/** A real license service with an MSP key active on tenants A and B; `expire` ends it as the service would. */
async function mspLicense() {
  let licensed = true
  const license = new LicenseService({
    store: (() => { const store = memoryStore(); store.set("license.installId", INSTALL); return store })(),
    persist: true,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    apiBase: "http://127.0.0.1:9",
    appVersion: "0.0.0-test",
    platform: "darwin",
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tenantId: string }
      return licensed ? Response.json({ token: token(body.tenantId), activationId: `act-${body.tenantId}`, plan: "msp" }) : Response.json({ reason: "expired" }, { status: 403 })
    }) as typeof fetch,
    idToken: async () => "id.token.value",
    clientId: () => APP_ID,
  })
  await license.setKey("TEST-LICENSE-KEY", [])
  for (const tenantId of [TENANT_A, TENANT_B]) await expect(license.requireEntitlement(tenantId)).resolves.toBe("msp")
  /** The MSP license ends: the service refuses it as expired and every tenant falls back to Community. */
  return { license, expire: async () => { licensed = false; await license.refreshAll() } }
}

async function setup() {
  const { license, expire } = await mspLicense()
  const tenants = [new FakeTenant(TENANT_A), new FakeTenant(TENANT_B)]
  const deps = fakeDeps({ plans: { [TENANT_A]: "msp", [TENANT_B]: "msp" } })
  deps.plan = (tenantId) => license.requireEntitlement(tenantId)
  const authorize = tenantAuthorizer(license)
  const plan = withRecoveryBackups(planGuard((tenantId) => license.requireEntitlement(tenantId).catch(() => null)))
  const jobs = new Map<string, Promise<string | null>>()
  const backups: string[] = []
  const recoveryOfOtherTenant: boolean[] = []
  const graphFetch = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    const tenant = tenants.find((entry) => entry.tenantId === graphTenant)!
    const result = await tenant.graph(false)((init?.method ?? "GET") as "GET", url.slice(GRAPH.length), init?.body ? JSON.parse(String(init.body)) : undefined)
    return result.status === 204 ? new Response(null, { status: 204 }) : Response.json(result.body, { status: result.status })
  }) as typeof fetch
  // The fake Graph serves the tenant whose token was acquired last.
  let graphTenant = TENANT_A
  const dispatch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    const body = (await request.clone().json()) as { tenantId: string; jobId?: string; backupId?: string }
    if (path === "/api/audit/log") return Response.json({ success: true })
    const refused = await plan(request)
    if (refused) return refused
    recoveryOfOtherTenant.push(inRecovery(body.tenantId === TENANT_A ? TENANT_B : TENANT_A))
    if (path === "/api/backup/start") {
      const jobId = randomUUID()
      backups.push(body.tenantId)
      jobs.set(jobId, new Promise((resolve) => setTimeout(resolve, 0)).then(() => authorize(body.tenantId)).then(() => null, (error: Error) => error.message))
      return Response.json({ jobId })
    }
    if (path === "/api/backup/status") {
      const failure = await jobs.get(body.jobId!)
      return Response.json(failure === null ? { isComplete: true, isSuccessful: true, backupFolder: "backup-2026-11-03-120000" } : { isComplete: true, isSuccessful: false, exception: failure })
    }
    if (path === "/api/list-backup-contents") {
      try {
        await authorize(body.tenantId)
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 403 })
      }
      return Response.json({ backupId: body.backupId, content: { groups: [], metadata: COMPLETE_BACKUP_METADATA } })
    }
    return Response.json({ error: "not served" }, { status: 404 })
  }
  Object.assign(deps, featureAccess({
    license,
    records: deps.records,
    signedInClient: () => APP_ID,
    tokenFor: async (tenantId) => { graphTenant = tenantId.toLowerCase(); return { accessToken: `token-${tenantId}` } },
    fetch: graphFetch,
    dispatch,
    tenantProfile: deps.tenant,
  }))
  setCisBenchmarksPlanProvider((tenantId) => license.plan(tenantId))
  return {
    deps, license, tenants, backups, recoveryOfOtherTenant, authorize, expire,
  }
}

async function deploy(context: Awaited<ReturnType<typeof setup>>, tenantId: string) {
  const deployment = await planCisRemediation(context.deps, tenantId, { title: "Deploy", reference: "synthetic 1.0", policies, findings, selectedFindingKeys: ["0:0"] }, "Admin")
  const preview = await previewCisRemediation(context.deps, tenantId, deployment.id)
  await approveCisRemediation(context.deps, tenantId, deployment.id, { contentHash: preview.changeSet.contentHash, targetFingerprint: preview.changeSet.targetFingerprint, reviewer: "Reviewer" }, "Admin")
  const applied = await applyCisRemediation(context.deps, tenantId, deployment.id, { contentHash: preview.changeSet.contentHash, confirmed: true }, "Admin")
  expect(applied.changeSet.status).toBe("applied")
  return deployment
}

// The synthetic pack is not delivered by the service, so these tests hold the internal claim.
beforeEach(() => setInternalCisBenchmarksEnabled(true))
afterEach(() => { setCisBenchmarksPlanProvider(null); setInternalCisBenchmarksEnabled(null) })

describe("CIS rollback after an MSP license expired", () => {
  it("rolls back a deployment in a tenant that Community no longer covers, through the real Graph and backup wiring", async () => {
    const context = await setup()
    const deployment = await deploy(context, TENANT_B)
    const created = [...context.tenants[1]!.policies.values()].find((policy) => policy.name === "[Baseline] Fakebook Alpha")!
    await context.expire()
    // Tenant A holds Community; tenant B is no longer usable for anything else.
    await expect(context.license.requireEntitlement(TENANT_A)).resolves.toBe("community")
    await expect(context.license.requireEntitlement(TENANT_B)).rejects.toBeInstanceOf(CommunityLimitError)
    await expect(context.deps.graph(TENANT_B)).rejects.toBeInstanceOf(CommunityLimitError)

    const rollbackPreview = await previewCisRollback(context.deps, TENANT_B, deployment.id)
    expect(rollbackPreview.operations.map((operation) => operation.action)).toEqual(["delete"])
    const rollback = await createCisRollback(context.deps, TENANT_B, deployment.id, {}, "Admin")
    const review = await previewChangeSet(context.deps, TENANT_B, rollback.id)
    await approveChangeSet(context.deps, TENANT_B, rollback.id, { contentHash: review.contentHash, targetFingerprint: review.targetFingerprint, reviewer: "Reviewer" }, "Admin")
    const backupsBefore = context.backups.length
    const applied = await applyChangeSet(context.deps, TENANT_B, rollback.id, { contentHash: review.contentHash, confirmed: true }, "Admin")
    expect(applied.status).toBe("applied")
    expect(applied.preChange?.backupFolder).toBe("backup-2026-11-03-120000")
    expect(context.backups.slice(backupsBefore)).toEqual([TENANT_B])
    expect(context.tenants[1]!.policies.has(created.id as string)).toBe(false)
    // The recovery covered tenant B only, and ended with the rollback.
    expect(context.recoveryOfOtherTenant.every((value) => !value)).toBe(true)
    await expect(context.authorize(TENANT_B)).rejects.toBeInstanceOf(CommunityLimitError)
    await expect(context.deps.graph(TENANT_B)).rejects.toBeInstanceOf(CommunityLimitError)
  })

  it("keeps refusing a non-rollback change set and any other use of the recovery path in that state", async () => {
    const context = await setup()
    const deployment = await deploy(context, TENANT_B)
    const existing = context.tenants[1]!.addPolicy({ name: "Synthetic policy", settings: [setting(DEF, "fake-off")] })
    const change = await createChangeSet(context.deps, TENANT_B, { title: "Synthetic change", operations: [{ folder: "ConfigurationPolicies", action: "update", targetId: existing.id as string, proposed: { ...structuredClone(existing), description: "changed" } }] }, "Admin")
    const review = await previewChangeSet(context.deps, TENANT_B, change.id)
    await approveChangeSet(context.deps, TENANT_B, change.id, { contentHash: review.contentHash, targetFingerprint: review.targetFingerprint, reviewer: "Reviewer" }, "Admin")
    await context.expire()
    await context.license.requireEntitlement(TENANT_A)
    const writes = context.tenants[1]!.writeCount()
    const backups = context.backups.length

    await expect(previewChangeSet(context.deps, TENANT_B, change.id)).rejects.toBeInstanceOf(CommunityLimitError)
    await expect(applyChangeSet(context.deps, TENANT_B, change.id, { contentHash: review.contentHash, confirmed: true }, "Admin")).rejects.toBeInstanceOf(CommunityLimitError)
    await expect(createChangeSet(context.deps, TENANT_B, { title: "New", operations: [{ folder: "ConfigurationPolicies", action: "update", targetId: existing.id as string, proposed: { ...structuredClone(existing), description: "new" } }] }, "Admin")).rejects.toBeInstanceOf(CommunityLimitError)
    // The recovery scope must name an applied change set of the tenant, and covers the backup paths only.
    await expect(context.deps.graph(TENANT_B, { recovery: { changeSetId: change.id } })).rejects.toThrow(/rollback of an applied change set/)
    await expect(context.deps.graph(TENANT_B, { recovery: { changeSetId: randomUUID() } })).rejects.toThrow(/rollback of an applied change set/)
    const applied = context.deps.records.get<{ changeSetId: string }>("cis-remediations", TENANT_B, deployment.id)!.changeSetId
    await expect(context.deps.graph(TENANT_A, { recovery: { changeSetId: applied } })).rejects.toThrow(/rollback of an applied change set/)
    await expect(context.deps.api("/api/restore-backup", TENANT_B, {}, { recovery: { changeSetId: applied } })).rejects.toThrow(/rollback of an applied change set/)
    // A backup started outside a recovery is refused by the tenant check, as before.
    const started = await (await context.deps.api("/api/backup/start", TENANT_B, {})).json() as { jobId: string }
    const status = await (await context.deps.api("/api/backup/status", TENANT_B, { jobId: started.jobId })).json() as { isSuccessful: boolean; exception: string }
    expect(status).toMatchObject({ isSuccessful: false, exception: expect.stringMatching(/Community covers one tenant/) })
    expect(context.tenants[1]!.writeCount()).toBe(writes)
    expect(context.backups.length).toBe(backups + 1)
  })
})

describe("the recovery backup in the real backup engine and API host", () => {
  const OLD_BACKUP = "backup-2026-08-01-020000"
  const graph = (url: URL) => (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`) || url.pathname.endsWith("/assignments") ? Response.json({ value: [] }) : Response.json({}))

  /**
   * The backup engine, its routes and the API host's plan guard as src/main/index.ts builds them
   * (backupAuthorization, withRecoveryBackups), on encrypted local storage, after the MSP license
   * expired with tenant A holding Community. Community keeps 30 days, so a normal backup of the
   * tenant would delete the August backup.
   */
  async function engineSetup() {
    const { license, expire } = await mspLicense()
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-recovery-")), [randomBytes(32)])
    for (const tenantId of [TENANT_A, TENANT_B, TENANT_C]) {
      const account = localStorageAccountName(tenantId)
      await store.createContainer(account, "intune-backups")
      await store.put(account, "intune-backups", `${OLD_BACKUP}/metadata.json`, Buffer.from("{}"), "application/json")
    }
    const access = backupAuthorization({ license, tokenFor: async () => ({ accessToken: "token" }), retentionDays: () => 30 })
    // The fetch bridge's license check of local backup storage, as createBridgedFetch makes it.
    const storageFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (localAccountFromUrl(url)) {
        try {
          await access.authorizeTenant(localAccountFromUrl(url)!.slice("tvlocal-".length))
        } catch {
          return new Response(null, { status: 403 })
        }
        return handleLocalBlobRequest(store, request)
      }
      return graph(url)
    }) as typeof fetch
    const engine = new BackupEngine({ fetch: storageFetch, getToken: access.getToken, retentionDays: access.retentionDays, now: () => new Date("2026-11-03T12:00:00Z") })
    const host: ApiHost = new ApiHost({
      routes: {
        ...backupRoutes(engine),
        "/api/list-backup-contents": { POST: async () => Response.json({ content: { metadata: COMPLETE_BACKUP_METADATA } }) },
      },
      guard: withRecoveryBackups(planGuard((tenantId) => license.requireEntitlement(tenantId).catch(() => null))),
    })
    const deps = fakeDeps({ plans: { [TENANT_A]: "msp", [TENANT_B]: "msp" } })
    deps.tenant = (tenantId) => ({ tenantId: tenantId.toLowerCase(), name: "Synthetic", clientId: APP_ID, storageAccountName: localStorageAccountName(tenantId) })
    Object.assign(deps, featureAccess({ license, records: deps.records, signedInClient: () => APP_ID, tokenFor: async () => ({ accessToken: "token" }), fetch: storageFetch, dispatch: (request) => host.dispatch(request), tenantProfile: deps.tenant }))
    // An applied change set of tenant B, the scope its rollback recovers.
    const applied = deps.records.create(DOMAINS.changeSets, TENANT_B, { kind: "change", preChange: { capturedAt: "2026-10-01T00:00:00Z", backupFolder: "backup-2026-10-01-000000", captureId: "c", objects: [] } }, { actor: null, reason: "seeded" })
    await expect(license.requireEntitlement(TENANT_A)).resolves.toBe("msp")
    await expire()
    await expect(license.requireEntitlement(TENANT_A)).resolves.toBe("community")
    const folders = async (tenantId: string) => [...new Set((await store.list(localStorageAccountName(tenantId), "intune-backups")).map((blob) => blob.name.split("/")[0]))].sort()
    const start = async (tenantId: string, recovery?: { changeSetId: string }) => {
      const response = await (recovery ? deps.api("/api/backup/start", tenantId, {}, { recovery }) : deps.api("/api/backup/start", tenantId, {}))
      const { jobId } = await response.json() as { jobId: string }
      return engine.waitForJob(engine.get(jobId)!)
    }
    return { engine, deps, scope: { changeSetId: applied.id }, folders, start }
  }

  it("runs a rollback's backup for a tenant outside Community without deleting older backups, queued or not", async () => {
    const context = await engineSetup()
    // Tenant A's backup runs first, so the recovery backup of tenant B is queued behind it.
    const first = context.start(TENANT_A)
    const recovery = await context.start(TENANT_B, context.scope)
    expect(recovery.status).toBe("Completed")
    expect(await context.folders(TENANT_B)).toEqual([OLD_BACKUP, recovery.backupFolder])
    // Tenant A's own backup is not a recovery: Community retention applies to it.
    const owner = await first
    expect(owner.status).toBe("Completed")
    expect(await context.folders(TENANT_A)).toEqual([owner.backupFolder])
  })

  it("gives no bypass to a backup outside the recovery, also one started while it runs or after it", async () => {
    const context = await engineSetup()
    const recovery = context.start(TENANT_B, context.scope)
    // A start from outside while it runs joins the same job and starts no run of its own.
    const joining = context.start(TENANT_B)
    // Another tenant's backup queued behind the recovery backup runs without it: its license
    // check refuses it at the first storage or token request, and nothing is written for it.
    const queued = await context.start(TENANT_C)
    expect(queued.status).toBe("Failed")
    expect(await context.folders(TENANT_C)).toEqual([OLD_BACKUP])
    const joined = await joining
    const recovered = await recovery
    expect(recovered.status).toBe("Completed")
    expect(joined.id).toBe(recovered.id)
    const later = await context.start(TENANT_B)
    // A later backup outside a recovery is refused by the license check again.
    expect(later.status).toBe("Failed")
    expect(await context.folders(TENANT_B)).toHaveLength(2)
  })

  it("lets the plan guard pass only the recovering tenant's backup requests", async () => {
    // Tenant A holds Community after the MSP license ended, and its backups go to Azure Storage,
    // which Community does not include: the plan guard refuses its backups with 402.
    const { license, expire } = await mspLicense()
    await expire()
    await expect(license.requireEntitlement(TENANT_A)).resolves.toBe("community")
    const deps = fakeDeps({ plans: { [TENANT_A]: "msp" } })
    const applied = deps.records.create(DOMAINS.changeSets, TENANT_A, { kind: "change", preChange: { capturedAt: "2026-10-01T00:00:00Z", backupFolder: "backup-2026-10-01-000000", captureId: "c", objects: [] } }, { actor: null, reason: "seeded" })
    const guard = withRecoveryBackups(planGuard((tenantId) => license.requireEntitlement(tenantId).catch(() => null)))
    const access = featureAccess({
      license, records: deps.records, signedInClient: () => APP_ID, tokenFor: async () => ({ accessToken: "token" }), fetch,
      dispatch: async (request) => (await guard(request)) ?? Response.json({ admitted: true }),
      tenantProfile: () => ({ clientId: APP_ID, storageAccountName: "contosobackups" }),
    })
    const recovery = { changeSetId: applied.id }
    expect((await access.api("/api/backup/start", TENANT_A, {})).status).toBe(402)
    expect((await access.api("/api/backup/start", TENANT_A, {}, { recovery })).status).toBe(200)
    expect((await access.api("/api/backup/start", TENANT_A, { bulk: true }, { recovery })).status).toBe(402)
    expect((await access.api("/api/restore-backup", TENANT_A, { restoreType: "full" })).status).toBe(402)
    await expect(access.api("/api/restore-backup", TENANT_A, { restoreType: "full" }, { recovery })).rejects.toThrow(/rollback of an applied change set/)
    // Outside the recovery the same backup request is refused again.
    expect((await access.api("/api/backup/start", TENANT_A, {})).status).toBe(402)
  })
})
