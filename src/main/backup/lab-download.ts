import { closeSync, createReadStream, createWriteStream, fstatSync, linkSync, mkdtempSync, lstatSync, openSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

export type SaveDownload = (destination: string, content: string | Uint8Array | ReadableStream<Uint8Array>, signal?: AbortSignal) => Promise<void>

/** Pin the selected directory's identity and publish with a create-only operation. */
export function labDownloadDestination(destination: string, guard: (path: string) => void) {
  guard(destination)
  const directory = realpathSync.native(dirname(destination))
  const identity = statSync(directory, { bigint: true })
  const name = basename(destination)
  const within = <T>(action: () => T): T => {
    const previous = process.cwd()
    // The OS pins the working directory. Keep the change synchronous and use only relative
    // names in the filesystem operation, so swapping an ancestor cannot redirect publication.
    process.chdir(directory)
    try {
      const current = statSync(".", { bigint: true })
      if (!identity.ino || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("The selected download folder changed.")
      guard(join(process.cwd(), name))
      return action()
    } finally { process.chdir(previous) }
  }
  return async (content: Parameters<SaveDownload>[1], signal?: AbortSignal) => {
    const stage = within(() => mkdtempSync(".tenuvault-download-"))
    const temporary = join(stage, "partial")
    const fd = within(() => openSync(temporary, "wx", 0o600))
    const opened = fstatSync(fd, { bigint: true })
    try {
      await pipeline(typeof content === "string" || content instanceof Uint8Array ? Readable.from([content]) : Readable.fromWeb(content as never),
        createWriteStream(temporary, { fd, autoClose: false }), { signal })
      signal?.throwIfAborted()
      within(() => {
        const staged = lstatSync(temporary, { bigint: true, throwIfNoEntry: true })
        if (staged.dev !== opened.dev || staged.ino !== opened.ino) throw new Error("The staged download changed.")
        linkSync(temporary, name)
      })
    } finally {
      closeSync(fd)
      // If a path has been replaced, leave the partial file with its original directory.
      try { within(() => {
        const staged = lstatSync(temporary, { bigint: true })
        if (staged.dev === opened.dev && staged.ino === opened.ino) {
          unlinkSync(temporary)
          rmdirSync(stage)
        }
      }) } catch { /* The directory moved or the staged file was removed. */ }
    }
  }
}

export function stageLabDownload<T>(action: (path: string) => Promise<T>): Promise<T> {
  const staging = mkdtempSync(join(tmpdir(), "tenuvault-download-"))
  return action(join(staging, "download")).finally(() => rm(staging, { recursive: true, force: true }))
}

export function labDownloadStream(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
}
