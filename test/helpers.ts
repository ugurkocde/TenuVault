export function memoryStore() {
  const values = new Map<string, string>()
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => void values.set(key, value),
    setMany: (changes: Record<string, string>) => { for (const [key, value] of Object.entries(changes)) values.set(key, value) },
    delete: (key: string) => void values.delete(key),
    values,
  }
}

/**
 * A body of `chunks` MiB with no content length, counting the chunks a reader pulled, so a test can
 * prove a reader stopped at its cap instead of buffering the whole body. `first` is sent before the
 * filler, for example a JSON prefix or a sealed envelope header.
 */
export function endlessBody(chunks = 40, first: Uint8Array = new Uint8Array(0)): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20)
  let pulled = 0
  let started = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started && first.byteLength) { started = true; controller.enqueue(first); return }
      if (pulled >= chunks) return controller.close()
      pulled++
      controller.enqueue(chunk)
    },
  })
  return { body, pulled: () => pulled }
}
