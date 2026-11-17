import { mkdtemp, open, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

/** External merge sort: pages are temporary private runs, with one buffered head per run. */
export class SortedSpool<T extends { id: string }> {
  private root = mkdtemp(join(tmpdir(), "tv-sort-"))
  private runs: string[] = []
  constructor(private readonly limit = 500_000, private readonly signal?: AbortSignal) {}
  private count = 0
  async add(entries: T[]): Promise<void> {
    this.signal?.throwIfAborted()
    if ((this.count += entries.length) > this.limit) throw new Error("The large inventory object limit was reached")
    if (!entries.length) return
    const file = join(await this.root, `${this.runs.length}.jsonl`)
    await writeFile(file, entries.sort((a, b) => a.id.toLowerCase() < b.id.toLowerCase() ? -1 : a.id.toLowerCase() > b.id.toLowerCase() ? 1 : 0).map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600, signal: this.signal })
    this.runs.push(file)
    // Bound open descriptors and merge buffers even when Graph returns tiny pages.
    if (this.runs.length === 64) {
      const output = join(await this.root, "merged.jsonl")
      const handle = await open(output, "wx", 0o600)
      try { for await (const entry of this.entries()) await handle.write(JSON.stringify(entry) + "\n") }
      finally { await handle.close() }
      await Promise.all(this.runs.map(file => rm(file)))
      const target = join(await this.root, "0.jsonl")
      await rename(output, target)
      this.runs = [target]
    }
  }
  async *entries(): AsyncGenerator<T> {
    const streams = this.runs.map(file => createReadStream(file, { highWaterMark: 4096 }))
    const readers = streams.map(input => createInterface({ input, crlfDelay: Infinity }))
    const iterators = readers.map(reader => reader[Symbol.asyncIterator]())
    try {
      const heads: (T | null)[] = await Promise.all(iterators.map(async iterator => { const next = await iterator.next(); return next.done ? null : JSON.parse(next.value) as T }))
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
        heads[best] = next.done ? null : JSON.parse(next.value) as T
      }
    } finally { readers.forEach(reader => reader.close()); streams.forEach(stream => stream.destroy()) }
  }
  async close(): Promise<void> { await rm(await this.root, { recursive: true, force: true }) }
}
