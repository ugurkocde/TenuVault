/** Names the screen that opened the plans, without adding a user or tenant identifier. */
export function licenseBuyUrl(url: string, source?: unknown): string {
  if (typeof source !== "string" || !/^[a-z0-9-]{1,40}$/.test(source)) return url
  const parsed = new URL(url)
  parsed.searchParams.set("src", `app-${source}`)
  return parsed.href
}
