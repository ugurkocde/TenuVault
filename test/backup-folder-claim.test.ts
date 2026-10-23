import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BackupEngine, type BackupJob } from "../src/main/backup/engine"
import { handleLocalBlobRequest, localAccountFromUrl } from "../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { BACKUP_OWNER_FILE, localStorageAccountName } from "../src/shared/constants"
import { INTUNE_TYPES } from "../src/shared/intune/registry"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CLIENT = "22222222-2222-2222-2222-222222222222"
const FIXED = new Date("2026-09-24T12:00:00Z")
const FOLDER = "backup-2026-09-24-120000"

function graphFor(displayName: string, id: string) {
  return (url: URL) => {
    if (url.pathname === "/beta/deviceManagement/deviceConfigurations") {
      return Response.json({ value: [{ id, displayName }] })
    }
    if (url.pathname === `/beta/deviceManagement/deviceConfigurations/${id}`) {
      return Response.json({ id, displayName, detail: true })
    }
    if (url.pathname.endsWith("/assignments")) return Response.json({ value: [] })
    // Tenant-wide settings are left out (denied, so skipped) to keep each run to one policy.
    if (INTUNE_TYPES.some((type) => type.singleton && url.pathname === `/beta/${type.path}`)) return Response.json({ error: { message: "Forbidden" } }, { status: 403 })
    if (INTUNE_TYPES.some((type) => url.pathname === `/beta/${type.path}`)) return Response.json({ value: [] })
    return Response.json({ id: url.pathname.split("/").pop(), detail: true })
  }
}

function engineSharing(store: LocalBlobStore, account: string, displayName: string, id: string) {
  const graph = graphFor(displayName, id)
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
    if (url.hostname === "graph.microsoft.com") return graph(url)
    throw new Error(`unexpected ${url}`)
  }) as unknown as typeof fetch
  return new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", now: () => new Date(FIXED) })
}

async function settled(engine: BackupEngine, job: BackupJob) {
  await engine.waitForJob(job)
  expect(job.status).not.toBe("Running")
  return job
}

