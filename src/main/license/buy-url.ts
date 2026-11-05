/** Names the screen that opened the plans, without adding a user or tenant identifier. */
export function licenseBuyUrl(url: string, source?: unknown): string {
  if (typeof source !== "string" || !/^[a-z0-9-]{1,40}$/.test(source)) return url
  const parsed = new URL(url)
  parsed.searchParams.set("src", `app-${source}`)
  return parsed.href
}

const SOURCE = /^[a-z0-9-]{1,40}$/

/**
 * "Buy now": the licensing service's checkout route, which asks for payment right away
 * instead of starting another trial. Monthly and yearly are offered on the checkout page;
 * interval says which is selected first.
 */
export function licenseCheckoutUrl(apiBase: string, plan: unknown, source?: unknown, interval?: unknown): string {
  const url = new URL("/api/desktop-checkout", apiBase)
  url.searchParams.set("plan", plan === "msp" ? "msp" : "pro")
  if (interval === "yearly") url.searchParams.set("interval", "yearly")
  if (typeof source === "string" && SOURCE.test(source)) url.searchParams.set("src", `app-${source}`)
  return url.href
}

/**
 * The checkout for the customer of this machine's trial: the trial's entitlement token goes in
 * a POST body (never a URL) and the service answers with the checkout to open. Null when that
 * fails, so the caller opens the plain checkout instead.
 */
export async function trialCheckoutUrl(
  apiBase: string,
  token: string,
  options: { plan?: unknown; interval?: unknown; source?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(new URL("/api/desktop-checkout", apiBase).href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        plan: options.plan === "msp" ? "msp" : "pro",
        interval: options.interval === "yearly" ? "yearly" : "monthly",
        ...(typeof options.source === "string" && SOURCE.test(options.source) ? { src: `app-${options.source}` } : {}),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return null
    const data = (await response.json().catch(() => null)) as { url?: unknown } | null
    if (typeof data?.url !== "string") return null
    return new URL(data.url).protocol === "https:" ? data.url : null
  } catch {
    return null
  }
}
