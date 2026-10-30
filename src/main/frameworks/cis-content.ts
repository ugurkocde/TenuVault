import { BENCHMARK_ID_PATTERN, MAX_CIS_BENCHMARK_ID_LENGTH, VERSION_PATTERN, validateCisCatalog, validateCisPack, type CisCatalog, type CisLevel, type CisPack } from "../../shared/frameworks/cis-content"

export const CIS_CONTENT_BASE_URL_ENV = "TENUVAULT_CIS_CONTENT_BASE_URL"
export const CIS_CONTENT_TIMEOUT_MS = 15_000
export const CIS_CATALOG_MAX_BYTES = 1_000_000
export const CIS_PACK_MAX_BYTES = 8_000_000
export const CIS_CONTENT_NOT_CONFIGURED_MESSAGE = "The CIS content delivery service is not configured. Set TENUVAULT_CIS_CONTENT_BASE_URL in the main process environment to load benchmarks from TenuVault."
const CIS_CONTENT_INVALID_BASE_URL_MESSAGE = "The CIS content delivery service base URL is invalid. Set TENUVAULT_CIS_CONTENT_BASE_URL to an https URL without credentials, a query string or a fragment."
const CIS_CONTENT_UNREACHABLE_MESSAGE = "The CIS content delivery service could not be reached."
const CIS_CONTENT_INVALID_RESPONSE_MESSAGE = "The CIS content delivery service returned an invalid response."
export const CIS_CONTENT_ENTITLEMENT_REQUIRED_MESSAGE = "CIS benchmark delivery requires a current license entitlement for this tenant."

let fallbackBaseUrl: string | null = null
/** Bootstrap hook: the license API origin injected at build time, used when the env override is unset. */
export function setCisContentFallbackBaseUrl(value: string | null): void { fallbackBaseUrl = value }

let envOverrideAllowed = true
/**
 * Bootstrap hook: whether the TENUVAULT_CIS_CONTENT_BASE_URL environment override is honored.
 * The app bootstrap disables it in packaged builds, where the entitlement token must only
 * ever be sent to the built-in license origin; whoever controls a development launch
 * environment may still point the client at a local delivery service.
 */
export function setCisContentEnvOverrideAllowed(allowed: boolean): void { envOverrideAllowed = allowed }

export class CisContentError extends Error {
  constructor(message: string, public status = 502) { super(message) }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
}

/** The configured delivery base URL without a trailing slash, or null when not configured. */
export function cisContentBaseUrl(): string | null {
  const raw = (envOverrideAllowed ? process.env[CIS_CONTENT_BASE_URL_ENV] : undefined) ?? fallbackBaseUrl ?? undefined
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new CisContentError(CIS_CONTENT_INVALID_BASE_URL_MESSAGE, 400)
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CisContentError(CIS_CONTENT_INVALID_BASE_URL_MESSAGE, 400)
  }
  const isLocalHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new CisContentError(CIS_CONTENT_INVALID_BASE_URL_MESSAGE, 400)
  }
  return trimmed.replace(/\/+$/, "")
}

function tooLargeError(maxBytes: number): CisContentError {
  return new CisContentError(`The CIS content delivery service response exceeds the ${maxBytes} byte limit.`, 502)
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLargeError(maxBytes)
  }
  if (!response.body) {
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      if (isTimeoutError(error)) throw new CisContentError(CIS_CONTENT_UNREACHABLE_MESSAGE, 502)
      throw new CisContentError(CIS_CONTENT_INVALID_RESPONSE_MESSAGE, 502)
    }
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooLargeError(maxBytes)
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          try { await reader.cancel() } catch { /* The overflow error below is the result. */ }
          throw tooLargeError(maxBytes)
        }
        chunks.push(value)
      }
    }
  } catch (error) {
    if (error instanceof CisContentError) throw error
    if (isTimeoutError(error)) throw new CisContentError(CIS_CONTENT_UNREACHABLE_MESSAGE, 502)
    throw new CisContentError(CIS_CONTENT_INVALID_RESPONSE_MESSAGE, 502)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function fetchJson(url: string, maxBytes: number, entitlementToken: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${entitlementToken}` }, redirect: "error", signal: AbortSignal.timeout(CIS_CONTENT_TIMEOUT_MS) })
  } catch {
    throw new CisContentError(CIS_CONTENT_UNREACHABLE_MESSAGE, 502)
  }
  if (response.status >= 300 && response.status < 400) {
    throw new CisContentError(`The CIS content delivery service returned ${response.status}.`, response.status)
  }
  if (!response.ok) throw new CisContentError(`The CIS content delivery service returned ${response.status}.`, response.status)
  const text = await readBodyWithCap(response, maxBytes)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new CisContentError(CIS_CONTENT_INVALID_RESPONSE_MESSAGE, 502)
  }
}

function requireBaseUrl(): string {
  const base = cisContentBaseUrl()
  if (!base) throw new CisContentError(CIS_CONTENT_NOT_CONFIGURED_MESSAGE, 400)
  return base
}

function validatePackIdentity(expected: { benchmark: string; version: string; level: CisLevel }): void {
  if (typeof expected.benchmark !== "string" || expected.benchmark.length > MAX_CIS_BENCHMARK_ID_LENGTH || !BENCHMARK_ID_PATTERN.test(expected.benchmark)
    || typeof expected.version !== "string" || !VERSION_PATTERN.test(expected.version)
    || (expected.level !== 1 && expected.level !== 2)) {
    throw new CisContentError("Select a benchmark, version and level.", 400)
  }
}

function toCisContentError(error: unknown): CisContentError {
  if (error instanceof CisContentError) return error
  return new CisContentError(error instanceof Error ? error.message : CIS_CONTENT_INVALID_RESPONSE_MESSAGE, 502)
}

function requireEntitlementToken(entitlementToken: string | null): string {
  if (typeof entitlementToken !== "string" || !entitlementToken.trim()) {
    throw new CisContentError(CIS_CONTENT_ENTITLEMENT_REQUIRED_MESSAGE, 401)
  }
  return entitlementToken
}

/**
 * Loads and validates the catalog of benchmarks available from the delivery service.
 * The caller's license entitlement token travels as a bearer credential; the service
 * decides whether it may receive CIS content. Without a token nothing is requested.
 */
export async function fetchCisCatalog(entitlementToken: string | null): Promise<CisCatalog> {
  const token = requireEntitlementToken(entitlementToken)
  const base = requireBaseUrl()
  try {
    const json = await fetchJson(`${base}/cis/v1/catalog`, CIS_CATALOG_MAX_BYTES, token)
    return validateCisCatalog(json)
  } catch (error) {
    throw toCisContentError(error)
  }
}

/** Loads and validates one benchmark pack for the requested identity. */
export async function fetchCisPack(expected: { benchmark: string; version: string; level: CisLevel }, entitlementToken: string | null): Promise<CisPack> {
  validatePackIdentity(expected)
  const token = requireEntitlementToken(entitlementToken)
  const base = requireBaseUrl()
  const url = `${base}/cis/v1/packs/${encodeURIComponent(expected.benchmark)}/${encodeURIComponent(expected.version)}/${expected.level}`
  try {
    const json = await fetchJson(url, CIS_PACK_MAX_BYTES, token)
    return validateCisPack(json, expected)
  } catch (error) {
    throw toCisContentError(error)
  }
}
