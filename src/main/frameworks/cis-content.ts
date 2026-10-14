import { validateCisCatalog, validateCisPack, type CisCatalog, type CisLevel, type CisPack } from "../../shared/frameworks/cis-content"

export const CIS_CONTENT_BASE_URL_ENV = "TENUVAULT_CIS_CONTENT_BASE_URL"
export const CIS_CONTENT_TIMEOUT_MS = 15_000
export const CIS_CONTENT_NOT_CONFIGURED_MESSAGE = "The CIS content delivery service is not configured. Set TENUVAULT_CIS_CONTENT_BASE_URL in the main process environment to load benchmarks from TenuVault."

export class CisContentError extends Error {
  constructor(message: string, public status = 502) { super(message) }
}

/** The configured delivery base URL without a trailing slash, or null when not configured. */
export function cisContentBaseUrl(): string | null {
  const raw = process.env[CIS_CONTENT_BASE_URL_ENV]
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().replace(/\/+$/, "")
  return trimmed ? trimmed : null
}

async function fetchJson(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(CIS_CONTENT_TIMEOUT_MS) })
  } catch {
    throw new CisContentError("The CIS content delivery service could not be reached.", 502)
  }
  if (!response.ok) throw new CisContentError(`The CIS content delivery service returned ${response.status}.`, response.status)
  try {
    return await response.json()
  } catch {
    throw new CisContentError("The CIS content delivery service returned an invalid response.", 502)
  }
}

function requireBaseUrl(): string {
  const base = cisContentBaseUrl()
  if (!base) throw new CisContentError(CIS_CONTENT_NOT_CONFIGURED_MESSAGE, 400)
  return base
}

function toCisContentError(error: unknown): CisContentError {
  if (error instanceof CisContentError) return error
  return new CisContentError(error instanceof Error ? error.message : "The CIS content delivery service returned an invalid response.", 502)
}

/** Loads and validates the catalog of benchmarks available from the delivery service. */
export async function fetchCisCatalog(): Promise<CisCatalog> {
  const base = requireBaseUrl()
  try {
    const json = await fetchJson(`${base}/cis/v1/catalog`)
    return validateCisCatalog(json)
  } catch (error) {
    throw toCisContentError(error)
  }
}

/** Loads and validates one benchmark pack for the requested identity. */
export async function fetchCisPack(expected: { benchmark: string; version: string; level: CisLevel }): Promise<CisPack> {
  const base = requireBaseUrl()
  const url = `${base}/cis/v1/packs/${encodeURIComponent(expected.benchmark)}/${encodeURIComponent(expected.version)}/${expected.level}`
  try {
    const json = await fetchJson(url)
    return validateCisPack(json, expected)
  } catch (error) {
    throw toCisContentError(error)
  }
}
