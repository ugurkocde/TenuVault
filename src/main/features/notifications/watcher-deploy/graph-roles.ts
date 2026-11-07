import type { FeatureDeps } from "../../deps"
import { brief } from "../service"

const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000"

export interface GraphRoleCheck {
  status: "verified" | "missing" | "unknown"
  missing: string[]
  detail: string | null
}

interface ResolvedRoles { graphServicePrincipalId: string; byName: Map<string, string> }

function graphError(body: unknown, status: number): string {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null
  const error = record?.error && typeof record.error === "object" ? record.error as Record<string, unknown> : null
  const message = typeof error?.message === "string" ? error.message : `Microsoft Graph answered HTTP ${status}.`
  return brief(message)
}

async function resolveRoles(deps: FeatureDeps, tenantId: string, roles: string[]): Promise<{ resolved: ResolvedRoles } | { error: GraphRoleCheck }> {
  const graph = await deps.graph(tenantId)
  const filter = encodeURIComponent(`appId eq '${GRAPH_APP_ID}'`)
  const response = await graph("GET", `servicePrincipals?$filter=${filter}&$select=id,appRoles`)
  if (response.status === 401 || response.status === 403) {
    return { error: { status: "unknown", missing: [...roles], detail: "This sign-in cannot read Microsoft Graph app role assignments (Application.Read.All is not on the desktop app registration)." } }
  }
  if (response.status !== 200) return { error: { status: "unknown", missing: [...roles], detail: graphError(response.body, response.status) } }
  const values = Array.isArray((response.body as Record<string, unknown>).value) ? (response.body as { value: Array<Record<string, unknown>> }).value : []
  const sp = values[0]
  if (!sp || typeof sp.id !== "string") return { error: { status: "unknown", missing: [...roles], detail: "The Microsoft Graph service principal was not found in this tenant." } }
  const appRoles = (Array.isArray(sp.appRoles) ? sp.appRoles : []) as Array<{ id?: unknown; value?: unknown; allowedMemberTypes?: unknown }>
  const byName = new Map<string, string>()
  for (const role of roles) {
    const found = appRoles.find((entry) => entry.value === role && Array.isArray(entry.allowedMemberTypes) && entry.allowedMemberTypes.includes("Application") && typeof entry.id === "string")
    if (!found) return { error: { status: "unknown", missing: [...roles], detail: `Microsoft Graph does not offer the application role ${role} in this tenant.` } }
    byName.set(role, found.id as string)
  }
  return { resolved: { graphServicePrincipalId: sp.id, byName } }
}

/**
 * Reads the watcher identity's assignments first, so the answer names exactly what is
 * missing and a grant is never attempted blind. Unknown is an honest result, not a pass:
 * most desktop app registrations cannot read assignments at all.
 */
export async function checkGraphRoles(deps: FeatureDeps, tenantId: string, principalId: string, roles: string[]): Promise<GraphRoleCheck> {
  try {
    const resolved = await resolveRoles(deps, tenantId, roles)
    if ("error" in resolved) return resolved.error
    const graph = await deps.graph(tenantId)
    const response = await graph("GET", `servicePrincipals/${encodeURIComponent(principalId)}/appRoleAssignments?$top=999`)
    if (response.status === 401 || response.status === 403) return { status: "unknown", missing: [...roles], detail: "This sign-in cannot read the watcher identity's Graph roles." }
    if (response.status === 404) return { status: "unknown", missing: [...roles], detail: "The watcher identity is not visible in Microsoft Graph yet. Wait a minute and check again." }
    if (response.status !== 200) return { status: "unknown", missing: [...roles], detail: graphError(response.body, response.status) }
    const assignments = (Array.isArray((response.body as Record<string, unknown>).value) ? (response.body as { value: Array<Record<string, unknown>> }).value : [])
      .filter((entry) => entry.resourceId === resolved.resolved.graphServicePrincipalId)
    const assigned = new Set(assignments.map((entry) => entry.appRoleId))
    const missing = roles.filter((role) => !assigned.has(resolved.resolved.byName.get(role)))
    return missing.length ? { status: "missing", missing, detail: null } : { status: "verified", missing: [], detail: null }
  } catch (error) {
    return { status: "unknown", missing: [...roles], detail: brief(error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * Assigns exactly the missing roles, for a sign-in Microsoft Graph allows to do it. The
 * caller has the admin's explicit tick; Graph still enforces the directory role itself.
 */
export async function grantGraphRoles(deps: FeatureDeps, tenantId: string, principalId: string, roles: string[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const resolved = await resolveRoles(deps, tenantId, roles)
    if ("error" in resolved) return { ok: false, detail: resolved.error.detail ?? "The Graph roles could not be read." }
    const graph = await deps.graph(tenantId)
    for (const role of roles) {
      const response = await graph("POST", `servicePrincipals/${encodeURIComponent(principalId)}/appRoleAssignments`, {
        principalId,
        resourceId: resolved.resolved.graphServicePrincipalId,
        appRoleId: resolved.resolved.byName.get(role)!,
      } as never)
      if (response.status >= 200 && response.status < 300) continue
      const body = JSON.stringify(response.body ?? {})
      if (/already exists|MultipleObjectsWithSameKeyValue/i.test(body)) continue
      return { ok: false, detail: graphError(response.body, response.status) }
    }
    return { ok: true, detail: "Assigned. Microsoft Graph can take a few minutes to honour a new role." }
  } catch (error) {
    return { ok: false, detail: brief(error instanceof Error ? error.message : String(error)) }
  }
}
