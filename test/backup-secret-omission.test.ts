import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackupEngine } from "../src/main/backup/engine"
import { backupGaps } from "../src/main/backup/completeness"
import { configuredCloudPolicyAccount, OmissionPolicyStore } from "../src/main/backup/omission-policy"
import { importArchive, reviewArchive } from "../src/main/backup/archive"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST as restore } from "../src/portal/app/api/restore-backup/route"
import { POST as preview } from "../src/portal/app/api/restore-preview/route"
import { POST as revert } from "../src/portal/app/api/revert-policy/route"
import { POST as download } from "../src/portal/app/api/download-backup/route"
import { compareObjects, POST as scan } from "../src/portal/app/api/detect-drifts/route"
import { compareBackupFiles } from "../src/portal/lib/policies/compare-backups"
import { snapshotHash, verifyProjectedSnapshot } from "../src/portal/lib/policies/backup-manifest"
import { Restorer, type GraphCall } from "../src/portal/lib/policies/graph-restore"
import { buildChangeReport, changeReportMarkdown } from "../src/shared/reports/change-report"
import { compareBackups } from "../src/shared/intune/backup-changes"
import { INTUNE_TYPES, typeForFolder, type Item } from "../src/shared/intune/registry"
import { restorableFolders } from "../src/shared/intune/scope"
import { buildRestorePlan, buildUpdatePlan, restoreBlocker } from "../src/shared/intune/restore-plan"
import { OMISSION_BLOCKER, omissionBody, projectSecrets } from "../src/shared/intune/secret-omission"
import { POST as listBackups } from "../src/portal/app/api/list-backups/route"
import { backupRoutes } from "../src/main/api/desktop-routes"
import { readObject } from "../src/shared/intune/read"
import { memoryStore } from "./helpers"
import { REFERENCE_SETTING_VALUE } from "../src/shared/intune/dependencies"
import rules from "../src/shared/intune/secret-rules.json"

