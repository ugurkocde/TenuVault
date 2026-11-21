import type { Item } from "../../shared/intune/registry"
import { DirectoryReadDeferredError } from "./directory-retry"

/** Incomplete successful reads are retryable evidence failures, never identity drift. */
export function directoryReadShape(value: unknown, url: URL): Item {
  const object = (item: unknown): item is Item => !!item && typeof item === "object" && !Array.isArray(item)
  if (!object(value)) throw new DirectoryReadDeferredError()
  const path = url.pathname.replace(/^\/(?:v1\.0|beta)\//, "")
  const relationship = /\/(?:members|owners|memberOf|appRoleAssignments)(?:\/\$ref)?$/.test(path)
  const collection = relationship || /^(?:users|groups|applications|servicePrincipals|oauth2PermissionGrants|identity\/conditionalAccess\/policies|roleManagement\/directory\/roleAssignments)$/.test(path)
  if (collection) {
    if (!Array.isArray(value.value) || value.value.some(item => !object(item) || relationship && typeof item.id !== "string")) throw new DirectoryReadDeferredError()
    if (value["@odata.nextLink"] !== undefined && typeof value["@odata.nextLink"] !== "string") throw new DirectoryReadDeferredError()
  } else {
    if (typeof value.id !== "string" || (url.searchParams.get("$select") ?? "").split(",").filter(Boolean).some(field => !Object.hasOwn(value, field) || value[field] === undefined)) throw new DirectoryReadDeferredError()
  }
  return value
}
