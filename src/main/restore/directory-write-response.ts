import type { Item } from "../../shared/intune/registry"
import { isGuid } from "../../shared/security"
import { DirectoryRoleDeferredError } from "./directory-retry"

const object = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value)
const jsonContent = (response: Response) => /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")

/** A structured Graph authorization denial proves this send was not applied. */
export async function directoryWriteAuthorization(response: Response): Promise<void> {
  if (response.status !== 403 || !jsonContent(response)) return
  let value: unknown
  try { value = await response.clone().json() } catch { return }
  if (object(value) && object(value.error) && typeof value.error.code === "string" && value.error.code.trim()) throw new DirectoryRoleDeferredError()
}

/** Only the documented response acknowledges an admitted directory write. */
export async function directoryWriteResponse(response: Response, method: string, url: URL): Promise<Item> {
  const uncertain = () => new Error("The directory write did not return its documented success response. It must be read back before any retry.")
  const path = url.pathname.replace(/^\/v1\.0\//, "")
  const create = method === "POST" && ["users", "groups"].includes(path)
  if (create) {
    if (response.status !== 201 || !jsonContent(response)) throw uncertain()
    let value: unknown
    try { value = await response.json() } catch { throw uncertain() }
    if (!object(value) || !isGuid(value.id) || typeof value.displayName !== "string") throw uncertain()
    const type = path === "users" ? "user" : "group"
    if (value["@odata.type"] !== undefined && value["@odata.type"] !== `#microsoft.graph.${type}`) throw uncertain()
    if (path === "users" ? typeof value.userPrincipalName !== "string" || !value.userPrincipalName.trim() : !Array.isArray(value.groupTypes) || value.groupTypes.some(kind => typeof kind !== "string") || typeof value.mailEnabled !== "boolean" || typeof value.securityEnabled !== "boolean") throw uncertain()
    return value
  }
  if (response.status !== 204 || await response.text() !== "") throw uncertain()
  return {}
}