const CANARY = "omission-test-value-397c6d"
const REF = "omission-test-secret-reference"
const TENANT = "11111111-1111-1111-1111-111111111111"
const CONTAINER = "intune-backups"
const ACCOUNT = `tvlocal-${TENANT}`
const FOLDER = "DeviceConfigurations"
const TYPE = typeForFolder(FOLDER)!
const config = (value = CANARY, kept = 1): Item => ({
  id: "policy", displayName: "Baseline", "@odata.type": "#microsoft.graph.windows10CustomConfiguration",
  omaSettings: [
    { "@odata.type": "#microsoft.graph.omaSettingString", omaUri: "./Secret", isEncrypted: true, value, secretReferenceValueId: REF },
    { "@odata.type": "#microsoft.graph.omaSettingInteger", omaUri: "./Kept", value: kept },
  ],
})
const typed = { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSecretSettingValue", value: CANARY, valueState: "encrypted" }
const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh"].find(existsSync)
const rootPaths: string[] = []
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "tv-omit-"))
  rootPaths.push(root)
  return root
}
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(rootPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const credentials = [
  "iosVpnConfiguration", "iosVpnConfiguration", "iosVpnConfiguration", "iosEasEmailProfileConfiguration",
  "androidForWorkImportedPFXCertificateProfile", "androidForWorkImportedPFXCertificateProfile",
  "iosPkcsCertificateProfile", "iosPkcsCertificateProfile", "iosScepCertificateProfile", "depOnboardingSetting",
  "depOnboardingSetting", "deviceEnrollmentConfiguration", "windowsAutopilotDeviceIdentity",
]
const credentialCases = rules.credentials.map((rule, index) => ({
  folder: rule.folder, scripts: false,
  snapshot: { "@odata.type": `#microsoft.graph.${credentials[index]}`, [rule.field]: CANARY },
  field: rule.field,
}))

describe("shared omission rules", () => {
  it.each(credentialCases)("leaves $field out of $folder", ({ folder, snapshot, field }) => {
    expect(projectSecrets(folder, snapshot, false)).toEqual({
      snapshot: { "@odata.type": snapshot["@odata.type"] },
      fields: [{ path: `/${field}`, reason: "credential" }],
    })
  })

  it.each(rules.androidFields)("leaves Android enrollment %s out", (field) => {
    expect(projectSecrets("AndroidEnrollmentProfiles", { [field]: CANARY }, false).fields).toEqual([{ path: `/${field}`, reason: "enrollment-credential" }])
  })

  it.each(Object.entries(rules.scripts))("only leaves %s bodies out when requested", (folder, fields) => {
    const snapshot = Object.fromEntries(fields.map((field) => [field, CANARY]))
    expect(projectSecrets(folder, snapshot, false)).toEqual({ snapshot, fields: [] })
    expect(Object.keys(projectSecrets(folder, snapshot, true).snapshot)).toEqual([])
  })

  const omaSubtypes = [
    ["omaSettingString", "****"],
    ["omaSettingStringXml", "PGEvPg=="],
    ["omaSettingBase64", "KioqKg=="],
    ["omaSettingFuture", CANARY],
  ] as const

  it.each(omaSubtypes)("omits %s without requesting plaintext and tracks a refused hydration", async (subtype, placeholder) => {
    const snapshot = { id: "policy", omaSettings: [{ "@odata.type": `#microsoft.graph.${subtype}`, isEncrypted: true, value: placeholder, secretReferenceValueId: REF }] }
    const reader = {
      get: vi.fn(async (path: string) => {
        if (path.includes("getOmaSettingPlainTextValue")) throw new Error("Access refused")
        return structuredClone(snapshot)
      }),
      list: async () => [],
    }
    const unhydrated = await readObject(TYPE, "policy", reader, { omitEncryptedOma: true })
    expect(reader.get).toHaveBeenCalledTimes(1)
    expect(projectSecrets(FOLDER, unhydrated, false).snapshot).toEqual({ id: "policy", omaSettings: [{ "@odata.type": `#microsoft.graph.${subtype}`, isEncrypted: true }] })
    const onMasked = vi.fn()
    const masked = await readObject(TYPE, "policy", reader, { keepMasked: () => true, onMasked })
    expect(onMasked).toHaveBeenCalledOnce()
    expect(restoreBlocker(TYPE, masked)).toContain("masked OMA-URI")
  })

  it.each(["iosWiFiConfiguration", "windowsWifiConfiguration", "androidDeviceOwnerWiFiConfiguration", "macOSWiFiConfiguration"])("keeps the Graph-null key and public metadata of %s", (subtype) => {
    const snapshot = { "@odata.type": `#microsoft.graph.${subtype}`, preSharedKey: null, ...(subtype === "androidDeviceOwnerWiFiConfiguration" ? { preSharedKeyIsSet: true } : {}) }
    expect(projectSecrets(FOLDER, snapshot, true)).toEqual({ snapshot, fields: [] })
  })

  it("documents confirmed Android and macOS Wi-Fi key readback", async () => {
    const coverage = await readFile(new URL("../docs-site/src/content/docs/backups/coverage.md", import.meta.url), "utf8")
    expect(coverage).toMatch(/null pre-shared key for iOS, Windows, Android device owner and macOS/)
    expect(coverage).toContain("Android device owner profiles can also report whether a key is set.")
  })

  it("keeps opaque data, password requirements, Graph-null Wi-Fi keys and malformed unclassified values", () => {
    const snapshot = { "@odata.type": "#microsoft.graph.windowsWifiConfiguration", preSharedKey: null, customXml: "<config/>", eapXml: "<eap/>", payload: "opaque", passwordMinimumLength: 7, settings: [null, 42, { "@odata.type": 7, value: "retained" }] }
    expect(projectSecrets(FOLDER, snapshot, true)).toEqual({ snapshot, fields: [] })
  })

  it("keeps the runbook rules generated from the checked-in classification", () => {
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/sync-secret-rules.mjs", import.meta.url)), "--check"])
  })

  it.runIf(!!pwsh)("matches PowerShell projections and hashes for every registry folder and credential entry", async () => {
    const cases: Array<{ folder: string; scripts: boolean; snapshot: Item }> = [
      ...credentialCases,
      ...INTUNE_TYPES.map(({ folder }) => ({ folder, scripts: true, snapshot: { id: folder, settings: [null, { children: [typed, { value: "kept" }] }], scriptContent: CANARY } })),
      { folder: FOLDER, scripts: true, snapshot: config() },
      ...omaSubtypes.map(([subtype, value]) => ({
        folder: FOLDER, scripts: false, snapshot: { id: "profile", omaSettings: [{ "@odata.type": `#microsoft.graph.${subtype}`, isEncrypted: true, value, secretReferenceValueId: REF }] },
      })),
      { folder: "AndroidEnrollmentProfiles", scripts: false, snapshot: { tokenValue: CANARY, wifiPassword: CANARY, qrCodeContent: CANARY, qrCodeImage: { value: CANARY }, tokenExpirationDateTime: "2026-10-01T11:32:00Z" } },
    ]
    expect(INTUNE_TYPES).toHaveLength(44)
    const path = join(await temp(), "cases.json")
    await writeFile(path, JSON.stringify(cases))
    const fixture = fileURLToPath(new URL("./fixtures/cloud-backup/omission-project.ps1", import.meta.url))
    const result = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", fixture, path], { encoding: "utf8", timeout: 30_000 }))
    expect(result).toEqual(cases.map(({ folder, snapshot, scripts }) => {
      const projection = projectSecrets(folder, snapshot, scripts)
      return { ...projection, hash: snapshotHash(projection.snapshot) }
    }))
  }, 60_000)
})

function setup(root: string) {
  const store = new LocalBlobStore(root, [Buffer.alloc(32, 1)])
  const paths: string[] = []
  let mode = false
  let failPolicy = false
  let failGraph = false
  let now = Date.parse("2026-08-01T00:00:00Z")
  const engine = new BackupEngine({
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
      paths.push(url.pathname)
      if (url.pathname.endsWith("/nested")) return Response.json({ value: [typed] })
      if (url.pathname.endsWith("/deviceConfigurations")) return Response.json({ value: [{ id: "policy", displayName: "Baseline" }] })
      if (failGraph && url.pathname.endsWith("/deviceConfigurations/policy")) return Response.json({ error: { message: CANARY } }, { status: 400 })
      if (url.pathname.endsWith("/deviceConfigurations/policy")) return Response.json({
        ...config("****"),
        extra: { settings: [], "settings@odata.nextLink": "https://graph.microsoft.com/beta/nested" },
      })
      if (url.pathname.includes("getOmaSettingPlainTextValue")) return Response.json({ value: CANARY })
      return new Response(JSON.stringify({ error: { message: CANARY } }), { status: 403 })
    },
    now: () => new Date(now += 1000),
    getToken: async () => "delegated",
    unattendedTokens: () => ({ mode: "app-only", graph: async () => "reader", storage: async () => "storage" }),
    retentionDays: () => 30,
    omissionPolicy: async () => {
      if (failPolicy) throw new Error("The backup omission policy is unavailable.")
      return { enabled: mode, scripts: false, generation: mode ? "on" : "default" }
    },
  })

  const run = async (trigger: "manual" | "scheduled" = "manual") => {
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: "client", storageAccountName: ACCOUNT, trigger,
      scope: { excluded: INTUNE_TYPES.filter((type) => type.folder !== FOLDER).map((type) => type.folder) },
    }))
    const id = job.backupFolder!
    const read = async (relative: string) => (await store.get(ACCOUNT, CONTAINER, `${id}/${relative}`)).data.toString()
    return { id, job, read, manifest: async () => JSON.parse(await read("metadata.json")) }
  }

  return { run, paths, store, enable: () => { mode = true }, fail: () => { failPolicy = true }, graphError: () => { failGraph = true }, advance: () => { now += 60 * 86400_000 } }
}

