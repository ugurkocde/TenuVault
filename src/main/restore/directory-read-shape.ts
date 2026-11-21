import { graphContinuation } from "../../shared/graph-continuation"
import type { Item } from "../../shared/intune/registry"
import { isGuid } from "../../shared/security"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { DirectoryReadDeferredError } from "./directory-retry"

const object = (item: unknown): item is Item => !!item && typeof item === "object" && !Array.isArray(item)
const jsonContent = (response: Response) => /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")

/** Only a structured Graph not-found response on an optional object lookup proves absence. */
export async function directoryReadAbsent(response: Response, url: URL): Promise<null> {
  const path = url.pathname.replace(/^\/(?:v1\.0|beta)\//, "")
  const optional = /^(?:(?:users|groups|applications|servicePrincipals|directory\/deletedItems)\/[^/]+|(?:users|groups|applications|servicePrincipals)\/[^/]+\/(?:manager|(?:members|owners)\/[^/]+)(?:\/\$ref)?)$/.test(path)
  if (!optional || !jsonContent(response) || !isGuid(response.headers.get("request-id"))) throw new DirectoryReadDeferredError()
  let value: unknown
  try { value = await response.json() } catch { throw new DirectoryReadDeferredError() }
  if (!object(value) || !object(value.error) || typeof value.error.code !== "string" || !value.error.code.trim()) throw new DirectoryReadDeferredError()
  return null
}

/** Incomplete reads defer; a well-formed response naming another keyed object refuses. */
export function directoryReadShape(value: unknown, url: URL): Item {
  if (!object(value)) throw new DirectoryReadDeferredError()
  const path = url.pathname.replace(/^\/(?:v1\.0|beta)\//, "")
  const selected = (url.searchParams.get("$select") ?? "").split(",").filter(Boolean)
  const appRoles = /\/appRoleAssignments$/.test(path)
  const relationship = /\/(?:members|owners|memberOf|appRoleAssignments)(?:\/\$ref)?$/.test(path)
  const collection = relationship || /^(?:users|groups|applications|servicePrincipals|oauth2PermissionGrants|identity\/conditionalAccess\/policies|roleManagement\/directory\/roleAssignments|me\/transitiveMemberOf\/microsoft.graph.group)$/.test(path)
  if (collection) {
    if (path === "identity/conditionalAccess/policies" && Object.hasOwn(value, "@odata.context")) {
      let context: URL
      try { if (typeof value["@odata.context"] !== "string") throw new Error(); context = new URL(value["@odata.context"]) } catch { throw new DirectoryReadDeferredError() }
      if (context.origin !== url.origin || context.username || context.password || context.search || context.pathname !== `/${url.pathname.split("/")[1]}/$metadata` || !/^#(?:identity\/)?conditionalAccess\/policies(?:\([A-Za-z_][A-Za-z0-9_]*(?:,[A-Za-z_][A-Za-z0-9_]*)*\))?$/.test(context.hash)) throw new DirectoryReadDeferredError()
    }
    if (!Array.isArray(value.value) || value.value.some(item => !object(item) || relationship && (appRoles ? typeof item.id !== "string" || !item.id.trim() || ["principalId", "resourceId", "appRoleId"].some(field => !isGuid(item[field])) : !isGuid(item.id)))) throw new DirectoryReadDeferredError()
    if (Object.hasOwn(value, "@odata.nextLink")) {
      const next = value["@odata.nextLink"]
      let parsed: URL
      try { if (typeof next !== "string" || !/^https:\/\//.test(next)) throw new Error(); parsed = new URL(next) } catch { throw new DirectoryReadDeferredError() }
      if (parsed.origin !== url.origin || parsed.username || parsed.password || parsed.hash || parsed.pathname.split("/")[1] !== url.pathname.split("/")[1]) throw new DirectoryReadDeferredError()
    }
    for (const item of value.value as Item[]) {
      if (path === "identity/conditionalAccess/policies") {
        if (directoryWorkloadOnly(item)) continue
        if (!object(item.conditions) || !object(item.conditions.users)) throw new DirectoryReadDeferredError()
        const users = item.conditions.users
        for (const field of ["includeGroups", "excludeGroups"]) if (Object.hasOwn(users, field) && (!Array.isArray(users[field]) || users[field].some(id => !isGuid(id)))) throw new DirectoryReadDeferredError()
      }
      if (["users", "groups", "applications", "servicePrincipals"].includes(path) && !isGuid(item.id)) throw new DirectoryReadDeferredError()
      if (path === "servicePrincipals") {
        for (const field of ["appId", "appOwnerOrganizationId"]) {
          if ((Object.hasOwn(item, field) || selected.includes(field)) && item[field] !== null && !isGuid(item[field])) throw new DirectoryReadDeferredError()
        }
      }
    }
  } else {
    if (!isGuid(value.id) || selected.some(field => !Object.hasOwn(value, field) || value[field] === undefined)) throw new DirectoryReadDeferredError()
    const keyed = path.replace(/\/\$ref$/, "").split("/").at(-1)
    if (isGuid(keyed) && value.id.toLowerCase() !== keyed.toLowerCase()) throw new RestoreSafetyError("The directory object identity changed: the response did not match the requested ID.")
  }
  return value
}

/** Directory paging failures are retryable without changing other Graph callers. */
export function directoryContinuation(start: string, next: string, seen: Set<string>): string {
  try { return graphContinuation(start, next, seen) }
  catch { throw new DirectoryReadDeferredError() }
}

/** Workload-only targeting has no user or group beneficiaries. Incomplete shapes do not qualify. */
export function directoryWorkloadOnly(policy: Item): boolean {
  if (!object(policy.conditions) || policy.conditions.users != null) return false
  const clients = policy.conditions.clientApplications
  if (!object(clients) || !Array.isArray(clients.includeServicePrincipals) || !Array.isArray(clients.excludeServicePrincipals)) return false
  if (clients.includeServicePrincipals.some(id => id !== "ServicePrincipalsInMyTenant" && !isGuid(id)) || clients.excludeServicePrincipals.some(id => !isGuid(id))) return false
  const filter = clients.servicePrincipalFilter
  if (filter != null && (!object(filter) || !["include", "exclude"].includes(String(filter.mode)) || typeof filter.rule !== "string" || !filter.rule.trim())) return false
  return clients.includeServicePrincipals.length > 0 || object(filter)
}
