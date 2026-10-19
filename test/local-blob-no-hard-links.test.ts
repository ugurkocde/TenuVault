import { mkdtempSync, readdirSync } from "node:fs"
import * as fileSystem from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BlobAlreadyExistsError, LocalBlobStore } from "../src/main/storage/local-blob-store"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, link: vi.fn(actual.link) }
})

const ACCOUNT = "tvlocal-11111111-1111-1111-1111-111111111111"
const CONTAINER = "intune-backups"

afterEach(() => {
  vi.mocked(fileSystem.link).mockReset()
})

/** A store whose file system refuses hard links with `code`, like exFAT, FAT32 or some SMB shares. */
async function withoutHardLinks(code: string) {
  vi.mocked(fileSystem.link).mockRejectedValue(Object.assign(new Error(`${code}: operation not supported, link`), { code }))
  const root = mkdtempSync(join(tmpdir(), "tv-nolink-"))
  const key = randomBytes(32)
  const store = new LocalBlobStore(root, [key])
  await store.createContainer(ACCOUNT, CONTAINER)
  // Another store instance, as in another process, with its own cache.
  return { root, store, rival: new LocalBlobStore(root, [key]) }
}

describe("LocalBlobStore on a file system without hard links", () => {
  for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
    it(`creates blobs once and refuses a second create when link fails with ${code}`, async () => {
      const { root, store, rival } = await withoutHardLinks(code)
      await store.put(ACCOUNT, CONTAINER, "backup-1/.tenuvault-owner.json", Buffer.from("first"), "application/json", true)
      expect((await store.get(ACCOUNT, CONTAINER, "backup-1/.tenuvault-owner.json")).data.toString()).toBe("first")

      await expect(rival.put(ACCOUNT, CONTAINER, "backup-1/.tenuvault-owner.json", Buffer.from("second"), "application/json", true)).rejects.toBeInstanceOf(BlobAlreadyExistsError)
      expect((await store.get(ACCOUNT, CONTAINER, "backup-1/.tenuvault-owner.json")).data.toString()).toBe("first")
      // No temporary or empty claim file is left behind.
      expect(readdirSync(join(root, ACCOUNT, CONTAINER)).filter((file) => !file.endsWith(".tvb"))).toEqual([])
      expect(readdirSync(join(root, ACCOUNT, CONTAINER))).toHaveLength(1)
    })
  }

  it("lets only one of two concurrent creates win", async () => {
    const { store, rival } = await withoutHardLinks("EPERM")
    const results = await Promise.allSettled([
      store.put(ACCOUNT, CONTAINER, "claim.json", Buffer.from("a"), "application/json", true),
      rival.put(ACCOUNT, CONTAINER, "claim.json", Buffer.from("b"), "application/json", true),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(BlobAlreadyExistsError)
  })

  it("tries a hard link only until the file system refuses one", async () => {
    const { store } = await withoutHardLinks("ENOTSUP")
    for (const name of ["a.json", "b.json", "c.json"]) await store.put(ACCOUNT, CONTAINER, name, Buffer.from("{}"), "application/json", true)
    expect(vi.mocked(fileSystem.link)).toHaveBeenCalledTimes(1)
    expect((await store.list(ACCOUNT, CONTAINER)).map((blob) => blob.name)).toEqual(["a.json", "b.json", "c.json"])
  })

  it("still fails on other link errors", async () => {
    const { store } = await withoutHardLinks("EIO")
    await expect(store.put(ACCOUNT, CONTAINER, "a.json", Buffer.from("{}"), "application/json", true)).rejects.toThrow("EIO")
  })
})