function projectedRecord(snapshot: Item) {
  const projection = projectSecrets(FOLDER, snapshot, false)
  const raw = JSON.stringify(omissionBody(projection.snapshot, projection.fields))
  return { raw, item: { file: "Baseline.json", hash: snapshotHash(projection.snapshot), omitted: projection.fields, rawHash: createHash("sha256").update(raw).digest("hex") } }
}

describe("omission backup generations", () => {
  it("filters before saving in both desktop identities, records expanded fields and keeps the newest full copy through retention", async () => {
    const root = await temp()
    const fixture = setup(root)
    const full = await fixture.run()
    expect(await full.read(`${FOLDER}/Baseline.json`)).toContain(CANARY)
    expect((await full.manifest()).OmissionVersion).toBeUndefined()
    fixture.paths.length = 0
    fixture.enable()
    fixture.advance()
    const delegated = await fixture.run()
    const reader = await fixture.run("scheduled")
    expect(fixture.paths.filter((path) => path.endsWith("/nested"))).toHaveLength(2)
    expect(fixture.paths.join("\n")).not.toContain("getOmaSettingPlainTextValue")

    const relative = `.omitted/${FOLDER}/Baseline.json`
    expect(await delegated.read(relative)).toEqual(await reader.read(relative))
    for (const backup of [delegated, reader]) {
      const metadata = await backup.manifest()
      const omitted = metadata.Items[`${FOLDER}/policy`]
      expect(omitted.omitted).toEqual([
        { path: "/extra/settings/0/value", reason: "typed-secret" },
        { path: "/extra/settings/0/valueState", reason: "typed-secret" },
        { path: "/omaSettings/0/secretReferenceValueId", reason: "encrypted-oma" },
        { path: "/omaSettings/0/value", reason: "encrypted-oma" },
      ])
      expect(metadata).toMatchObject({ OmissionVersion: 1, OmissionPolicyGeneration: "on", SkippedTypes: [FOLDER], ActualSkippedTypes: [] })
      expect(verifyProjectedSnapshot(await backup.read(relative), { ...omitted, id: "policy" })).toHaveProperty("displayName", "Baseline")
      await expect(backup.read(`${FOLDER}/Baseline.json`)).rejects.toThrow()
      expect(restorableFolders(metadata).has(FOLDER)).toBe(false)
      expect(backupGaps(metadata, [FOLDER])?.missing).toEqual([{ reason: "omitted", folders: [FOLDER] }])
      for (const stored of [await backup.read(relative), JSON.stringify(metadata), JSON.stringify(backup.job)]) {
        expect(stored).not.toContain(CANARY)
        expect(stored).not.toContain(REF)
      }
    }
    expect(await full.read(`${FOLDER}/Baseline.json`)).toContain(CANARY)
    const encryptedFiles = await readdir(join(root, ACCOUNT, CONTAINER))
    expect(encryptedFiles.some((file) => file.endsWith(".tvb"))).toBe(true)
    for (const file of encryptedFiles.filter((name) => name.endsWith(".tvb"))) {
      const bytes = await readFile(join(root, ACCOUNT, CONTAINER, file))
      expect(bytes.subarray(0, 3).toString()).toBe("TVB")
      expect(bytes.includes(CANARY)).toBe(false)
    }
  })

  it("runs no Graph or backup write when policy verification fails", async () => {
    const fixture = setup(await temp())
    fixture.fail()
    const run = await fixture.run()
    expect(run.job).toMatchObject({ status: "Failed", exception: expect.stringContaining("omission policy") })
    expect(fixture.paths).toEqual([])
    expect(await fixture.store.list(ACCOUNT, CONTAINER)).toEqual([])
  })

  it("keeps an operand echoed by Graph out of job diagnostics and the failed manifest", async () => {
    const fixture = setup(await temp())
    fixture.enable()
    fixture.graphError()
    const { job, manifest } = await fixture.run()
    expect(job).toMatchObject({ status: "Failed", failures: 1 })
    expect(JSON.stringify(job)).not.toContain(CANARY)
    expect(JSON.stringify(await manifest())).not.toContain(CANARY)
  })

  it("compares kept values through an off, on and masked transition", async () => {
    const before = config()
    const older = { Status: "Success", Items: { [`${FOLDER}/policy`]: { file: "Baseline.json", hash: snapshotHash(before), secretsMasked: true } } }
    const compare = async (kept: number, reverse = false) => {
      const projected = projectedRecord(config("****", kept))
      const newer = { Status: "Success", OmissionVersion: 1, SkippedTypes: [FOLDER], ActualSkippedTypes: [], Items: { [`${FOLDER}/policy`]: projected.item } }
      // Readers that know only SkippedTypes never compare the affected type.
      expect(compareBackups(older, { ...newer, OmissionVersion: undefined })).toEqual([])
      const pair = [{ id: "old", metadata: older }, { id: "new", metadata: newer }] as const
      return compareBackupFiles(pair[reverse ? 1 : 0], pair[reverse ? 0 : 1], async (path) =>
        new Response(path.startsWith("old/") ? JSON.stringify(before) : projected.raw), compareObjects, 10)
    }

    expect(await compare(1)).toEqual({ entries: [], partial: true })
    expect(await compare(1, true)).toEqual({ entries: [], partial: true })
    const changed = await compare(2)
    expect(changed.entries).toHaveLength(1)
    expect(JSON.stringify(changed)).not.toMatch(new RegExp(`${CANARY}|${REF}`))
    expect(changed.entries[0]).toMatchObject({ change: { change: "modified" }, fields: [{ oldValue: 1, newValue: 2 }] })
  })

  it("pairs legacy and projected snapshots by ID and treats unreadable legacy files as indeterminate", async () => {
    const older = "backup-2026-09-19-180000"
    const newer = "backup-2026-09-20-180000"
    const oldFile = `${older}/${FOLDER}/Previous name.json`
    const newFile = `${newer}/.omitted/${FOLDER}/Baseline.json`
    const { item, raw } = projectedRecord(config("PGEvPg==", 2))
    const blobs = new Map([
      [`${older}/metadata.json`, JSON.stringify({ TenantId: TENANT, Status: "Success" })],
      [`${newer}/metadata.json`, JSON.stringify({ TenantId: TENANT, Status: "Success", OmissionVersion: 1, ActualSkippedTypes: [], Items: { [`${FOLDER}/policy`]: item } })],
      [oldFile, JSON.stringify({ ...config(), displayName: "Previous name" })], [newFile, raw],
    ])
    let unavailable = false
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
      if (url.searchParams.has("comp")) {
        if (url.searchParams.has("delimiter")) return new Response(`<Blobs><BlobPrefix><Name>${older}/</Name></BlobPrefix><BlobPrefix><Name>${newer}/</Name></BlobPrefix></Blobs>`)
        return new Response(`<Blobs>${[...blobs.keys()].filter((name) => name.startsWith(url.searchParams.get("prefix") ?? "")).map((name) => `<Blob><Name>${name}</Name><Content-Length>64</Content-Length></Blob>`).join("")}</Blobs>`)
      }
      const name = decodeURIComponent(url.pathname).split("/").slice(2).join("/")
      const body = unavailable && name === oldFile ? undefined : blobs.get(name)
      return new Response(body, { status: body ? 200 : 404 })
    }))
    const drift = async () => (await scan(new NextRequest("http://tenuvault.internal", { method: "POST", body: JSON.stringify({
      tenantId: TENANT, storageAccountName: "legacyfixture", appId: "test", clientSecret: "test", baseline: older, comparison: newer,
    }) }))).json()
    expect((await drift()).drifts).toEqual([expect.objectContaining({ configId: "policy", changeType: "modified" })])
    unavailable = true
    expect(await drift()).toMatchObject({ drifts: [], warnings: expect.arrayContaining([expect.objectContaining({ file: `${FOLDER}/Previous name.json` })]) })
  })

  it("stops reading mixed pairs when the history budget runs out", async () => {
    const { item, raw } = projectedRecord(config("PGEvPg==", 2))
    const key = `${FOLDER}/policy`
    const older = { id: "old", metadata: { Status: "Success", Items: { [key]: { file: "Baseline.json", hash: snapshotHash(config()) } } } }
    const newer = { id: "new", metadata: { Status: "Success", OmissionVersion: 1, Items: { [key]: item } } }
    const read = vi.fn(async (path: string) => new Response(path.startsWith("old") ? JSON.stringify(config()) : raw))
    expect(await compareBackupFiles(older, newer, read, compareObjects, 0, () => false)).toEqual({ entries: [], partial: true })
    expect(read).not.toHaveBeenCalled()
  })

  it.runIf(!!pwsh)("agrees in drift and both reports for a mixed pair with a kept change, without reporting or exporting secret operands", async () => {
    const old = config()
    const { item, raw } = projectedRecord(config("new-secret-operand", 2))
    const older = {
      name: "backup-2026-11-19-180000",
      metadata: { TenantId: TENANT, Status: "Success", Items: { [`${FOLDER}/policy`]: { file: "Baseline.json", hash: snapshotHash(old) } } },
      files: { [`${FOLDER}/Baseline.json`]: old },
    }
    const newer = {
      name: "backup-2026-11-20-180000",
      metadata: { TenantId: TENANT, Status: "Success", OmissionVersion: 1, SkippedTypes: [FOLDER], ActualSkippedTypes: [], Items: { [`${FOLDER}/policy`]: item } },
      files: { [`.omitted/${FOLDER}/Baseline.json`]: JSON.parse(raw) },
    }
    const generatedAt = "2026-11-20T18:05:00Z"
    const fixture = { older, newer, generatedAt, audit: [], definitions: {}, tenantId: TENANT, tenantName: "Contoso" }
    const fixturePath = join(await temp(), "report.json")
    await writeFile(fixturePath, JSON.stringify(fixture))
    const script = fileURLToPath(new URL("./fixtures/reports/cloud-report.ps1", import.meta.url))
    const cloud = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-File", script, fixturePath], { encoding: "utf8", timeout: 30_000 }))
    const blobs = new Map([
      [`${older.name}/metadata.json`, JSON.stringify(older.metadata)],
      [`${newer.name}/metadata.json`, JSON.stringify(newer.metadata)],
      [`${older.name}/${FOLDER}/Baseline.json`, JSON.stringify(old)],
      [`${newer.name}/.omitted/${FOLDER}/Baseline.json`, raw],
    ])
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
      if (url.searchParams.has("comp")) {
        if (url.searchParams.has("delimiter")) {
          return new Response(`<EnumerationResults><Blobs><BlobPrefix><Name>${older.name}/</Name></BlobPrefix><BlobPrefix><Name>${newer.name}/</Name></BlobPrefix></Blobs></EnumerationResults>`)
        }
        const names = [...blobs.keys()].filter((name) => name.startsWith(url.searchParams.get("prefix") ?? ""))
        return new Response(`<Blobs>${names.map((name) => `<Blob><Name>${name}</Name><Content-Length>64</Content-Length></Blob>`).join("")}</Blobs>`)
      }
      const data = blobs.get(decodeURIComponent(url.pathname).split("/").slice(2).join("/"))
      return new Response(data, { status: data ? 200 : 404 })
    }))
    const response = await scan(new NextRequest("http://tenuvault.internal", {
      method: "POST", body: JSON.stringify({ tenantId: TENANT, storageAccountName: "stcontoso", appId: "test", clientSecret: "test",
        baseline: older.name, comparison: newer.name, documentItems: true }),
    }))
    expect(response.status).toBe(200)
    const drift = await response.json()
    expect(drift.drifts).toHaveLength(1)
    const report = buildChangeReport(drift, { changes: [], note: null }, { tenantId: TENANT, tenantName: "Contoso", generatedAt, trigger: "scheduled", includeValues: true, includeActors: false })
    expect(report.items).toHaveLength(1)
    expect(report.summary).toMatchObject({ modified: 1, added: 0, deleted: 0 })
    expect(cloud.report.summary, JSON.stringify(cloud.report.warnings)).toEqual(report.summary)
    expect(cloud.report.items[0].settings).toEqual(report.items[0]!.settings)
    for (const output of [JSON.stringify(drift), JSON.stringify(report), JSON.stringify(cloud), changeReportMarkdown(report)]) {
      expect(output).not.toMatch(new RegExp(`${CANARY}|${REF}|new-secret-operand`))
      expect(output).toContain("Some values could not be compared")
    }
  }, 60_000)
})

