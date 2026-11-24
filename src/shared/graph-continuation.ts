/** Validates every page before credentials are attached, without rewriting Graph's paging token. */
export function graphContinuation(start: string, next: string, seen: Set<string>, filter?: string): string {
  const started = new URL(start)
  const parsed = new URL(next)
  const filtersOf = (url: URL) => [...url.searchParams].filter(([key]) => /^\$?filter$/i.test(key)).map(([, value]) => value)
  const allowed = filter === undefined ? filtersOf(started) : [filter]
  const required = filter ?? (allowed.length === 1 ? allowed[0] : undefined)
  const refuse = (reason: string) => new Error(`Invalid Graph continuation link (${reason}): ${parsed.origin === "https://graph.microsoft.com" ? parsed.pathname : "an address outside Microsoft Graph"}`)
  if (parsed.origin !== "https://graph.microsoft.com" || parsed.username || parsed.password) throw refuse("it leaves Microsoft Graph")
  if (parsed.href.includes("#")) throw refuse("it carries a fragment")
  if (!/^\/(beta|v1\.0)\//.test(started.pathname) || parsed.pathname.toLowerCase() !== started.pathname.toLowerCase()) throw refuse("it moves to another collection")
  if (seen.has(parsed.href)) throw refuse("it repeats a page: repeated continuation link")
  const filters = filtersOf(parsed)
  if (filters.some(value => !allowed.includes(value))) throw refuse("it names another filter")
  seen.add(parsed.href)
  return required !== undefined && !filters.length ? `${next}${parsed.search ? "&" : "?"}$filter=${encodeURIComponent(required)}` : next
}
