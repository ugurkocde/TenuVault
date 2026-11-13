import { LEGACY_OTHER_TENANT_CODE, LEGACY_OTHER_TENANT_MESSAGE, LEGACY_SEALED_CODE, LEGACY_SEALED_MESSAGE, OVERSIZED_SEALED_CODE, OVERSIZED_SEALED_MESSAGE } from "../../shared/legacy-sealed"

/** An application failure that retries cannot repair, separate from request transport failures. */
export class FetchApplicationError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = "FetchApplicationError"
  }
}

/** An application failure before the fetch bridge or legacy backup reader attempts a network request. */
export class FetchPreconditionError extends FetchApplicationError {
  constructor(error: unknown) {
    super(error)
    this.name = "FetchPreconditionError"
  }
}

/**
 * A backup blob sealed by an earlier version that no key on this device opens for this tenant, or
 * (`otherTenant`) that opens only for another tenant signed in on this device. It keeps the
 * FetchApplicationError name, so every caller that handles unreadable blobs still does; `code`
 * tells the two apart (see shared/legacy-sealed.ts).
 */
export class LegacySealedError extends FetchApplicationError {
  readonly code: string
  constructor(cause?: unknown, otherTenant = false) {
    super(new Error(otherTenant ? LEGACY_OTHER_TENANT_MESSAGE : LEGACY_SEALED_MESSAGE, { cause }))
    this.code = otherTenant ? LEGACY_OTHER_TENANT_CODE : LEGACY_SEALED_CODE
  }
}

/** A legacy sealed blob over the backup size limit: refused at the cap, never buffered whole. */
export class OversizedSealedError extends FetchApplicationError {
  readonly code = OVERSIZED_SEALED_CODE
  constructor() {
    super(new Error(OVERSIZED_SEALED_MESSAGE))
  }
}

/** A request that got no HTTP response, because the host could not be reached or the connection timed out. */
export class NetworkUnreachableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "NetworkUnreachableError"
  }
}

/** A proxy answered 407: it requires a sign-in that was cancelled, not given, or not accepted. */
export class ProxyAuthRequiredError extends Error {
  constructor() {
    super("The proxy requires authentication (HTTP 407).")
    this.name = "ProxyAuthRequiredError"
  }
}

/** Chromium's codes for a proxy that asked for credentials it did not get or did not accept. */
const PROXY_AUTH_CODE = /PROXY_AUTH|UNEXPECTED_PROXY_AUTH/

/** What kind of transport failure a request met, as setup diagnostics report it. */
export type NetworkFailureKind = "proxy_auth" | "tls" | "proxy" | "timeout" | "unreachable"

/** The cause code of a request that got no HTTP response, from Chromium's message or Node's error.cause. */
function failureCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined
  return (error instanceof Error ? error.message.match(/\bERR_[A-Z0-9_]+\b/)?.[0] : undefined)
    ?? (typeof cause?.code === "string" ? cause.code : undefined)
}

/**
 * The kind of a request failure that got no HTTP response, or null when the error does not look
 * like a transport failure at all (so a caller can tell the network apart from other errors).
 */
export function networkFailureKind(error: unknown): NetworkFailureKind | null {
  if (!(error instanceof Error)) return null
  if (error.name === "ProxyAuthRequiredError") return "proxy_auth"
  const code = failureCode(error)
  if (code && PROXY_AUTH_CODE.test(code)) return "proxy_auth"
  if (code && /CERT|SSL|TLS|SIGNATURE|ISSUER/.test(code)) return "tls"
  if (code && /PROXY|TUNNEL|PAC_/.test(code)) return "proxy"
  if (error.name === "TimeoutError" || /TIMED_OUT|TIMEDOUT|TIMEOUT/.test(code ?? "")) return "timeout"
  return code || error.name === "NetworkUnreachableError" || error.message === "fetch failed" ? "unreachable" : null
}

/**
 * Explains a request that got no HTTP response (proxy, TLS inspection, DNS, firewall).
 *
 * Chromium's net.fetch names the cause in the message (`net::ERR_PROXY_CONNECTION_FAILED`);
 * Node's fetch says only "fetch failed" and keeps the cause code on `error.cause`.
 */
export function networkFailure(error: unknown, host: string): { code: string | undefined; guidance: string } {
  const code = failureCode(error)
  if (error instanceof Error && error.name === "ProxyAuthRequiredError") return { code: code ?? "HTTP 407", guidance: proxyAuthGuidance(host) }
  const kind = networkFailureKind(error)
  const guidance = kind === "proxy_auth"
    ? proxyAuthGuidance(host)
    : kind === "tls"
      ? `Ask IT to check this device's trusted certificates and HTTPS inspection for ${host}.`
      : kind === "proxy"
        ? `Check this device's proxy settings and ask IT to allow HTTPS requests to ${host}.`
        : kind === "timeout"
          ? "The request timed out. Check your connection and retry."
          : `Check your connection and ask IT to allow HTTPS requests to ${host}.`
  return { code, guidance }
}

function proxyAuthGuidance(host: string): string {
  return `The proxy on this network requires a sign-in. Enter the proxy user name and password when TenuVault asks, or ask IT to allow HTTPS requests to ${host} without proxy authentication.`
}

/**
 * Turns a 407 answer into a ProxyAuthRequiredError. Only a proxy sends 407, so it is never an
 * answer from Microsoft or the licensing service, and callers report it as proxy authentication.
 */
export function rejectProxyAuthResponses(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    if (response.status !== 407) return response
    void response.body?.cancel().catch(() => undefined)
    throw new ProxyAuthRequiredError()
  }
}

/** Rethrows a request failure with the host, guidance and cause code; aborts and timeouts pass through unchanged. */
export function describeNetworkFailure(error: unknown, host: string): unknown {
  if (!(error instanceof Error) || error instanceof FetchApplicationError || error.name === "AbortError" || error.name === "TimeoutError") return error
  const { code, guidance } = networkFailure(error, host)
  return new NetworkUnreachableError(`${host} could not be reached. ${guidance}${code ? ` (${code})` : ""}`, { cause: error })
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