describe("omission recovery", () => {
  const id = "backup-2026-11-20-180000"
  const hidden = `${id}/.omitted/${FOLDER}/Baseline.json`
  const logical = `${id}/${FOLDER}/Baseline.json`
  const eligible = `${id}/${FOLDER}/Eligible.json`
  const request = (data: object) => new NextRequest("http://tenuvault.internal", {
    method: "POST", body: JSON.stringify({ backupId: id, tenantId: TENANT, storageAccountName: "stcontoso", appId: "test", clientSecret: "test", ...data }),
  })
  const fixture = () => {
    const { raw, item } = projectedRecord(config())
    const kept = { ...config(), id: "eligible", displayName: "Eligible", omaSettings: [] }
    const metadata = {
      TenantId: TENANT, BackupFolder: id, Status: "Success", Failures: 0, OmissionVersion: 1, SkippedTypes: [FOLDER], ActualSkippedTypes: [],
      ItemCounts: { [FOLDER]: 2, TotalPolicies: 2 },
      Items: { [`${FOLDER}/policy`]: item, [`${FOLDER}/eligible`]: { file: "Eligible.json", hash: snapshotHash(kept) } },
    }
    const blobs = new Map([[hidden, raw], [eligible, JSON.stringify(kept)], [`${id}/metadata.json`, JSON.stringify(metadata)]])
    const graph = vi.fn((url: string, method: string) => method === "GET"
      ? new Response(null, { status: 404 })
      : Response.json({ id: "created" }, { status: 201 }))
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const target = new URL(url)
      if (target.hostname === "login.microsoftonline.com") return Response.json({ access_token: "test" })
      if (target.hostname === "graph.microsoft.com") return graph(url, init?.method ?? "GET")
      if (target.searchParams.get("comp") === "list") return new Response(`<Blobs>${[...blobs].map(([name, body]) => `<Blob><Name>${name}</Name><Content-Length>${body.length}</Content-Length></Blob>`).join("")}</Blobs>`)
      const blob = blobs.get(decodeURIComponent(target.pathname).split("/").slice(2).join("/"))
      return new Response(blob, { status: blob === undefined ? 404 : 200 })
    }))
    return { graph, blobs, metadata }
  }

  it("blocks direct restore, repair and revert requests, and restores only eligible policies in a full run", async () => {
    const { graph } = fixture()
    const selection = (path: string, repairToken?: string) => ({ restoreType: "selective", selectedPolicies: [{ path, repairToken }] })
    const omitted = await (await restore(request(selection(logical)))).json()
    expect(omitted.details.results).toEqual([expect.objectContaining({ error: OMISSION_BLOCKER })])
    const repair = await (await restore(request(selection(logical, TENANT)))).json()
    expect(repair.details.results).toEqual([expect.objectContaining({ error: OMISSION_BLOCKER })])
    expect((await restore(request(selection(hidden)))).status).toBe(400)
    const reverted = await revert(request({ backupPath: logical, action: "revert", policyId: "policy", policyType: FOLDER }))
    expect((await reverted.json()).error).toBe(OMISSION_BLOCKER)
    expect(graph).not.toHaveBeenCalled()

    const full = await (await restore(request({ restoreType: "full" }))).json()
    expect(full.details).toMatchObject({ restoredCount: 1, failedCount: 0, skippedCount: 1 })
    expect(full.details.results).toContainEqual(expect.objectContaining({ path: logical, error: OMISSION_BLOCKER }))
    expect(graph).toHaveBeenCalledTimes(1)
  })

  it("counts projected files only when listed under the folder named by the verified inventory", async () => {
    const { blobs } = fixture()
    blobs.set(`${id}/.omitted/${FOLDER}/Orphan.json`, "{}")
    const result = await (await listBackups(request({ subscriptionId: "test", resourceGroupName: "test", summary: true }))).json()
    expect(result.backups).toEqual([expect.objectContaining({ policyCount: 2, omittedPolicies: 1, counts: { [FOLDER]: 2 } })])
    blobs.delete(hidden)
    const missing = await (await listBackups(request({ subscriptionId: "test", resourceGroupName: "test", summary: true }))).json()
    expect(missing.backups).toEqual([expect.objectContaining({ policyCount: 1, counts: { [FOLDER]: 1 } })])
  })

  it("reports a policy set as skipped when its omitted profile is missing", async () => {
    const { blobs, metadata, graph } = fixture()
    const set = { id: "set", displayName: "Depends on omitted profile", items: [{ "@odata.type": "#microsoft.graph.deviceConfigurationPolicySetItem", payloadId: "policy" }] }
    const path = `${id}/PolicySets/Set.json`
    blobs.set(path, JSON.stringify(set))
    blobs.set(`${id}/metadata.json`, JSON.stringify({ ...metadata, Items: { ...metadata.Items, "PolicySets/set": { file: "Set.json", hash: snapshotHash(set) } } }))
    const result = await (await restore(request({ restoreType: "full" }))).json()
    expect(result.details).toMatchObject({ restoredCount: 1, skippedCount: 2, failedCount: 0 })
    expect(result.details.results).toContainEqual(expect.objectContaining({ path, action: "skipped", error: expect.stringContaining("items[0].payloadId") }))
    expect(graph.mock.calls).toEqual([
      ["https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations", "POST"],
      ["https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/policy", "GET"],
    ])
  })

  it("skips a Settings Catalog policy when its omitted reusable setting is absent", async () => {
    const graph = vi.fn<GraphCall>().mockResolvedValue({ status: 404, body: {} })
    const body: Item = { id: "catalog", name: "Catalog", settings: [{ settingInstance: {
      "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "definition",
      simpleSettingValue: { "@odata.type": REFERENCE_SETTING_VALUE, value: "omitted-reusable" },
    } }] }
    const restorer = new Restorer(graph, { mode: "copy", assignments: false, omittedDependencies: new Map([["omitted-reusable", "ReusablePolicySettings"]]) })
    expect(await restorer.restore(`${id}/ConfigurationPolicies/Catalog.json`, body)).toMatchObject({ action: "skipped", retryable: false, error: expect.stringContaining("simpleSettingValue.value") })
    expect(graph.mock.calls).toEqual([["GET", "deviceManagement/reusablePolicySettings/omitted-reusable"]])
  })

  it("blocks both plans and the shared main restorer when a projected body is supplied directly", async () => {
    const snapshot = JSON.parse(projectedRecord(config()).raw)
    expect(() => buildRestorePlan(TYPE, snapshot)).toThrow(OMISSION_BLOCKER)
    expect(() => buildUpdatePlan(TYPE, snapshot, "policy")).toThrow(OMISSION_BLOCKER)
    const graph = vi.fn()
    expect(await new Restorer(graph, { mode: "replace", assignments: false }).restore(logical, snapshot)).toMatchObject({ success: false, error: OMISSION_BLOCKER })
    expect(graph).not.toHaveBeenCalled()
  })

  it("verifies the projected bytes in preview and keeps the blocker through a ZIP export and encrypted import", async () => {
    const { graph, blobs } = fixture()
    const inspected = await (await preview(request({ paths: [logical], live: true }))).json()
    expect(inspected.items[0]).toMatchObject({ blocker: OMISSION_BLOCKER, omitted: expect.any(Array) })
    expect(graph).not.toHaveBeenCalled()
    const response = await download(request({ subscriptionId: "local", resourceGroupName: "local" }))
    expect(response.status).toBe(200)
    const raw = Buffer.from(await response.arrayBuffer())
    const zip = await JSZip.loadAsync(raw)
    for (const entry of Object.values(zip.files).filter((file) => !file.dir)) {
      const content = await entry.async("nodebuffer")
      expect(content.includes(CANARY)).toBe(false)
      expect(content.includes(REF)).toBe(false)
    }
    const reviewed = await reviewArchive(raw)
    const store = new LocalBlobStore(await temp(), [Buffer.alloc(32, 2)])
    await importArchive(store, reviewed)
    expect((await store.get(ACCOUNT, CONTAINER, hidden)).data.toString()).toEqual(blobs.get(hidden))
    await expect(store.get(ACCOUNT, CONTAINER, logical)).rejects.toThrow()

    const file = hidden.slice(id.length + 1)
    zip.file(file, `${blobs.get(hidden)} `)
    await expect(reviewArchive(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/omission inventory/)
  })
})

