import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BackupEngine, CONSECUTIVE_AUTH_FAILURE_LIMIT, NetworkCircuit, safeFileName, verifyStorageAccess } from "../src/main/backup/engine"
import { backupRoutes, jobStatus, surfaceTokenErrors } from "../src/main/api/desktop-routes"
import { NextRequest } from "../src/main/api/next-server-shim"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"

function fakeGraph(overrides: Record<string, Response | (() => Response)> = {}) {
  const pages: Record<string, unknown> = {
    "/beta/deviceManagement/deviceConfigurations": {
      value: [{ id: "dc1", displayName: "Win: BitLocker/Encryption" }],
      "@odata.nextLink": "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations?page=2",
    },
    "/beta/deviceManagement/deviceConfigurations?page=2": { value: [{ id: "dc2", displayName: "Win: BitLocker/Encryption" }] },
    "/beta/deviceManagement/deviceCompliancePolicies": { value: [{ id: "cp1", displayName: "Compliance" }] },
    "/beta/deviceManagement/configurationPolicies": { value: [{ id: "sc1", name: "Settings catalog" }] },
  }
  return (url: URL) => {
    const key = url.pathname.replace(/^\//, "/") + url.search
    const override = overrides[key]
    if (override) return typeof override === "function" ? override() : override
    if (key in pages) return Response.json(pages[key])
    if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
    if (url.pathname.endsWith("/assignments")) return Response.json({ value: [] })
    const id = url.pathname.split("/").pop()
    return Response.json({ "@odata.context": "ctx", id, detail: true })
  }
}

function setup(graph = fakeGraph(), concurrency?: number) {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-engine-")), [randomBytes(32)])
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
    if (url.hostname === "graph.microsoft.com") return graph(url)
    throw new Error(`unexpected ${url}`)
  }) as unknown as typeof fetch
  const getToken = vi.fn(async () => "token")
  const engine = new BackupEngine({ fetch: fetchImpl, getToken, ...(concurrency === undefined ? {} : { concurrency }) })
  return { engine, store, getToken, account: localStorageAccountName(TENANT) }
}

/** The job once its run has settled, including anything it records after it stopped. */
async function finished(engine: BackupEngine, id: string) {
  return engine.waitForJob(engine.get(id)!)
}

