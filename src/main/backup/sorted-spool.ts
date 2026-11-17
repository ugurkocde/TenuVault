import { mkdtemp, open, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReadStream } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { Readable } from "node:stream"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/** External merge sort with encrypted temporary runs and one buffered head per run. */
export class SortedSpool<T extends { id: string }> {
  private root?: Promise<string>
  private directory(): Promise<string> { return this.root ??= mkdtemp(join(tmpdir(), "tv-sort-")) }
  private runs: string[] = []
  // A crash leaves ciphertext whose ephemeral key was never written to disk.
  private readonly key = randomBytes(32)
  private count = 0
  constructor(private readonly limit = 500_000, private readonly signal?: AbortSignal) {}

  async add(entries: T[]): Promise<void> {
    this.signal?.throwIfAborted()
    if ((this.count += entries.length) > this.limit) throw new Error("The large inventory object limit was reached")
    if (!entries.length) return
    const file = join(await this.directory(), `${this.runs.length}.run`)
    const plain = entries.sort((a, b) => a.id.toLowerCase() < b.id.toLowerCase() ? -1 : a.id.toLowerCase() > b.id.toLowerCase() ? 1 : 0).map(entry => JSON.stringify(entry)).join("\n") + "\n"
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv)
    const body = Buffer.concat([cipher.update(plain), cipher.final()])
    await writeFile(file, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600, signal: this.signal })
    this.runs.push(file)
    // Bound descriptors and merge buffers even when Graph returns tiny pages.
    if (this.runs.length === 64) {
      const output = join(await this.directory(), "merged.run")
      const handle = await open(output, "wx", 0o600)
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv)
      try {
        await handle.writeFile(Buffer.concat([iv, Buffer.alloc(16)]))
        for await (const entry of this.entries()) await handle.writeFile(cipher.update(JSON.stringify(entry) + "\n"))
        await handle.writeFile(cipher.final())
        const tag = cipher.getAuthTag()
        await handle.write(tag, 0, tag.length, 12)
      } finally { await handle.close() }
      await Promise.all(this.runs.map(file => rm(file)))
      const target = join(await this.directory(), "0.run")
      await rename(output, target)
      this.runs = [target]
    }
  }

  private stream(file: string): Readable {
    const key = this.key
    return Readable.from((async function* () {
      const handle = await open(file, "r")
      const header = Buffer.alloc(28)
      try {
        if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new Error("Truncated temporary sort run")
      } finally { await handle.close() }
      const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(0, 12))
      decipher.setAuthTag(header.subarray(12))
      const source = createReadStream(file, { start: 28, highWaterMark: 4096 })
      try {
        for await (const chunk of source) yield decipher.update(chunk as Buffer)
        yield decipher.final()
      } finally { source.destroy() }
    })())
  }

  private async *lines(stream: Readable): AsyncGenerator<T> {
    const decoder = new StringDecoder("utf8")
    let pending = ""
    for await (const chunk of stream) {
      pending += decoder.write(chunk as Buffer)
      let cut: number
      while ((cut = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, cut)
        pending = pending.slice(cut + 1)
        yield JSON.parse(line) as T
      }
    }
    if (pending + decoder.end()) throw new Error("Truncated temporary sort entry")
  }

  async *entries(): AsyncGenerator<T> {
    const streams = this.runs.map(file => this.stream(file))
    const iterators = streams.map(stream => this.lines(stream))
    try {
      const heads: (T | null)[] = await Promise.all(iterators.map(async iterator => { const next = await iterator.next(); return next.done ? null : next.value }))
      let previous = ""
      for (;;) {
        this.signal?.throwIfAborted()
        let best = -1
        for (let i = 0; i < heads.length; i++) if (heads[i] && (best < 0 || heads[i]!.id.toLowerCase() < heads[best]!.id.toLowerCase())) best = i
        if (best < 0) break
        const entry = heads[best]!
        if (entry.id.toLowerCase() === previous) throw new Error("The collection repeated an object ID")
        previous = entry.id.toLowerCase()
        yield entry
        const next = await iterators[best]!.next()
        heads[best] = next.done ? null : next.value
      }
    } finally {
      streams.forEach(stream => stream.destroy())
      await Promise.allSettled(iterators.map(iterator => iterator.return(undefined)))
    }
  }

  async close(): Promise<void> { if (this.root) await rm(await this.root, { recursive: true, force: true }) }
}
