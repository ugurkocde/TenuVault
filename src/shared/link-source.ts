const SOURCE = /^[a-z0-9-]{1,40}$/

/**
 * The `src` value of a link that names the screen it was opened from, such as `app-welcome`. It
 * carries no user or tenant identifier. Null for anything that is not a short lowercase name.
 */
export function appLinkSource(source: unknown): string | null {
  return typeof source === "string" && SOURCE.test(source) ? `app-${source}` : null
}

/** Adds the source to a link. A missing or invalid source leaves the link as it is. */
export function withAppLinkSource(url: string, source?: unknown): string {
  const src = appLinkSource(source)
  if (!src) return url
  const parsed = new URL(url)
  parsed.searchParams.set("src", src)
  return parsed.href
}
