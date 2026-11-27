import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { labDownloadDestination } from "../src/main/backup/lab-download"
import { guardLabBackupWrites, LAB_FOLDER_ERROR } from "../src/main/backup/lab-folder"
import { saveArchiveResponse } from "../src/main/backup/large-archive"

let root: string, stable: string, lab: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tv-lab-download-"))
  stable = join(root, "stable")
  lab = join(root, "lab")
  await Promise.all([mkdir(stable), mkdir(lab)])
})
afterEach(() => rm(root, { recursive: true, force: true }))

it("refuses a TAR export into the stable folder or its alias", async () => {
  const alias = join(root, "alias")
  await symlink(stable, alias, "junction")
  const stableArchive = join(stable, "archive.tar")
  await writeFile(stableArchive, "original")
  const save = (path: string, body: string | Uint8Array | ReadableStream<Uint8Array>) => labDownloadDestination(path, guardLabBackupWrites(stable))(body)
  for (const folder of [stable, alias]) {
    await expect(saveArchiveResponse(new Response("replacement"), async () => ({ canceled: false, filePath: join(folder, "archive.tar") }), save)).rejects.toThrow(LAB_FOLDER_ERROR)
  }
  expect(await readFile(stableArchive, "utf8")).toBe("original")
})

it("refuses a swapped destination during streaming and never writes into stable", async () => {
  const filename = "archive.zip"
  const save = labDownloadDestination(join(lab, filename), guardLabBackupWrites(stable))
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // The destination is swapped once the staged stream starts.
      if (controller.desiredSize === 0) {
        controller.enqueue(Buffer.from("archive"))
        await rename(lab, join(root, "moved"))
        await symlink(stable, lab, "junction")
        controller.close()
      }
    },
  }, { highWaterMark: 0 })
  await expect(save(body)).rejects.toThrow("selected download folder changed")
  await expect(readFile(join(stable, filename))).rejects.toMatchObject({ code: "ENOENT" })
})

it("publishes the exact selected bytes and preserves an existing download", async () => {
  const path = join(lab, "report.csv")
  const choose = () => labDownloadDestination(path, guardLabBackupWrites(stable))
  await choose()("original")
  await expect(choose()("replacement")).rejects.toMatchObject({ code: "EEXIST" })
  expect(await readFile(path, "utf8")).toBe("original")
})

it("removes a failed stage without publishing a partial download", async () => {
  const path = join(lab, "archive.zip")
  const save = labDownloadDestination(path, guardLabBackupWrites(stable))
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("download interrupted")) },
  })
  await expect(save(source)).rejects.toThrow("download interrupted")
  expect(await readdir(lab)).toEqual([])
})
