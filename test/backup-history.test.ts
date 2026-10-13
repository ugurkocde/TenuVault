import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST as listBackups } from "../src/portal/app/api/list-backups/route"
import { POST as backupChanges } from "../src/portal/app/api/backup-changes/route"
import { POST as restorePreview } from "../src/portal/app/api/restore-preview/route"

const args = { tenantId: "tenant", appId: "app", clientSecret: "test", storageAccountName: "store", subscriptionId: "local", resourceGroupName: "local" }
const request = (body: object) => new NextRequest("http://tenuvault.internal/api/test", { method: "POST", body: JSON.stringify({ ...args, ...body }) })
afterEach(() => vi.unstubAllGlobals())

const escape = (value: string) => value.replace(/&/g, "&amp;")

/** Serves an intune-backups container from memory, listing like Azure Blob Storage. */
function storage(blobs: Record<string, unknown>, graph: (url: URL) => Response = () => new Response("", { status: 404 })) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "token" })
    if (url.hostname === "graph.microsoft.com") return graph(url)
    if (url.searchParams.get("comp") === "list") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const names = Object.keys(blobs).filter((name) => name.startsWith(prefix))
      if (url.searchParams.get("delimiter") === "/") {
        const folders = [...new Set(names.map((name) => name.slice(0, name.indexOf("/", prefix.length) + 1)))]
        return new Response(`<EnumerationResults><Blobs>${folders.map((folder) => `<BlobPrefix><Name>${escape(folder)}</Name></BlobPrefix>`).join("")}</Blobs><NextMarker /></EnumerationResults>`)
      }
      return new Response(`<EnumerationResults><Blobs>${names.map((name) => `<Blob><Name>${escape(name)}</Name><Properties><Content-Length>${JSON.stringify(blobs[name]).length}</Content-Length></Properties></Blob>`).join("")}</Blobs><NextMarker /></EnumerationResults>`)
    }
    const name = decodeURIComponent(url.pathname.replace(/^\/intune-backups\//, ""))
    return name in blobs ? Response.json(blobs[name]) : new Response("", { status: 404 })
  }))
}

const fingerprint = (entries: Record<string, [string, string]>) => Object.fromEntries(Object.entries(entries).map(([key, [file, hash]]) => [key, { file, hash }]))

const older = "backup-2026-09-24-020000"
const newer = "backup-2026-09-25-020000"
const blobs = {
  [`${older}/metadata.json`]: { Status: "Success", DurationSeconds: 400, Trigger: "scheduled", Scope: { Excluded: [] }, Items: fingerprint({ "DeviceConfigurations/1": ["A.json", "a1"], "DeviceConfigurations/2": ["B.json", "b"], "Apps/9": ["Reader.json", "r"] }) },
  [`${older}/DeviceConfigurations/A.json`]: { id: "1", displayName: "A", value: 1 },
  [`${older}/DeviceConfigurations/B.json`]: { id: "2", displayName: "B" },
  [`${older}/Apps/Reader.json`]: { id: "9", displayName: "Reader" },
  [`${newer}/metadata.json`]: { Status: "Success", DurationSeconds: 42, Trigger: "manual", Scope: { Excluded: ["Apps"] }, Items: fingerprint({ "DeviceConfigurations/1": ["A.json", "a2"], "DeviceConfigurations/3": ["C & D.json", "c"] }) },
  [`${newer}/DeviceConfigurations/A.json`]: { id: "1", displayName: "A", value: 2 },
  [`${newer}/DeviceConfigurations/C & D.json`]: { id: "3", displayName: "C & D" },
  // A backup that stopped days ago without writing metadata.
  ["backup-2026-09-20-020000/DeviceConfigurations/X.json"]: { id: "x" },
}