describe("tenant omission policy", () => {
  it("defaults off, survives a restart, binds device backups to cloud storage and fails closed", async () => {
    const entries = new Map<string, string>()
    const store = { get: (key: string) => entries.get(key) ?? null, set: (key: string, value: string) => { entries.set(key, value) }, delete: (key: string) => { entries.delete(key) } }
    const blobs = new Map<string, string>()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init)
      if (request.method === "PUT") {
        blobs.set(request.url, await request.text())
        return new Response(null, { status: 201 })
      }
      const value = blobs.get(request.url)
      return new Response(value, { status: value === undefined ? 404 : 200, headers: { etag: "\"version\"" } })
    })
    const token = async () => "existing-token"
    const policy = new OmissionPolicyStore(store, fetch)
    expect(await policy.read(TENANT, ACCOUNT, undefined, token)).toMatchObject({ enabled: false, scripts: false })
    await policy.save(TENANT, ACCOUNT, undefined, token, { enabled: true, scripts: false })
    expect(await new OmissionPolicyStore(store, fetch).read(TENANT, ACCOUNT, undefined, token)).toMatchObject({ enabled: true, scripts: false })
    await expect(policy.read(TENANT, ACCOUNT, "stcontoso", token)).rejects.toThrow(/could not be verified/)
    expect(await policy.read(TENANT, ACCOUNT, "stcontoso", token, true)).toMatchObject({ enabled: true, migrationRequired: true })
    await policy.save(TENANT, ACCOUNT, "stcontoso", token, { enabled: true, scripts: true })
    expect(await new OmissionPolicyStore(store, fetch).read(TENANT, ACCOUNT, undefined, token)).toMatchObject({ enabled: true, scripts: true })
    expect(fetch.mock.calls.some(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer existing-token")).toBe(true)
    await expect(policy.read(TENANT, "otheraccount", undefined, token)).rejects.toThrow(/could not be verified/)
    const name = [...blobs.keys()].find((key) => key.endsWith("secret-omission.json"))!
    blobs.delete(name)
    await expect(policy.read(TENANT, ACCOUNT, "stcontoso", token)).rejects.toThrow(/could not be verified/)
    blobs.set(name, '{"version":2}')
    await expect(policy.read(TENANT, ACCOUNT, "stcontoso", token)).rejects.toThrow(/could not be verified/)
  })
})

