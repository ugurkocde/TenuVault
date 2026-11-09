import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { legacyAzureReader, registerStorageToken } from "../src/main/storage/azure-seal"
import { POST as listBackups } from "../src/portal/app/api/list-backups/route"
import { POST as restoreBackup } from "../src/portal/app/api/restore-backup/route"
import { POST as restorePreview } from "../src/portal/app/api/restore-preview/route"
import { POST as downloadBackup } from "../src/portal/app/api/download-backup/route"
import { BACKUP_OWNER_FILE } from "../src/shared/constants"
import { LEGACY_SEALED_MESSAGE } from "../src/shared/legacy-sealed"
import { sealLegacyAzure } from "./legacy-seal"

/**
 * One Azure container shared by two tenants, holding plain backups (this version) and backups an
 * earlier version sealed with a device key. Requests go through the real legacy reader, as in the app.
 */
const A = "11111111-1111-1111-1111-111111111111"
const B = "22222222-2222-2222-2222-222222222222"
const deviceKey = Buffer.alloc(32, 4)
const account = "contoso"
const base = `https://${account}.blob.core.windows.net/intune-backups/`
const snapshot = (name: string) => ({ id: `id-${name.replace(/\W/g, "")}`, displayName: name, "@odata.type": "#microsoft.graph.windows10CustomConfiguration", omaSettings: [] })
const manifest = (tenantId: string) => ({ TenantId: tenantId, Status: "Success", Failures: 0, FailedTypes: [], SkippedTypes: [], Scope: { Excluded: [] } })

const PLAIN_A = "backup-2026-11-09-100000"
const PLAIN_B = "backup-2026-11-09-110000"
const LEGACY_A = "backup-2026-10-01-100000"
const LEGACY_A_NO_MARKER = "backup-2026-09-01-100000"

function container(withB = true): Map<string, Uint8Array> {
  const blobs = new Map<string, Uint8Array>()
  const plain = (name: string, value: unknown) => blobs.set(name, new TextEncoder().encode(JSON.stringify(value)))
  const sealed = (name: string, value: unknown) => blobs.set(name, new Uint8Array(sealLegacyAzure(Buffer.from(JSON.stringify(value)), deviceKey, A, new URL(`${base}${name}`))))
  for (const [folder, tenant] of (withB ? [[PLAIN_A, A], [PLAIN_B, B]] : [[PLAIN_A, A]]) as Array<[string, string]>) {
    plain(`${folder}/${BACKUP_OWNER_FILE}`, { Source: "TenuVault Desktop", TenantId: tenant, RunId: folder })
    plain(`${folder}/DeviceConfigurations/Policy.json`, snapshot(`Policy ${tenant.slice(0, 1)}`))
    plain(`${folder}/metadata.json`, manifest(tenant))
  }
  sealed(`${LEGACY_A}/${BACKUP_OWNER_FILE}`, { Source: "TenuVault Desktop", TenantId: A, RunId: LEGACY_A })
  sealed(`${LEGACY_A}/DeviceConfigurations/Policy.json`, snapshot("Legacy A"))
  sealed(`${LEGACY_A}/metadata.json`, manifest(A))
  sealed(`${LEGACY_A_NO_MARKER}/DeviceConfigurations/Policy.json`, snapshot("Older legacy A"))
  sealed(`${LEGACY_A_NO_MARKER}/metadata.json`, manifest(A))
  return blobs
}