describe("backup history", () => {
  it("reports real duration, trigger, scope, counts and item changes for the types both backups hold", async () => {
    storage(blobs)
    const { backups } = await (await listBackups(request({}))).json()
    expect(backups.map((backup: { id: string }) => backup.id)).toEqual([newer, older, "backup-2026-09-20-020000"])
    expect(backups[0]).toMatchObject({
      type: "manual",
      status: "Success",
      duration: 42,
      totalPolicies: 2,
      counts: { DeviceConfigurations: 2 },
      scope: { excluded: ["Apps"], description: "Everything except apps" },
      // Reader is not in the newer backup's scope, so it is not reported as deleted.
      changes: { added: 1, modified: 1, removed: 1 },
      comparedWith: older,
    })
    const stored = (name: string) => JSON.stringify(blobs[name as keyof typeof blobs]).length
    expect(backups[0].sizes).toEqual({ DeviceConfigurations: stored(`${newer}/DeviceConfigurations/A.json`) + stored(`${newer}/DeviceConfigurations/C & D.json`) })
    expect(backups[1].sizes).toEqual({ DeviceConfigurations: stored(`${older}/DeviceConfigurations/A.json`) + stored(`${older}/DeviceConfigurations/B.json`), Apps: stored(`${older}/Apps/Reader.json`) })
    expect(backups[1]).toMatchObject({ type: "scheduled", counts: { DeviceConfigurations: 2, Apps: 1 }, changes: null, comparedWith: null })
    expect(backups[2]).toMatchObject({ status: "incomplete", type: null, scope: null })
    expect(backups[0]).not.toHaveProperty("fingerprint")
  })

  it("lists the changed items with their changed settings", async () => {
    storage(blobs)
    const response = await backupChanges(request({ backupId: newer }))
    expect(response.status).toBe(200)
    const { comparedWith, changes } = await response.json()
    expect(comparedWith).toBe(older)
    expect(changes.map((change: { change: string; name: string }) => `${change.change} ${change.name}`)).toEqual(["removed B", "modified A", "added C & D"])
    expect(changes[1].fields).toEqual([{ field: "value", oldValue: 1, newValue: 2 }])
  })

  it("explains when a backup cannot be compared", async () => {
    storage(blobs)
    const response = await backupChanges(request({ backupId: "backup-2026-09-20-020000" }))
    expect(response.status).toBe(409)
  })
})

describe("restore preview", () => {
  it("names items, explains blockers and compares with the tenant without changing it", async () => {
    const preview = {
      [`${newer}/DeviceConfigurations/A.json`]: { id: "1", displayName: "A", value: 2 },
      [`${newer}/DeviceConfigurations/Gone.json`]: { id: "gone", displayName: "Gone" },
      [`${newer}/Apps/Reader.json`]: { id: "9", displayName: "Adobe Reader", "@odata.type": "#microsoft.graph.win32LobApp", assignments: [], relationships: [] },
    }
    const methods: string[] = []
    storage(preview, (url) => {
      methods.push(url.pathname)
      if (url.pathname.endsWith("/1")) return Response.json({ id: "1", displayName: "A", value: 2, version: 7, assignments: [] })
      if (url.pathname.endsWith("/9/relationships")) return Response.json({ value: [] })
      if (url.pathname.endsWith("/9")) return Response.json({ id: "9", displayName: "Adobe Reader", "@odata.type": "#microsoft.graph.win32LobApp", assignments: [] })
      return Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 })
    })
    const response = await restorePreview(request({ backupId: newer, paths: Object.keys(preview), live: true }))
    expect(response.status).toBe(200)
    const { items } = await response.json()
    expect(items[0]).toMatchObject({ name: "[Unverified legacy] A", live: "same", replaceBlocker: expect.stringContaining("not authenticated") })
    expect(items[1]).toMatchObject({ name: "[Unverified legacy] Gone", live: "missing" })
    expect(items[2]).toMatchObject({ name: "[Unverified legacy] Adobe Reader", live: "same", blocker: expect.stringContaining("Upload the installer again") })
    expect(methods.every((path) => path.startsWith("/beta/"))).toBe(true)
  })

  it("only accepts items from the chosen backup", async () => {
    storage({})
    expect((await restorePreview(request({ backupId: newer, paths: ["other/DeviceConfigurations/A.json"] }))).status).toBe(400)
  })
})