function sharedStorage(graph: typeof fetch = async () => Response.json({ value: [] })) {
  const blobs = new Map<string, { body: string; etag: string }>()
  let revision = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (!url.hostname.endsWith(".blob.core.windows.net")) return graph(input, init)
    const name = decodeURIComponent(url.origin + url.pathname)
    const current = blobs.get(name)
    if (request.method === "GET") return current ? new Response(current.body, { headers: { etag: current.etag } }) : new Response(null, { status: 404 })
    if (url.searchParams.get("restype") === "container") return new Response(null, { status: 201 })
    const body = await request.text()
    const latest = blobs.get(name)
    if ((latest && request.headers.get("if-none-match") === "*") ||
        (request.headers.has("if-match") && request.headers.get("if-match") !== latest?.etag)) {
      return new Response(null, { status: 412 })
    }
    blobs.set(name, { body, etag: `"${++revision}"` })
    return new Response(null, { status: 201 })
  }
  return { fetch, blobs }
}

const token = async () => "token"
const azureRequest = { tenantId: TENANT, clientId: "client", storageAccountName: "stdesktop", scope: { excluded: INTUNE_TYPES.filter(({ folder }) => folder !== FOLDER).map(({ folder }) => folder) } }

it("keeps a never-enrolled desktop and Backup Reader running across a configured account mismatch", async () => {
  const storage = sharedStorage()
  const policies = new OmissionPolicyStore(memoryStore(), storage.fetch)
  const cloud = configuredCloudPolicyAccount(JSON.stringify({ tenantId: TENANT, storageAccount: "stcloud" }), TENANT)
  const engine = new BackupEngine({
    fetch: storage.fetch, getToken: token,
    unattendedTokens: () => ({ mode: "app-only", graph: token, storage: token }),
    omissionPolicy: (request, tokens, signal) => policies.readForBackup(TENANT, request.storageAccountName, "stdesktop", cloud, tokens.storage, signal),
  })
  expect(configuredCloudPolicyAccount("{broken", TENANT)).toBeUndefined()
  expect(await policies.read(TENANT, "stdesktop", cloud, token)).toMatchObject({ enabled: false, generation: "default" })
  expect((await engine.waitForJob(engine.start(azureRequest))).status).toBe("Completed")
  // Each run needs its own timestamped folder.
  const readerEngine = new BackupEngine({
    fetch: storage.fetch, getToken: token, now: () => new Date(Date.now() + 1_001),
    unattendedTokens: () => ({ mode: "app-only", graph: token, storage: token }),
    omissionPolicy: (request, tokens, signal) => policies.readForBackup(TENANT, request.storageAccountName, "stdesktop", cloud, tokens.storage, signal),
  })
  expect(await readerEngine.waitForJob(readerEngine.start({ ...azureRequest, trigger: "scheduled" }))).toMatchObject({ status: "Completed", authMode: "app-only" })
  await new OmissionPolicyStore(memoryStore(), storage.fetch).save(TENANT, "stcloud", undefined, token, { enabled: true, scripts: false })
  await expect(policies.read(TENANT, "stdesktop", cloud, token)).rejects.toThrow(/could not be verified/)
})