describe("backup folder claim", () => {
  it("keeps only the winning writer's files when two engines race for one folder", async () => {
    const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-claim-")), [randomBytes(32)])
    const account = localStorageAccountName(TENANT)
    const engineA = engineSharing(store, account, "Alpha", "a1")
    const engineB = engineSharing(store, account, "Beta", "b1")

    const startedA = engineA.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account })
    const startedB = engineB.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account })
    const [jobA, jobB] = await Promise.all([settled(engineA, startedA), settled(engineB, startedB)])

    expect([jobA.status, jobB.status].sort()).toEqual(["Completed", "Failed"])
    const winnerIsA = jobA.status === "Completed"
    const winner = winnerIsA ? jobA : jobB
    const loser = winnerIsA ? jobB : jobA
    const winnerName = winnerIsA ? "Alpha" : "Beta"
    const winnerId = winnerIsA ? "a1" : "b1"

    expect(winner.backupFolder).toBe(FOLDER)
    expect(loser.backupFolder).toBe(FOLDER)
    expect(loser.exception).toContain(FOLDER)
    expect(loser.exception).toContain("already in use")
    expect(loser.exception).toMatch(/Wait for the other backup to finish, then try again\./)

    const names = (await store.list(account, "intune-backups")).map((blob) => blob.name).sort()
    expect(names).toEqual([
      `${FOLDER}/${BACKUP_OWNER_FILE}`,
      `${FOLDER}/DeviceConfigurations/${winnerName}.json`,
      `${FOLDER}/metadata.json`,
    ])

    const owner = JSON.parse((await store.get(account, "intune-backups", `${FOLDER}/${BACKUP_OWNER_FILE}`)).data.toString())
    expect(owner).toEqual({ Source: "TenuVault Desktop", TenantId: TENANT, RunId: winner.id })

    const detail = JSON.parse((await store.get(account, "intune-backups", `${FOLDER}/DeviceConfigurations/${winnerName}.json`)).data.toString())
    expect(detail).toMatchObject({ id: winnerId })

    const metadata = JSON.parse((await store.get(account, "intune-backups", `${FOLDER}/metadata.json`)).data.toString())
    expect(metadata.Status).toBe("Success")
    expect(metadata.ItemCounts.DeviceConfigurations).toBe(1)
    expect(metadata.ItemCounts.TotalPolicies).toBe(1)
    expect(Object.keys(metadata.Items)).toEqual([`DeviceConfigurations/${winnerId}`])
    expect(metadata.Items[`DeviceConfigurations/${winnerId}`].file).toBe(`${winnerName}.json`)
  })

  it("fails fast on Azure storage when the folder marker already exists", async () => {
    const saved = new Map<string, string>()
    const puts: Array<{ name: string; ifNoneMatch: string | null }> = []
    const graph = graphFor("Alpha", "a1")
    const azureFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname === "graph.microsoft.com") return graph(url)
      const name = decodeURIComponent(url.pathname.replace(/^\/intune-backups\//, ""))
      if (request.method === "PUT" && url.searchParams.get("restype") === "container") return new Response(null, { status: 201 })
      if (request.method === "PUT") {
        puts.push({ name, ifNoneMatch: request.headers.get("if-none-match") })
        if (request.headers.get("if-none-match") === "*" && saved.has(name)) {
          return new Response(
            `<?xml version="1.0" encoding="utf-8"?><Error><Code>ConditionNotMet</Code><Message>The condition specified using HTTP conditional header(s) is not met.</Message></Error>`,
            { status: 412, headers: { "x-ms-error-code": "ConditionNotMet" } },
          )
        }
        saved.set(name, await request.text())
        return new Response(null, { status: 201 })
      }
      if (request.method === "GET" && saved.has(name)) return new Response(saved.get(name), { status: 200 })
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    saved.set(`${FOLDER}/${BACKUP_OWNER_FILE}`, JSON.stringify({ Source: "TenuVault Desktop", TenantId: TENANT }))
    const engine = new BackupEngine({ fetch: azureFetch, getToken: async () => "token", now: () => new Date(FIXED) })
    const job = await settled(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: "contoso" }))

    expect(job.status).toBe("Failed")
    expect(job.exception).toContain(FOLDER)
    expect(job.exception).toContain("already in use")
    // Only the failed claim was attempted, with the conditional create header. No policy or manifest writes.
    expect(puts).toEqual([{ name: `${FOLDER}/${BACKUP_OWNER_FILE}`, ifNoneMatch: "*" }])
    expect([...saved.keys()]).toEqual([`${FOLDER}/${BACKUP_OWNER_FILE}`])
  })

  /** Azure storage that stores the first create-only PUT of `lost` but loses its response, and starts with `existing` blobs. */
  function lossyAzure(lost: string, existing: Record<string, string> = {}) {
    const saved = new Map(Object.entries(existing))
    const graph = graphFor("Alpha", "a1")
    let dropped = false
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname === "graph.microsoft.com") return graph(url)
      const name = decodeURIComponent(url.pathname.replace(/^\/intune-backups\//, ""))
      if (request.method === "PUT" && url.searchParams.get("restype") === "container") return new Response(null, { status: 201 })
      if (request.method === "PUT") {
        if (request.headers.get("if-none-match") === "*" && saved.has(name)) {
          return new Response(`<?xml version="1.0" encoding="utf-8"?><Error><Code>BlobAlreadyExists</Code></Error>`, { status: 409, headers: { "x-ms-error-code": "BlobAlreadyExists" } })
        }
        if (name === lost && !dropped) {
          dropped = true
          // The write commits on the server, then the connection resets before the response arrives.
          saved.set(name, await request.text())
          throw new TypeError("fetch failed")
        }
        saved.set(name, await request.text())
        return new Response(null, { status: 201 })
      }
      if (request.method === "GET" && saved.has(name)) return new Response(saved.get(name), { status: 200 })
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    return { saved, fetchImpl }
  }

  it("keeps its own folder claim when a retried claim finds the marker its lost first attempt wrote", async () => {
    const owner = `${FOLDER}/${BACKUP_OWNER_FILE}`
    const { saved, fetchImpl } = lossyAzure(owner)
    const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", now: () => new Date(FIXED) })
    const job = await settled(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: "contoso" }))

    expect(job.exception ?? "").not.toContain("already in use")
    expect(job.status).toBe("Completed")
    expect(JSON.parse(saved.get(owner)!)).toEqual({ Source: "TenuVault Desktop", TenantId: TENANT, RunId: job.id })
    expect(JSON.parse(saved.get(`${FOLDER}/metadata.json`)!).Status).toBe("Success")
  }, 15_000)

  it("still refuses a retried claim when the marker there belongs to another run", async () => {
    const owner = `${FOLDER}/${BACKUP_OWNER_FILE}`
    // The first attempt's response is lost and the retry finds a rival's marker, not this run's.
    const { saved, fetchImpl } = lossyAzure("never-written")
    const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.method === "PUT" && new URL(request.url).pathname.endsWith(BACKUP_OWNER_FILE) && !saved.has(owner)) {
        saved.set(owner, JSON.stringify({ Source: "TenuVault Desktop", TenantId: TENANT, RunId: "desktop-rival" }))
        throw new TypeError("fetch failed")
      }
      return fetchImpl(request)
    }) as unknown as typeof fetch
    const engine = new BackupEngine({ fetch: wrapped, getToken: async () => "token", now: () => new Date(FIXED) })
    const job = await settled(engine, engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: "contoso" }))

    expect(job.status).toBe("Failed")
    expect(job.exception).toContain("already in use")
    expect(JSON.parse(saved.get(owner)!).RunId).toBe("desktop-rival")
    expect(saved.has(`${FOLDER}/metadata.json`)).toBe(false)
  }, 15_000)
})
