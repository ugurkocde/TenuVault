import { type NextRequest, NextResponse } from "next/server"
import { graphCaller, type GraphCall } from "~/lib/policies/graph-restore"
import { buildSettingsCatalog, deprecatedHits, type DeprecatedSettingHit } from "../../../../shared/intune/settings-catalog"
import type { Item } from "../../../../shared/intune/registry"

const GRAPH = "https://graph.microsoft.com/beta/"
const MAX_IDS = 10_000
const MAX_PAGES = 500

async function token(tenantId: string, appId: string, clientSecret: string, scope: string, forceRefresh = false): Promise<string> {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope, force_refresh: String(forceRefresh), grant_type: "client_credentials" }),
  })
  if (!response.ok) throw new Error("Failed to get access token")
  return (await response.json()).access_token as string
}

class CatalogReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "CatalogReadError"
  }
}

function graphMessage(body: Item, status: number): string {
  const message = typeof (body.error as Item | undefined)?.message === "string" ? (body.error as Item).message as string : ""
  try {
    const inner = JSON.parse(message) as { Message?: string }
    if (inner.Message) return inner.Message.split(" - Operation ID")[0]!
  } catch {
    /* plain message */
  }
  return message || `Microsoft Graph returned ${status}`
}

/**
 * Every catalog definition, following @odata.nextLink inside the Graph origin only.
 * Without `$top` the service returns the whole catalog in one response; `$top` would
 * truncate it silently, so it is never sent (verified, see the hygiene catalog read).
 */
async function readCatalog(graph: GraphCall): Promise<Item[]> {
  const definitions: Item[] = []
  const seen = new Set<string>()
  let next: string | undefined = "deviceManagement/configurationSettings?$select=id,displayName,description"
  while (next) {
    if (seen.has(next) || seen.size >= MAX_PAGES) throw new CatalogReadError("Microsoft Graph returned a repeated or endless listing", 502)
    seen.add(next)
    if (/^https?:/i.test(next) && !next.startsWith(GRAPH)) throw new CatalogReadError("Invalid Graph continuation link", 502)
    const response = await graph("GET", next.startsWith(GRAPH) ? next.slice(GRAPH.length) : next)
    if (response.status !== 200) throw new CatalogReadError(graphMessage(response.body, response.status), response.status)
    if (!Array.isArray(response.body.value)) throw new CatalogReadError("Microsoft Graph returned an invalid collection", 502)
    definitions.push(...(response.body.value as Item[]))
    next = typeof response.body["@odata.nextLink"] === "string" ? response.body["@odata.nextLink"] : undefined
  }
  return definitions
}

/**
 * Which of the given setting definition IDs the current Settings Catalog marks deprecated:
 *   POST /api/settings-catalog-check { tenantId, appId, clientSecret, definitionIds }
 * Read only: one catalog read on Microsoft Graph, no tenant or storage writes. The caller
 * (the restore wizard) extracts the IDs from snapshots it already holds. A catalog that
 * cannot be read, including an empty answer, is reported as unavailable with the reason and
 * no settings, never as "nothing deprecated", so the restore can continue without the check.
 * Only marked or missing IDs are returned.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const { tenantId, appId, clientSecret, definitionIds } = body as {
    tenantId?: string; appId?: string; clientSecret?: string; definitionIds?: unknown
  }
  if (!tenantId || !appId || !clientSecret) {
    return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
  }
  if (!Array.isArray(definitionIds) || definitionIds.length > MAX_IDS || !definitionIds.every((id) => typeof id === "string" && id.length >= 1 && id.length <= 512)) {
    return NextResponse.json({ error: "definitionIds must be an array of setting definition IDs" }, { status: 400 })
  }
  const ids = [...new Set(definitionIds as string[])]
  const unavailable = (reason: string) => NextResponse.json({ catalog: { state: "unavailable", checkedAt: null, total: null, reason }, settings: {} })
  if (!ids.length) return unavailable("No Settings Catalog settings were given to check.")

  let graphToken: string
  try {
    graphToken = await token(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default")
  } catch {
    return unavailable("Microsoft Graph is unavailable (sign in to this tenant), so deprecated settings could not be checked.")
  }
  const graph = graphCaller(graphToken, fetch, { tenant: tenantId, refreshToken: () => token(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default", true) })
  try {
    const definitions = await readCatalog(graph)
    if (!definitions.length) return unavailable("Microsoft Graph returned an empty Settings Catalog, so deprecated settings could not be checked.")
    const catalog = buildSettingsCatalog(definitions)
    const settings: Record<string, { displayName: string | null; state: DeprecatedSettingHit["state"] }> = {}
    for (const hit of deprecatedHits(ids, catalog)) settings[hit.definitionId] = { displayName: hit.displayName, state: hit.state }
    return NextResponse.json({
      catalog: { state: "checked", checkedAt: new Date().toISOString(), total: definitions.length, reason: null },
      settings,
    })
  } catch (error) {
    if (error instanceof CatalogReadError && (error.status === 401 || error.status === 403)) {
      return unavailable("The Settings Catalog cannot be read with this app's permissions (DeviceManagementConfiguration.Read.All is required), so deprecated settings could not be checked.")
    }
    const detail = error instanceof Error ? error.message : "unknown error"
    return unavailable(`The Settings Catalog could not be read (${detail.slice(0, 200)}), so deprecated settings could not be checked.`)
  }
}