it("rejects a direct device backup request when the persisted destination is Azure", async () => {
  const storage = sharedStorage()
  await new OmissionPolicyStore(memoryStore(), storage.fetch).save(TENANT, "stdesktop", undefined, token, { enabled: true, scripts: false })
  const policies = new OmissionPolicyStore(memoryStore(), storage.fetch)
  const engine = new BackupEngine({
    fetch: storage.fetch, getToken: token,
    omissionPolicy: (request, tokens, signal) => policies.readForBackup(TENANT, request.storageAccountName, "stdesktop", undefined, tokens.storage, signal),
  })
  const route = backupRoutes(engine)["/api/backup/start"]!.POST!
  const response = await route(new NextRequest("http://tenuvault.internal/api/backup/start", {
    method: "POST", body: JSON.stringify({ ...azureRequest, storageAccountName: ACCOUNT, appId: "client" }),
  }))
  const { jobId } = await response.json()
  expect(await engine.waitForJob(engine.get(jobId)!)).toMatchObject({ status: "Failed", exception: expect.stringContaining("saved storage") })
  expect([...storage.blobs.keys()].some((key) => key.includes("/backup-"))).toBe(false)
})

it("fences a desktop producer that began to capture before another computer enabled omission", async () => {
  let reachDetail!: () => void
  let finishDetail!: () => void
  const reached = new Promise<void>((resolve) => { reachDetail = resolve })
  const finish = new Promise<void>((resolve) => { finishDetail = resolve })
  const storage = sharedStorage(async (input) => {
    const url = String(input)
    if (url.endsWith("/deviceConfigurations")) return Response.json({ value: [{ id: "policy", displayName: "Baseline" }] })
    if (url.includes("getOmaSettingPlainTextValue")) return Response.json({ value: CANARY })
    reachDetail()
    await finish
    return Response.json(config("****"))
  })
  const reader = new OmissionPolicyStore(memoryStore(), storage.fetch)
  const admin = new OmissionPolicyStore(memoryStore(), storage.fetch)
  const engine = new BackupEngine({
    fetch: storage.fetch, getToken: token,
    omissionPolicy: (request, tokens, signal) => reader.read(TENANT, request.storageAccountName, undefined, tokens.storage, false, signal),
  })
  const job = engine.start(azureRequest)
  await reached
  await admin.save(TENANT, "stdesktop", undefined, token, { enabled: true, scripts: false })
  finishDetail()
  expect(await engine.waitForJob(job)).toMatchObject({ status: "Failed", exception: expect.stringContaining("policy changed") })
  expect([...storage.blobs.keys()].some((name) => name.includes(`/${job.backupFolder}/`))).toBe(false)
  expect(JSON.stringify([...storage.blobs.values()])).not.toContain(CANARY)
})

