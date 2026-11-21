import type { Item } from "../../shared/intune/registry"
import { isGuid } from "../../shared/security"
import { DirectoryAuthenticationDeferredError, DirectoryReadDeferredError, DirectoryReplicationDeferredError, DirectoryRoleDeferredError } from "./directory-retry"

const object = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value)
const jsonContent = (response: Response) => /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")

/** A structured Graph authorization denial proves this send was not applied. */
export async function directoryWriteAuthorization(response: Response, read = false): Promise<void> {
  if (![401, 403].includes(response.status) || !jsonContent(response)) return
  let value: unknown
  try { value = await response.clone().json() } catch { return }
  if (!object(value) || !object(value.error) || typeof value.error.code !== "string" || !value.error.code.trim()) return
  if (read) throw new DirectoryReadDeferredError()
  const challenge = response.headers.get("WWW-Authenticate") ?? ""
  if (value.error.code.toLowerCase() === "insufficient_claims" || /^Bearer\s/i.test(challenge) && /(?:\s|,)error\s*=\s*"insufficient_claims"(?:,|$)/i.test(challenge) && /(?:\s|,)claims\s*=\s*"[^"]+"/i.test(challenge)) throw new DirectoryAuthenticationDeferredError("Sign in again and satisfy the Conditional Access requirement, then resume with a fresh connection to repeat permission, approval and safety checks.")
  if (response.status === 401) throw new DirectoryAuthenticationDeferredError()
  if (["authorization_requestdenied", "accessdenied"].includes(value.error.code.toLowerCase())) throw new DirectoryRoleDeferredError()
}

/** Only the documented member-add replication failure proves this send was unapplied. */
export async function directoryWriteReplication(response: Response, method: string, url: URL): Promise<void> {
  if (response.status !== 400 || method !== "POST" || !/^\/v1\.0\/groups\/[^/]+\/members\/\$ref$/.test(url.pathname) || !jsonContent(response)) return
  let value: unknown
  try { value = await response.clone().json() } catch { return }
  if (object(value) && object(value.error) && value.error.code === "Request_BadRequest" && value.error.message === "The source resource object or one of the objects being referenced don't exist.") throw new DirectoryReplicationDeferredError()
}

/** Bind creation evidence to the reviewed disabled user or static security group. */
export function directoryCreateMatches(folder: string, value: Item, approved: Item): boolean {
  const normalized = (input: unknown) => typeof input === "string" && input.trim() ? input.trim().toLowerCase() : undefined
  const type = folder === "Users" ? "user" : "group"
  if (!isGuid(value.id) || typeof value.displayName !== "string" || value.displayName !== approved.displayName || value["@odata.type"] !== undefined && value["@odata.type"] !== `#microsoft.graph.${type}`) return false
  if (folder === "Users") return !!normalized(approved.userPrincipalName) && normalized(value.userPrincipalName) === normalized(approved.userPrincipalName)
  if (Object.hasOwn(approved, "description") && Object.hasOwn(value, "description") && value.description !== approved.description) return false
  return folder === "Groups" && !!normalized(approved.mailNickname) && normalized(value.mailNickname) === normalized(approved.mailNickname) && value.securityEnabled === true && value.mailEnabled === false && Array.isArray(value.groupTypes) && value.groupTypes.length === 0
}

/** Only the documented response acknowledges an admitted directory write. */
export async function directoryWriteResponse(response: Response, method: string, url: URL, approved?: Item): Promise<Item> {
  const uncertain = () => new Error("The directory write did not return its documented success response. It must be read back before any retry.")
  const path = url.pathname.replace(/^\/v1\.0\//, "")
  const create = method === "POST" && ["users", "groups"].includes(path)
  if (create) {
    if (response.status !== 201 || !jsonContent(response)) throw uncertain()
    let value: unknown
    try { value = await response.json() } catch { throw uncertain() }
    if (!object(value) || !approved || !directoryCreateMatches(path === "users" ? "Users" : "Groups", value, approved)) throw uncertain()
    return value
  }
  if (response.status !== 204 || await response.text() !== "") throw uncertain()
  return {}
}