describe("BackupEngine", () => {
  it("keeps every policy when names and id prefixes repeat", async () => {
    // Intune's default enrollment configurations share a display name and the tenant GUID id prefix.
    const prefix = "7192bb9f-ffa6-4f50-9176-7603cd9450d6"
    const defaults = ["DefaultLimit", "DefaultPlatformRestrictions", "DefaultWindowsHelloForBusiness", "WindowsRestore"]
    const { engine, store, account } = setup(fakeGraph({
      "/beta/deviceManagement/deviceEnrollmentConfigurations": Response.json({
        value: defaults.map((name) => ({ id: `${prefix}_${name}`, displayName: "All users and all devices" })),
      }),
    }))
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)

    const enrollment = (await store.list(account, "intune-backups")).filter((b) => b.name.includes("/EnrollmentConfigurations/"))
    expect(enrollment).toHaveLength(defaults.length)
    const metadata = JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString())
    expect(metadata.ItemCounts.EnrollmentConfigurations).toBe(defaults.length)
  })

  it("fails a backup when none of its policy reads succeeded", async () => {
    const denied = () => Response.json({ error: { message: "Forbidden" } }, { status: 403 })
    const { engine, store, account } = setup(fakeGraph({
      "/beta/deviceManagement/deviceConfigurations/dc1?$expand=assignments": denied,
      "/beta/deviceManagement/deviceConfigurations/dc2?$expand=assignments": denied,
      "/beta/deviceManagement/deviceCompliancePolicies/cp1?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations),assignments": denied,
      "/beta/deviceManagement/configurationPolicies/sc1?$expand=settings": denied,
    }))
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    expect(job.status).toBe("Failed")
    const metadata = JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString())
    expect(metadata).toMatchObject({ Status: "Failed", Failures: 4 })
  })

  it("writes the runbook's backup layout to local encrypted storage", async () => {
    const { engine, store, account, getToken } = setup()
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)

    expect(job.status).toBe("Completed")
    const names = (await store.list(account, "intune-backups")).map((b) => b.name.replace(/^backup-[\d-]+\//, ""))
    expect(names.sort()).toEqual([
      ".tenuvault-owner.json",
      "CompliancePolicies/Compliance.json",
      "ConfigurationPolicies/Settings catalog.json",
      "DeviceConfigurations/Win_ BitLocker_Encryption (dc2).json",
      "DeviceConfigurations/Win_ BitLocker_Encryption.json",
      "metadata.json",
    ])
    const metadata = JSON.parse(
      (await store.get(account, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString(),
    ) as { ItemCounts: Record<string, number>; Status: string }
    expect(metadata.ItemCounts).toEqual({
      ...Object.fromEntries(INTUNE_TYPES.map((type) => [type.folder, 0])),
      DeviceConfigurations: 2,
      CompliancePolicies: 1,
      ConfigurationPolicies: 1,
      TotalPolicies: 4,
    })
    expect(metadata.Status).toBe("Success")
    const detail = JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/CompliancePolicies/Compliance.json`)).data.toString())
    expect(detail).toEqual({ id: "cp1", detail: true })
    // Local storage needs no Azure Storage token.
    expect(getToken.mock.calls.every((call) => (call as string[])[2] !== "https://storage.azure.com/.default")).toBe(true)
  })

  it("retries throttled Graph requests and reports per-policy failures as warnings", async () => {
    let throttled = 0
    const graph = fakeGraph({
      "/beta/deviceManagement/deviceCompliancePolicies/cp1?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations),assignments": () =>
        throttled++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "0.001" } }) : Response.json({ id: "cp1" }),
      "/beta/deviceManagement/configurationPolicies/sc1?$expand=settings": () =>
        Response.json({ error: { message: "Forbidden" } }, { status: 403 }),
    })
    const { engine } = setup(graph)
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: localStorageAccountName(TENANT) }).id)
    expect(job.status).toBe("Completed")
    expect(job.progressMessage).toBe("Backup completed with 1 warning")
    expect(job.log.join("\n")).toMatch(/Could not back up "Settings catalog": Access denied by Microsoft Graph/)
    expect(throttled).toBe(2)
  })

  it("fails the job with the reason when Graph cannot be read", async () => {
    const graph = fakeGraph({ "/beta/deviceManagement/deviceConfigurations": () => new Response("", { status: 401 }) })
    const { engine } = setup(graph)
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: localStorageAccountName(TENANT) }).id)
    expect(job.status).toBe("Failed")
    expect(jobStatus(job)).toMatchObject({ isComplete: true, isSuccessful: false, progress: 100 })
  })

  it("stops with one clear error when sign-in is needed mid-backup", async () => {
    const { engine, getToken } = setup()
    let calls = 0
    getToken.mockImplementation(async () => {
      if (++calls > 4) throw new Error("Sign in again to continue.")
      return "token"
    })
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: localStorageAccountName(TENANT) }).id)
    expect(job.status).toBe("Failed")
    expect(job.exception).toBe("Sign in again to continue.")
    expect(job.log.filter((line) => line.includes("Could not back up"))).toHaveLength(0)
  })

  it("refuses storage account names that are not Azure or local accounts", async () => {
    const { engine } = setup()
    for (const name of ["attacker.example/", "evil.com#", "UPPER"]) {
      const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: name }).id)
      expect(job.status).toBe("Failed")
      expect(job.exception).toMatch(/Invalid storage account name/)
    }
  })

  it("mirrors the runbook's file name rules", () => {
    expect(safeFileName('  Win: "Edge" <policy>  ')).toBe("Win_ _Edge_ _policy_")
    expect(safeFileName("a".repeat(250))).toHaveLength(200)
  })
})

describe("backup routes", () => {
  it("start the engine and report its progress", async () => {
    const { engine, account } = setup()
    const routes = backupRoutes(engine)
    const post = (path: string, body: object) =>
      routes[path]!.POST!(new NextRequest(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }))

    expect((await post("/api/backup/start", { tenantId: TENANT })).status).toBe(400)
    const started = (await (await post("/api/backup/start", { tenantId: TENANT, appId: CLIENT, storageAccountName: account })).json()) as { jobId: string }
    expect(started.jobId).toMatch(/^desktop-/)
    await finished(engine, started.jobId)
    expect(await (await post("/api/backup/status", { jobId: started.jobId })).json()).toMatchObject({ isComplete: true, isSuccessful: true })
    expect((await post("/api/backup/status", { jobId: "unknown" })).status).toBe(404)
  })
})

describe("surfaceTokenErrors", () => {
  it("shows the identity error instead of a generic message", async () => {
    const response = Response.json(
      { error: "Failed to authenticate with Azure", details: JSON.stringify({ error: "interaction_required", error_description: "Sign in again as admin@contoso.com." }) },
      { status: 401 },
    )
    expect(await (await surfaceTokenErrors(response)).json()).toMatchObject({ error: "Sign in again as admin@contoso.com." })
  })

  it("leaves other responses alone", async () => {
    const ok = Response.json({ fine: true })
    expect(await surfaceTokenErrors(ok)).toBe(ok)
  })
})

describe("retention", () => {
  it("deletes backups older than the retention period after a backup, keeping newer ones", async () => {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-retention-")), [randomBytes(32)])
    const account = localStorageAccountName(TENANT)
    await store.createContainer(account, "intune-backups")
    for (const folder of ["backup-2026-08-01-020000", "backup-2026-09-20-020000"]) {
      await store.put(account, "intune-backups", `${folder}/metadata.json`, Buffer.from("{}"), "application/json")
      await store.put(account, "intune-backups", `${folder}/CompliancePolicies/A.json`, Buffer.from("{}"), "application/json")
    }
    const graph = fakeGraph()
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      return localAccountFromUrl(url) ? handleLocalBlobRequest(store, request) : graph(url)
    }) as typeof fetch
    const engine = new BackupEngine({
      fetch: fetchImpl,
      getToken: async () => "token",
      retentionDays: () => 30,
      now: () => new Date("2026-09-24T12:00:00Z"),
    })
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    expect(job.status).toBe("Completed")
    expect(job.log.join("\n")).toContain("Removed 1 backup older than 30 days.")
    const folders = new Set((await store.list(account, "intune-backups")).map((b) => b.name.split("/")[0]))
    expect([...folders].sort()).toEqual(["backup-2026-09-20-020000", "backup-2026-09-24-120000"])
  })
})

describe("retention and storage protection", () => {
  async function run(protectedName: string) {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-retention-")), [randomBytes(32)])
    const account = localStorageAccountName(TENANT)
    await store.createContainer(account, "intune-backups")
    const old = "backup-2026-08-01-020000"
    await store.put(account, "intune-backups", `${old}/metadata.json`, Buffer.from(JSON.stringify({ Status: "Success", TenantId: TENANT })), "application/json")
    await store.put(account, "intune-backups", `${old}/CompliancePolicies/A.json`, Buffer.from("{}"), "application/json")
    await store.put(account, "intune-backups", `${old}/DeviceConfigurations/B.json`, Buffer.from("{}"), "application/json")
    const graph = fakeGraph()
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (request.method === "DELETE" && decodeURIComponent(url.pathname).endsWith(`${old}/${protectedName}`)) {
        return new Response("<Error><Code>BlobImmutableDueToPolicy</Code></Error>", { status: 409, headers: { "x-ms-error-code": "BlobImmutableDueToPolicy" } })
      }
      return localAccountFromUrl(url) ? handleLocalBlobRequest(store, request) : graph(url)
    }) as typeof fetch
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, now: () => new Date("2026-09-24T12:00:00Z") })
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    const left = (await store.list(account, "intune-backups")).map((b) => b.name).filter((name) => name.startsWith(old)).sort()
    return { job, left, old }
  }

  it("touches no policy file when the metadata of an old backup is protected", async () => {
    const { job, left, old } = await run("metadata.json")
    expect(job.log.join("\n")).toContain("Kept 1 older backup protected")
    expect(left).toEqual([`${old}/CompliancePolicies/A.json`, `${old}/DeviceConfigurations/B.json`, `${old}/metadata.json`])
  })

  it("removes the metadata first, so a partly deleted backup is not reported as complete", async () => {
    const { job, left, old } = await run("DeviceConfigurations/B.json")
    expect(job.log.join("\n")).toContain("no longer offered as complete")
    expect(left).toEqual([`${old}/DeviceConfigurations/B.json`])
  })
})

describe("retention after incomplete backups", () => {
  it("keeps every older backup when the new backup has failures", async () => {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-retention-")), [randomBytes(32)])
    const account = localStorageAccountName(TENANT)
    await store.createContainer(account, "intune-backups")
    await store.put(account, "intune-backups", "backup-2026-08-01-020000/metadata.json", Buffer.from("{}"), "application/json")
    const graph = fakeGraph({ "/beta/deviceManagement/deviceCompliancePolicies/cp1?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations),assignments": () => Response.json({ error: { message: "Forbidden" } }, { status: 403 }) })
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      return localAccountFromUrl(url) ? handleLocalBlobRequest(store, request) : graph(url)
    }) as typeof fetch
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", retentionDays: () => 30, now: () => new Date("2026-09-24T12:00:00Z") })
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    expect(job.log.join("\n")).toContain("Older backups were kept because this backup is incomplete.")
    expect((await store.list(account, "intune-backups")).some((b) => b.name.startsWith("backup-2026-08-01"))).toBe(true)
  })

  it("stores encrypted OMA-URI values, per-entry collections and selected properties", async () => {
    const graph = fakeGraph({
      "/beta/deviceManagement/deviceConfigurations": Response.json({ value: [{ id: "dc1", displayName: "Secret" }] }),
      "/beta/deviceManagement/deviceConfigurations/dc1?$expand=assignments": Response.json({
        id: "dc1",
        displayName: "Secret",
        omaSettings: [{ omaUri: "./x", isEncrypted: true, secretReferenceValueId: "s1", value: "****" }],
      }),
      "/beta/deviceManagement/deviceConfigurations/dc1/getOmaSettingPlainTextValue(secretReferenceValueId='s1')": Response.json({ value: "<enabled/>" }),
      "/beta/deviceManagement/groupPolicyConfigurations": Response.json({ value: [{ id: "gp1", displayName: "ADMX" }] }),
      "/beta/deviceManagement/groupPolicyConfigurations/gp1/definitionValues?$expand=definition($select=id,displayName,classType,categoryPath)": Response.json({ value: [{ id: "dv1", enabled: true }] }),
      "/beta/deviceManagement/groupPolicyConfigurations/gp1/definitionValues/dv1/presentationValues?$expand=presentation($select=id,label)": Response.json({ value: [{ id: "pv1", value: "x" }] }),
      "/beta/deviceManagement/reusablePolicySettings": Response.json({ value: [{ id: "r1", displayName: "Reusable" }] }),
    })
    const { engine, store, account } = setup(graph)
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    const read = async (name: string) => JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/${name}`)).data.toString())
    expect((await read("DeviceConfigurations/Secret.json")).omaSettings[0].value).toBe("<enabled/>")
    expect((await read("GroupPolicyConfigurations/ADMX.json")).definitionValues).toEqual([{ id: "dv1", enabled: true, presentationValues: [{ id: "pv1", value: "x" }] }])
    const fetched = (engine as unknown as { deps: { fetch: { mock: { calls: unknown[][] } } } }).deps.fetch.mock.calls.map((call) => decodeURIComponent(String(call[0])))
    expect(fetched.some((url) => url.includes("reusablePolicySettings/r1?$select=id,displayName,description,settingDefinitionId,settingInstance"))).toBe(true)
  })

  it("skips a newly supported type the app registration has no permission for, without blocking retention", async () => {
    const graph = fakeGraph({ "/beta/deviceManagement/deviceManagementScripts": () => Response.json({ error: { message: "Forbidden" } }, { status: 403 }) })
    const { engine, store, account } = setup(graph)
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    expect(job.progressMessage).toBe("Backup completed successfully")
    expect(job.log.join("\n")).toMatch(/Skipped Windows PowerShell scripts: access was denied/)
    const metadata = JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString())
    expect(metadata).toMatchObject({ Status: "Success", Failures: 0, SkippedTypes: ["PowerShellScripts"] })
  })

  it("backs up administrative templates with paged assignments, definitions and presentation values", async () => {
    const base = "/beta/deviceManagement/groupPolicyConfigurations"
    const next = (path: string) => `https://graph.microsoft.com${path}`
    const presentation = (id: string, value: string) => ({
      id, "@odata.type": "#microsoft.graph.groupPolicyPresentationValueText",
      value, presentation: { id: `definition-${id}`, label: "Text" },
    })
    const pages: Record<string, unknown> = {
      [base]: { value: [{ id: "gp1", displayName: "Template" }], "@odata.nextLink": next(`${base}?page=2`) },
      [`${base}?page=2`]: { value: [{ id: "gp2", displayName: "Empty template" }] },
      [`${base}/gp1?$expand=assignments`]: {
        id: "gp1", displayName: "Template", assignments: [{ id: "a1" }],
        "assignments@odata.nextLink": next(`${base}/gp1/assignments?page=2`),
      },
      [`${base}/gp1/assignments?page=2`]: { value: [{ id: "a2" }] },
      [`${base}/gp1/definitionValues?$expand=definition($select=id,displayName,classType,categoryPath)`]: {
        value: [{ id: "dv1", enabled: true, configurationType: "policy", definition: { id: "def1", categoryPath: null } }],
        "@odata.nextLink": next(`${base}/gp1/definitionValues?page=2`),
      },
      [`${base}/gp1/definitionValues?page=2`]: {
        value: [{ id: "dv2", enabled: false, configurationType: "policy", definition: { id: "def2" } }],
      },
      [`${base}/gp1/definitionValues/dv1/presentationValues?$expand=presentation($select=id,label)`]: {
        value: [presentation("pv1", "First")],
        "@odata.nextLink": next(`${base}/gp1/definitionValues/dv1/presentationValues?page=2`),
      },
      [`${base}/gp1/definitionValues/dv1/presentationValues?page=2`]: { value: [presentation("pv2", "Second")] },
      [`${base}/gp1/definitionValues/dv2/presentationValues?$expand=presentation($select=id,label)`]: { value: [] },
      [`${base}/gp2?$expand=assignments`]: { id: "gp2", displayName: "Empty template", assignments: [] },
      [`${base}/gp2/definitionValues?$expand=definition($select=id,displayName,classType,categoryPath)`]: { value: [] },
    }
    const { engine, store, account } = setup(fakeGraph(Object.fromEntries(
      Object.entries(pages).map(([path, body]) => [path, Response.json(body)]),
    )))
    // The default scope must include templates, without opting in explicitly.
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    const read = async (file: string) => JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/${file}`)).data.toString())
    expect(await read("GroupPolicyConfigurations/Template.json")).toEqual({
      id: "gp1", displayName: "Template", assignments: [{ id: "a1" }, { id: "a2" }],
      definitionValues: [
        { id: "dv1", enabled: true, configurationType: "policy", definition: { id: "def1", categoryPath: null }, presentationValues: [presentation("pv1", "First"), presentation("pv2", "Second")] },
        { id: "dv2", enabled: false, configurationType: "policy", definition: { id: "def2" }, presentationValues: [] },
      ],
    })
    expect(await read("GroupPolicyConfigurations/Empty template.json")).toMatchObject({ assignments: [], definitionValues: [] })
    expect(await read("metadata.json")).toMatchObject({ Status: "Success", ItemCounts: { GroupPolicyConfigurations: 2 } })
  })

  it.each(["list", "definitions", "presentations"])("reports an incomplete backup when administrative template %s cannot be read", async (stage) => {
    const base = "/beta/deviceManagement/groupPolicyConfigurations"
    const definitions = `${base}/gp1/definitionValues?$expand=definition($select=id,displayName,classType,categoryPath)`
    const presentations = `${base}/gp1/definitionValues/dv1/presentationValues?$expand=presentation($select=id,label)`
    const { engine, store, account } = setup(fakeGraph({
      [base]: Response.json({ value: [{ id: "gp1", displayName: "Template" }] }),
      [definitions]: Response.json({ value: [{ id: "dv1", enabled: true, definition: { id: "def1" } }] }),
      [stage === "list" ? base : stage === "definitions" ? definitions : presentations]:
        () => Response.json({ error: { code: "Forbidden", message: "Access denied" } }, { status: 403 }),
    }))
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    const metadata = JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString())
    expect(metadata).toMatchObject({
      Status: "CompletedWithWarnings", Failures: 1, SkippedTypes: [],
      FailedTypes: stage === "list" ? ["GroupPolicyConfigurations"] : [],
      ItemCounts: { GroupPolicyConfigurations: 0 },
    })
    expect(job.log.join("\n")).toContain("Older backups were kept because this backup is incomplete.")
    expect((await store.list(account, "intune-backups")).some((blob) => blob.name.includes("/GroupPolicyConfigurations/"))).toBe(false)
  })
})

describe("consecutive authorization failures", () => {
  const GUIDANCE = "Check that your account has an Intune role and the app registration has the Intune permissions."

  it("aborts after the limit of identical status failures and resets on success or a different status", () => {
    const circuit = new NetworkCircuit(100)
    for (let i = 0; i < CONSECUTIVE_AUTH_FAILURE_LIMIT - 1; i++) circuit.authFailed("Microsoft Graph", 403, GUIDANCE)
    circuit.succeeded("Microsoft Graph")
    for (let i = 0; i < CONSECUTIVE_AUTH_FAILURE_LIMIT - 1; i++) circuit.authFailed("Microsoft Graph", 403, GUIDANCE)
    expect(circuit.signal.aborted).toBe(false)
    circuit.authFailed("Microsoft Graph", 401, GUIDANCE)
    for (let i = 0; i < CONSECUTIVE_AUTH_FAILURE_LIMIT - 1; i++) circuit.authFailed("Microsoft Graph", 403, GUIDANCE)
    expect(circuit.signal.aborted).toBe(false)
    expect(() => circuit.authFailed("Microsoft Graph", 403, GUIDANCE)).toThrow(GUIDANCE)
    expect(circuit.signal.aborted).toBe(true)
  })

  it("stops reading further policies after repeated Graph 403 responses", async () => {
    let attempts = 0
    const denied = () => {
      attempts++
      return Response.json({ error: { message: "Forbidden" } }, { status: 403 })
    }
    const overrides: Record<string, () => Response> = {
      "/beta/deviceManagement/deviceConfigurations": () =>
        Response.json({ value: Array.from({ length: 8 }, (_, i) => ({ id: `dc${i + 1}`, displayName: `Policy ${i + 1}` })) }),
    }
    for (let i = 1; i <= 8; i++) overrides[`/beta/deviceManagement/deviceConfigurations/dc${i}?$expand=assignments`] = denied
    const { engine, account } = setup(fakeGraph(overrides), 1)
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain(GUIDANCE)
    expect(attempts).toBe(CONSECUTIVE_AUTH_FAILURE_LIMIT)
  })

  it("does not abort when successes are interleaved with Graph 403 responses", async () => {
    let attempts = 0
    const overrides: Record<string, () => Response> = {
      "/beta/deviceManagement/deviceConfigurations": () =>
        Response.json({ value: Array.from({ length: 8 }, (_, i) => ({ id: `dc${i + 1}`, displayName: `Policy ${i + 1}` })) }),
    }
    for (let i = 1; i <= 8; i++) {
      const index = i
      overrides[`/beta/deviceManagement/deviceConfigurations/dc${index}?$expand=assignments`] = () => {
        attempts++
        return index % 2 === 1 ? Response.json({ error: { message: "Forbidden" } }, { status: 403 }) : Response.json({ id: `dc${index}`, detail: true })
      }
    }
    const { engine, account } = setup(fakeGraph(overrides), 1)
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    expect(job.status).toBe("Completed")
    expect(job.exception).toBeUndefined()
    expect(attempts).toBe(8)
  })

  it("still skips types the app registration has no permission for instead of aborting", async () => {
    const denied = () => Response.json({ error: { message: "Forbidden" } }, { status: 403 })
    const { engine, store, account } = setup(fakeGraph({
      "/beta/deviceManagement/reusablePolicySettings": denied,
      "/beta/deviceManagement/hardwareConfigurations": denied,
      "/beta/deviceManagement/deviceComplianceScripts": denied,
      "/beta/deviceManagement/intents": denied,
      "/beta/deviceManagement/deviceManagementScripts": denied,
      "/beta/deviceManagement/deviceShellScripts": denied,
    }))
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }).id)
    expect(job.status).toBe("Completed")
    expect(job.progressMessage).toBe("Backup completed successfully")
    const metadata = JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString())
    expect(metadata.SkippedTypes).toHaveLength(6)
    expect(metadata).toMatchObject({ Status: "Success", Failures: 0 })
  })

  it("stops writing further policies after repeated storage 403 responses", async () => {
    let attempts = 0
    const graph = fakeGraph({
      "/beta/deviceManagement/deviceConfigurations": Response.json({
        value: Array.from({ length: 8 }, (_, i) => ({ id: `dc${i + 1}`, displayName: `Policy ${i + 1}` })),
      }),
    })
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname === "graph.microsoft.com") return graph(url)
      if (url.searchParams.get("restype") === "container") return new Response(null, { status: 201 })
      if (url.pathname.endsWith(".tenuvault-owner.json")) return new Response(null, { status: 201 })
      attempts++
      return new Response("<Error><Code>AuthorizationPermissionMismatch</Code><Message>denied</Message></Error>", { status: 403 })
    }) as typeof fetch
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", concurrency: 1 })
    const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: "example" }).id)
    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("Storage Blob Data Contributor")
    expect(attempts).toBe(CONSECUTIVE_AUTH_FAILURE_LIMIT)
  })
})

describe("verifyStorageAccess", () => {
  const storageFailure = (code: string) => async () =>
    new Response(`<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>denied</Message></Error>`, { status: 403 })

  it("names the missing role when Azure RBAC denies the write", async () => {
    const outcome = verifyStorageAccess(storageFailure("AuthorizationPermissionMismatch") as typeof fetch, "contoso", async () => "token")
    await expect(outcome).rejects.toThrow(/Storage Blob Data Contributor/)
  })

  it("points at the storage firewall when network rules reject the request", async () => {
    const outcome = verifyStorageAccess(storageFailure("AuthorizationFailure") as typeof fetch, "contoso", async () => "token")
    await expect(outcome).rejects.toThrow(/networking settings/)
  })
})
it('never uploads decrypted OMA-URI secrets as plaintext to Azure', async () => {
  const { encryptedAzureFetch, registerStorageToken, openAzure } = await import('../src/main/storage/azure-seal')
  const key = Buffer.alloc(32, 9), uploads: { url: URL; body: Buffer }[] = []
  const graph = fakeGraph({
    '/beta/deviceManagement/deviceConfigurations': Response.json({ value: [{ id: 'dc1', displayName: 'Secret' }] }),
    '/beta/deviceManagement/deviceConfigurations/dc1?$expand=assignments': Response.json({ id: 'dc1', displayName: 'Secret', omaSettings: [{ omaUri: './x', isEncrypted: true, secretReferenceValueId: 's1', value: '****' }] }),
    "/beta/deviceManagement/deviceConfigurations/dc1/getOmaSettingPlainTextValue(secretReferenceValueId='s1')": Response.json({ value: 'dummy-oma-secret' }),
  })
  registerStorageToken('storage-token', TENANT)
  const fetch = encryptedAzureFetch(async input => {
    const request = input as Request, url = new URL(request.url)
    if (url.hostname === 'graph.microsoft.com') return graph(url)
    if (request.method === 'PUT' && url.pathname.startsWith('/intune-backups/')) uploads.push({ url, body: Buffer.from(await request.arrayBuffer()) })
    return new Response(null, { status: 201 })
  }, () => [key], () => {})
  const engine = new BackupEngine({ fetch, getToken: async () => 'storage-token' })
  const job = await finished(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: 'example' }).id)
  expect(job.status).toBe('Completed')
  expect(uploads.length).toBeGreaterThan(0)
  expect(uploads.every(item => !item.body.includes(Buffer.from('dummy-oma-secret')))).toBe(true)
  const secret = uploads.find(item => item.url.pathname.endsWith('/DeviceConfigurations/Secret.json'))!
  expect(openAzure(secret.body, [key], TENANT, secret.url).data.toString()).toContain('dummy-oma-secret')
})