it("will not declare a change active while another computer holds a publication claim", async () => {
  const storage = sharedStorage()
  const reader = new OmissionPolicyStore(memoryStore(), storage.fetch)
  const admin = new OmissionPolicyStore(memoryStore(), storage.fetch)
  const old = await reader.read(TENANT, "stdesktop", undefined, token)
  const claim = await old.beginPublication!("existing-run", Date.now() + 5_000, new AbortController().signal)
  const enable = () => admin.save(TENANT, "stdesktop", undefined, token, { enabled: true, scripts: false })
  await expect(enable()).rejects.toThrow(/publishing/)
  expect(await admin.read(TENANT, "stdesktop", undefined, token)).toMatchObject({ enabled: false })
  await claim()
  await enable()
  expect(await admin.read(TENANT, "stdesktop", undefined, token)).toMatchObject({ enabled: true })
})

it.each(["token", "fetch", "backoff"])("cancels a default-off policy read during %s", async (stage) => {
  let markReached!: () => void
  const reached = new Promise<void>((resolve) => { markReached = resolve })
  const hang = () => new Promise<never>(() => { markReached() })
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (stage === "fetch") return hang()
    markReached()
    return new Response(null, { status: 503, headers: { "retry-after": "60" } })
  })
  const policies = new OmissionPolicyStore(memoryStore(), fetch)
  const engine = new BackupEngine({
    fetch, getToken: stage === "token" ? hang : token,
    omissionPolicy: (request, tokens, signal) => policies.read(TENANT, request.storageAccountName, undefined, tokens.storage, false, signal),
  })
  const job = engine.start(azureRequest)
  await reached
  if (stage === "backoff") await new Promise<void>((resolve) => setImmediate(resolve))
  engine.cancel(job.id)
  expect(await engine.waitForJob(job)).toMatchObject({ status: "Cancelled" })
  expect(fetch).toHaveBeenCalledTimes(stage === "token" ? 0 : 1)
})

it("reports a recoverable pending change when enrollment is interrupted", async () => {
  const storage = sharedStorage()
  let failEnrollment = true
  const interrupted: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    if (failEnrollment && request.method === "PUT" && request.url.endsWith("secret-omission-enrolled.json")) {
      return new Response(null, { status: 403 })
    }
    return storage.fetch(request)
  }
  const store = new OmissionPolicyStore(memoryStore(), interrupted)
  const enable = () => store.save(TENANT, "stdesktop", undefined, token, { enabled: true, scripts: false })
  await expect(enable()).rejects.toThrow()
  await expect(store.read(TENANT, "stdesktop", undefined, token)).rejects.toThrow("could not be verified")
  expect(await store.read(TENANT, "stdesktop", undefined, token, true)).toMatchObject({
    enabled: false, pending: { enabled: true, scripts: false },
  })
  failEnrollment = false
  await enable()
  expect(await store.read(TENANT, "stdesktop", undefined, token, true)).toMatchObject({ enabled: true })
})
