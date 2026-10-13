/** Runs `task` for every entry with at most `limit` running at once; results keep the entries' order. */
export async function mapLimit<T, R>(entries: T[], limit: number, task: (entry: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(entries.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++
      results[index] = await task(entries[index]!)
    }
  }))
  return results
}
