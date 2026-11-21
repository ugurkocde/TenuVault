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
  const relationship = /\/(?:members|owners|memberOf|appRoleAssignments)(?:\/\$ref)?$/.test(path)
  const collection = relationship || /^(?:users|groups|applications|servicePrincipals|oauth2PermissionGrants|identity\/conditionalAccess\/policies|roleManagement\/directory\/roleAssignments)$/.test(path)
  if (collection) {
    if (!Array.isArray(value.value) || value.value.some(item => !object(item) || relationship && !isGuid(item.id))) throw new DirectoryReadDeferredError()
    if (Object.hasOwn(value, "@odata.nextLink")) {
      const next = value["@odata.nextLink"]
      let parsed: URL
      try { if (typeof next !== "string" || !/^https:\/\//.test(next)) throw new Error(); parsed = new URL(next) } catch { throw new DirectoryReadDeferredError() }
      if (parsed.origin !== url.origin || parsed.username || parsed.password || parsed.hash || parsed.pathname.split("/")[1] !== url.pathname.split("/")[1]) throw new DirectoryReadDeferredError()
    }
    for (const item of value.value as Item[]) {
      if (path === "identity/conditionalAccess/policies") {
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
