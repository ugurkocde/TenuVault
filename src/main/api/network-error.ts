/**
 * Explains a request that got no HTTP response (proxy, TLS inspection, DNS, firewall).
 *
 * Chromium's net.fetch names the cause in the message (`net::ERR_PROXY_CONNECTION_FAILED`);
 * Node's fetch says only "fetch failed" and keeps the cause code on `error.cause`.
 */
export function networkFailure(error: unknown, host: string): { code: string | undefined; guidance: string } {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined
  const code = (error instanceof Error ? error.message.match(/\bERR_[A-Z0-9_]+\b/)?.[0] : undefined)
    ?? (typeof cause?.code === "string" ? cause.code : undefined)
  const guidance = code && /CERT|SSL|TLS|SIGNATURE|ISSUER/.test(code)
    ? `Ask IT to check this device's trusted certificates and HTTPS inspection for ${host}.`
    : code && /PROXY|TUNNEL|PAC_/.test(code)
      ? `Check this device's proxy settings and ask IT to allow HTTPS requests to ${host}.`
      : error instanceof Error && (error.name === "TimeoutError" || /TIMED_OUT|TIMEDOUT|TIMEOUT/.test(code ?? ""))
        ? "The request timed out. Check your connection and retry."
        : `Check your connection and ask IT to allow HTTPS requests to ${host}.`
  return { code, guidance }
}

/** Rethrows a request failure with the host, guidance and cause code; aborts and timeouts pass through unchanged. */
export function describeNetworkFailure(error: unknown, host: string): unknown {
  if (!(error instanceof Error) || error.name === "AbortError" || error.name === "TimeoutError") return error
  const { code, guidance } = networkFailure(error, host)
  return new Error(`${host} could not be reached. ${guidance}${code ? ` (${code})` : ""}`, { cause: error })
}

/** Wraps the fetch that goes to the network so its failures name the host and cause. */
export function withNetworkErrors(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init)
    } catch (error) {
      throw describeNetworkFailure(error, new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host)
    }
  }
}
