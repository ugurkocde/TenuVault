import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Readable } from "node:stream"
import { captureLarge } from "../src/main/backup/large"
import { exportLargeArchive, importLargeArchive, reviewLargeArchive, saveLargeDownload } from "../src/main/backup/large-archive"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { testType, TENANT } from "./helpers/backup-fixture"
const type = testType("DeviceConfigurations", "synthetic", { volume: "large", listOnly: true, neverStoredKeys: ["secretText"], extras: [{ property: "definitions", path: () => "children" }] })
async function capture(entries: Array<Record<string, any>>, reverse = false) {
  const files = new Map<string, any>()
  const index = await captureLarge({ type, reader: { get: async () => { throw new Error("unused") }, list: async () => { throw new Error("unused") } }, pages: async function* (path) {
    if (path === "synthetic") yield [{ id: "parent" }]
    else for (const entry of reverse ? [...entries].reverse() : entries) yield [entry]
  }, put: async (name, body) => { files.set(name, JSON.parse(body)) }, saved: () => {}, signal: new AbortController().signal })
  return { files, index }
}
it("streams definitions as sorted object shards, strips forbidden fields and fingerprints stable content", async () => {
  const entries = [{ id: "z", subject: "definition", secretText: "never keep" }, { id: "a", nested: { secretText: "never keep", issuer: "synthetic" } }]
  const before = await capture(entries), after = await capture(entries, true)
  expect(before.files.get("DeviceConfigurations/parent.json")).toEqual(after.files.get("DeviceConfigurations/parent.json"))
  expect(before.files.get("DeviceConfigurations/parent.json").definitions).toMatchObject({ format: "sorted-object-shards-v1", count: 2, shards: 1, complete: true })
  expect(before.files.get("_relations/DeviceConfigurations/parent/definitions/000000.json")).toEqual([{ id: "a", nested: { issuer: "synthetic" } }, { id: "z", subject: "definition" }])
  expect(JSON.stringify([...before.files])).not.toContain("never keep")
})
it.each([{ id: "too-big", text: "x".repeat(8192) }, { id: "unfinished", "nested@odata.nextLink": "https://graph.microsoft.com/v1.0/synthetic" }])("refuses incomplete or oversized definitions before publishing a parent", async definition => {
  await expect(capture([definition])).rejects.toThrow("definition")
})
it("exports, reviews and imports complete object sub-collections", async () => {
  const root = await mkdtemp(join(tmpdir(), "tv-object-shards-"))
  try {
    const { files, index } = await capture([{ id: "a", subject: "synthetic" }])
    const id = "backup-2026-11-16-000000", path = join(root, "archive.tar")
    const metadata = { TenantId: TENANT, BackupFolder: id, Status: "Success", Failures: 0, Coverage: "Complete", Items: {}, ItemCounts: { DeviceConfigurations: 1, TotalPolicies: 1 }, LargeItems: { DeviceConfigurations: index } }
    await saveLargeDownload(Readable.toWeb(Readable.from(exportLargeArchive(TENANT, id, metadata, async name => files.get(name)))) as ReadableStream<Uint8Array>, path)
    const archive = await reviewLargeArchive(path)
    const store = new LocalBlobStore(join(root, "encrypted"), [Buffer.alloc(32, 8)])
    await importLargeArchive(store, archive)
    const stored = await store.get(`tvlocal-${TENANT}`, "intune-backups", `${id}/_relations/DeviceConfigurations/parent/definitions/000000.json`)
    expect(JSON.parse(stored.data.toString())).toEqual([{ id: "a", subject: "synthetic" }])
    files.set("_relations/DeviceConfigurations/parent/definitions/000000.json", [{ id: "a", subject: "changed" }])
    await expect(saveLargeDownload(Readable.toWeb(Readable.from(exportLargeArchive(TENANT, id, metadata, async name => files.get(name)))) as ReadableStream<Uint8Array>, join(root, "changed.tar"))).rejects.toThrow("fingerprint")
  } finally { await rm(root, { recursive: true, force: true }) }
})
