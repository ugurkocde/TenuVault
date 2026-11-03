/** Names the screen that opened the plans, without adding a user or tenant identifier. */
export function licenseBuyUrl(url: string, source?: unknown): string {
  if (typeof source !== "string" || !/^[a-z0-9-]{1,40}$/.test(source)) return url
  const parsed = new URL(url)
  parsed.searchParams.set("src", `app-${source}`)
  return parsed.href
}

/**
 * "Buy now": the licensing service's checkout route, which asks for payment right away
 * instead of starting another trial. Monthly and yearly are offered on the checkout page.
 */
export function licenseCheckoutUrl(apiBase: string, plan: unknown, source?: unknown): string {
  const url = new URL("/api/desktop-checkout", apiBase)
  url.searchParams.set("plan", plan === "msp" ? "msp" : "pro")
  if (typeof source === "string" && /^[a-z0-9-]{1,40}$/.test(source)) url.searchParams.set("src", `app-${source}`)
  return url.href
}