/** Installs the app's fetch path: token answers per tenant, Graph, and storage through the legacy reader. */
function install(keys: Buffer[], withB = true) {
  const blobs = container(withB)
  const graph: string[] = []
  const tokenFor = (tenant: string) => `storage-${tenant}`
  registerStorageToken(tokenFor(A), A)
  registerStorageToken(tokenFor(B), B)
  const network: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: tokenFor(url.pathname.split("/")[1]!) })
    if (url.hostname === "graph.microsoft.com") {
      graph.push(`${init?.method ?? "GET"} ${url.pathname}`)
      return Response.json({ ...snapshot("Policy 1"), displayName: "Changed in the tenant" })
    }
    if (url.searchParams.get("comp") === "list") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const names = [...blobs.keys()].filter((name) => name.startsWith(prefix))
      const body = url.searchParams.get("delimiter")
        ? [...new Set(names.map((name) => name.split("/")[0]))].map((name) => `<BlobPrefix><Name>${name}/</Name></BlobPrefix>`).join("")
        : names.map((name) => `<Blob><Name>${name}</Name><Properties><Content-Length>${blobs.get(name)!.length}</Content-Length></Properties></Blob>`).join("")
      return new Response(`<EnumerationResults><Blobs>${body}</Blobs><NextMarker></NextMarker></EnumerationResults>`)
    }
    if (url.searchParams.get("restype") === "container") return new Response(null, { status: 200 })
    const name = decodeURIComponent(url.pathname.slice("/intune-backups/".length))
    const blob = blobs.get(name)
    return blob ? new Response(new Uint8Array(blob)) : new Response("", { status: 404 })
  }
  vi.stubGlobal("fetch", legacyAzureReader(network, () => keys))
  return { graph }
}

const body = (tenantId: string, extra: object = {}) => ({ tenantId, appId: "app", clientSecret: "placeholder", subscriptionId: "sub", resourceGroupName: "rg", storageAccountName: account, ...extra })
const post = (path: string, data: object) => new NextRequest(`http://tenuvault.internal${path}`, { method: "POST", body: JSON.stringify(data) })
const listFor = async (tenantId: string) => (await listBackups(post("/api/list-backups", body(tenantId)) as never)).json()

afterEach(() => vi.unstubAllGlobals())

