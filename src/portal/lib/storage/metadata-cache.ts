/** Metadata can contain large Items manifests, so entry count alone is not a memory budget. */
export const MAX_METADATA_CACHE_BYTES = 32 * 1024 * 1024
const MAX_ENTRIES = 4000

interface Entry<T> {
  version: string
  read: Promise<T>
  bytes: number
}

/** Counts serialized payload and key bytes, evicting the least recently used entry first. */
export class MetadataCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private retainedBytes = 0

  constructor(
    private readonly cacheable: (value: T) => boolean,
    private readonly maxBytes = MAX_METADATA_CACHE_BYTES,
  ) {}

  get bytes(): number { return this.retainedBytes }

  read(key: string, version: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key)
    if (cached?.version === version) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached.read
    }
    if (cached) this.remove(key, cached)
    const entry: Entry<T> = { version, read: load(), bytes: Buffer.byteLength(key) + Buffer.byteLength(version) }
    this.entries.set(key, entry)
    this.retainedBytes += entry.bytes
    this.evict()
    void entry.read.then(value => {
      if (this.entries.get(key) !== entry) return
      if (!this.cacheable(value)) { this.remove(key, entry); return }
      const bytes = Buffer.byteLength(JSON.stringify(value))
      this.retainedBytes += bytes
      entry.bytes += bytes
      this.evict()
    }).catch(() => this.remove(key, entry))
    return entry.read
  }

  private remove(key: string, entry: Entry<T>): void {
    if (this.entries.get(key) !== entry) return
    this.entries.delete(key)
    this.retainedBytes -= entry.bytes
  }

  private evict(): void {
    while (this.retainedBytes > this.maxBytes || this.entries.size > MAX_ENTRIES) {
      const [key, entry] = this.entries.entries().next().value!
      this.remove(key, entry)
    }
  }
}
