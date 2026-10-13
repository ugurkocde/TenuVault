/**
 * Shared polling lifecycle for renderer job stores. One poller owns the timer,
 * per-key in-flight dedupe, cancellation on untrack and error routing, so each
 * job store only describes what to fetch and how to apply it.
 */
export interface JobPoller<Key> {
  /** Starts polling `key`; a key already tracked is not polled twice. */
  track: (key: Key, options?: { immediate?: boolean }) => void
  /** Stops polling `key` and discards any response still in flight for it. */
  untrack: (key: Key) => void
  /** Polls `key` once now when it is tracked and not already in flight. */
  pollNow: (key: Key) => void
  isTracked: (key: Key) => boolean
  /** Stops every key and clears the timer, for provider unmount. */
  stopAll: () => void
  readonly size: number
}

export function createJobPoller<Key>(options: {
  intervalMs: number
  poll: (key: Key, isCurrent: () => boolean) => Promise<void>
  onError?: (key: Key, error: unknown) => void
}): JobPoller<Key> {
  const tracked = new Set<Key>()
  const inFlight = new Set<Key>()
  const generations = new Map<Key, number>()
  let timer: ReturnType<typeof setInterval> | undefined

  function syncTimer() {
    if (tracked.size && !timer) timer = setInterval(() => { for (const key of tracked) run(key) }, options.intervalMs)
    if (!tracked.size && timer) { clearInterval(timer); timer = undefined }
  }

  function run(key: Key) {
    if (!tracked.has(key) || inFlight.has(key)) return
    inFlight.add(key)
    const generation = generations.get(key) ?? 0
    const isCurrent = () => tracked.has(key) && (generations.get(key) ?? 0) === generation
    void options.poll(key, isCurrent)
      .catch((error: unknown) => { if (isCurrent()) options.onError?.(key, error) })
      .finally(() => { inFlight.delete(key) })
  }

  return {
    track(key, trackOptions) {
      if (tracked.has(key)) return
      tracked.add(key)
      generations.set(key, (generations.get(key) ?? 0) + 1)
      syncTimer()
      if (trackOptions?.immediate !== false) run(key)
    },
    untrack(key) {
      if (!tracked.delete(key)) return
      generations.set(key, (generations.get(key) ?? 0) + 1)
      syncTimer()
    },
    pollNow(key) { run(key) },
    isTracked: (key) => tracked.has(key),
    stopAll() {
      tracked.clear()
      for (const key of generations.keys()) generations.set(key, (generations.get(key) ?? 0) + 1)
      syncTimer()
    },
    get size() { return tracked.size },
  }
}