describe("plain Azure backups in a shared container", () => {
  it("lists each tenant's plain and legacy backups, only its own, on a device with the key", async () => {
    install([deviceKey])
    const a = await listFor(A)
    expect(a.backups.map((backup: { id: string }) => backup.id)).toEqual([PLAIN_A, LEGACY_A, LEGACY_A_NO_MARKER])
    expect(a.backups.every((backup: { status: string; error?: string }) => backup.status === "Success" && !backup.error)).toBe(true)
    expect(a.sealed).toBe(0)
    // A's legacy backups open on this device for A, a tenant signed in here, so for B they are
    // another tenant's: left out, and not counted as needing a key.
    const b = await listFor(B)
    expect(b.backups.map((backup: { id: string }) => backup.id)).toEqual([PLAIN_B])
    expect(b.sealed).toBe(0)
  })

  it("opens the plain backups without any key and names the missing key for each legacy one", async () => {
    install([])
    const a = await listFor(A)
    // The legacy backup with a sealed ownership marker cannot be placed, so it is left out and counted.
    // The one without a marker is listed with the reason, and counted too.
    expect(a.backups.map((backup: { id: string }) => backup.id)).toEqual([PLAIN_A, LEGACY_A_NO_MARKER])
    expect(a.backups[0]).toMatchObject({ status: "Success" })
    expect(a.backups[1]).toMatchObject({ status: "unknown", error: LEGACY_SEALED_MESSAGE })
    // Without the key nobody can tell whose they are, and B's plain backup shows another tenant
    // uses this container, so they are not counted for A's recovery key notice.
    expect(a.sealed).toBe(0)
    // Tenant B never sees A's plain backup. Without a key nobody can tell whose A's legacy folders
    // are, so B sees the one from before ownership markers only as a row naming the missing key.
    const b = await listFor(B)
    expect(b.backups.map((backup: { id: string }) => backup.id)).toEqual([PLAIN_B, LEGACY_A_NO_MARKER])
    expect(b.backups[1]).toMatchObject({ status: "unknown", error: LEGACY_SEALED_MESSAGE })
    expect(b.sealed).toBe(0)
  })

  it("counts the legacy backups for the recovery key notice when no other tenant uses the container", async () => {
    install([], false)
    const a = await listFor(A)
    expect(a.backups.map((backup: { id: string }) => backup.id)).toEqual([PLAIN_A, LEGACY_A_NO_MARKER])
    expect(a.sealed).toBe(2)
  })

  it("refuses a legacy backup whose manifest no key opens in the restore preview, never treating it as untagged", async () => {
    install([])
    const response = await restorePreview(post("/api/restore-preview", body(A, { backupId: LEGACY_A_NO_MARKER, paths: [`${LEGACY_A_NO_MARKER}/DeviceConfigurations/Policy.json`] })) as never)
    // A sealed manifest no key opens is refused outright, never treated as untagged.
    expect(response.status).toBe(403)
  })

  it("replaces a policy in place from a plain backup with no recovery key on this device", async () => {
    const { graph } = install([])
    const response = await restoreBackup(post("/api/restore-backup", body(A, { backupId: PLAIN_A, restoreType: "selective", selectedPolicies: [{ path: `${PLAIN_A}/DeviceConfigurations/Policy.json` }], mode: "replace" })) as never)
    const result = await response.json()
    expect(response.status).toBe(200)
    expect(result.details.results[0]).toMatchObject({ success: true, action: "updated" })
    expect(graph).toContain("PATCH /beta/deviceManagement/deviceConfigurations/id-Policy1")
  })

  it("previews a plain backup without an unverified prefix or replace blocker", async () => {
    install([])
    const response = await restorePreview(post("/api/restore-preview", body(A, { backupId: PLAIN_A, paths: [`${PLAIN_A}/DeviceConfigurations/Policy.json`] })) as never)
    const { items } = await response.json()
    expect(items[0]).toMatchObject({ name: "Policy 1" })
    expect(items[0].replaceBlocker).toBeUndefined()
  })

  it.each([
    ["restore", () => restoreBackup(post("/api/restore-backup", body(A, { backupId: PLAIN_B, restoreType: "selective", selectedPolicies: [{ path: `${PLAIN_B}/DeviceConfigurations/Policy.json` }], mode: "replace" })) as never)],
    ["download", () => downloadBackup(post("/api/download-backup", body(A, { backupId: PLAIN_B })) as never)],
  ] as const)("refuses a %s of the other tenant's plain backup before any Graph write", async (_kind, run) => {
    const { graph } = install([deviceKey])
    const response = await run()
    expect(response.status).toBe(403)
    expect((await response.json()).error).toMatch(/another tenant/)
    expect(graph).toEqual([])
  })

  it("refuses another tenant's legacy backup that a key here opens only for that tenant", async () => {
    const { graph } = install([deviceKey])
    const response = await restoreBackup(post("/api/restore-backup", body(B, { backupId: LEGACY_A, restoreType: "selective", selectedPolicies: [{ path: `${LEGACY_A}/DeviceConfigurations/Policy.json` }], mode: "copy" })) as never)
    expect(response.status).toBe(403)
    expect((await response.json()).error).toBe("This backup belongs to another tenant.")
    expect(graph).toEqual([])
  })

  it("restores a legacy sealed backup on a device with its key", async () => {
    const { graph } = install([deviceKey])
    const response = await restoreBackup(post("/api/restore-backup", body(A, { backupId: LEGACY_A, restoreType: "selective", selectedPolicies: [{ path: `${LEGACY_A}/DeviceConfigurations/Policy.json` }], mode: "replace" })) as never)
    expect(response.status).toBe(200)
    expect((await response.json()).details.results[0]).toMatchObject({ success: true })
    expect(graph.some((call) => call.startsWith("PATCH "))).toBe(true)
  })

  it("refuses a legacy sealed backup no key on this device opens, naming the cause", async () => {
    const { graph } = install([])
    const response = await restoreBackup(post("/api/restore-backup", body(A, { backupId: LEGACY_A, restoreType: "selective", selectedPolicies: [{ path: `${LEGACY_A}/DeviceConfigurations/Policy.json` }], mode: "copy" })) as never)
    expect(response.status).toBe(403)
    expect((await response.json()).error).toContain("encrypted by an earlier TenuVault version")
    expect(graph).toEqual([])
  })
})
