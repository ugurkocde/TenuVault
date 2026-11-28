import type { Item } from "../../shared/intune/registry"
import { RestoreSafetyError, RestoreWriteRefusedError } from "../../shared/intune/restore-guards"
import { isGuid } from "../../shared/security"
import { DirectoryAuthenticationDeferredError, DirectoryReadDeferredError, DirectoryReplicationDeferredError, DirectoryRoleDeferredError } from "./directory-retry"

const object = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value)
const jsonContent = (response: Response) => /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")

/** Keep parameters bound to their authentication scheme, including combined headers. */
function claimsChallenge(header: string): boolean {
  let bearer = false
  const parameters = new Map<string, string>()
  const matches = () => bearer && parameters.get("error")?.toLowerCase() === "insufficient_claims" && !!parameters.get("claims")?.trim()
  for (const segment of header.match(/(?:[^,"]|"(?:\\.|[^"\\])*")+/g) ?? []) {
    let part = segment.trim()
    const scheme = /^([a-z][\w-]*)\s+(.+)$/i.exec(part)
    if (scheme && !scheme[2]!.trimStart().startsWith("=")) {
      if (matches()) return true
      bearer = scheme[1]!.toLowerCase() === "bearer"; parameters.clear(); part = scheme[2]!
    }
    const parameter = /^([a-z][\w-]*)\s*=\s*"((?:\\.|[^"\\])*)"$/i.exec(part)
    if (parameter) parameters.set(parameter[1]!.toLowerCase(), parameter[2]!)
  }
  return !!matches()
}
/** A structured Graph authorization denial proves this send was not applied. */
export async function directoryWriteAuthorization(response: Response, read = false): Promise<void> {
  const challenge = response.headers.get("WWW-Authenticate") ?? ""
  // A read may defer on a header-only 403 challenge too. A write needs Graph's structured body to prove it was unapplied.
  if ((response.status === 401 || (read && response.status === 403)) && claimsChallenge(challenge)) throw new DirectoryAuthenticationDeferredError("Sign in again and satisfy the Conditional Access requirement, then resume with a fresh connection to repeat permission, approval and safety checks. Automatic claims challenge replay is unavailable; if sign-in does not resolve it, complete the change in Microsoft Entra.")
  if (![401, 403].includes(response.status) || !jsonContent(response)) return
  let value: unknown
  try { value = await response.clone().json() } catch { return }
  if (!object(value) || !object(value.error) || typeof value.error.code !== "string" || !value.error.code.trim()) return
  // A claims challenge needs a new sign-in on reads too. Classify it before generic read denials.
  if (value.error.code.toLowerCase() === "insufficient_claims" || claimsChallenge(challenge)) throw new DirectoryAuthenticationDeferredError("Sign in again and satisfy the Conditional Access requirement, then resume with a fresh connection to repeat permission, approval and safety checks.")
  if (read) throw new DirectoryReadDeferredError()
  if (response.status === 401) throw new DirectoryAuthenticationDeferredError()
  if (["authorization_requestdenied", "accessdenied"].includes(value.error.code.toLowerCase())) throw new DirectoryRoleDeferredError()
}

export class DirectoryObjectNotFoundError extends RestoreWriteRefusedError {
  constructor() { super(404) }
}
/** A required safety read found no object. Only our journal's creation evidence can make it replication. */
export class DirectoryRequiredObjectAbsentError extends RestoreSafetyError {
  constructor(message: string, readonly objectId: string) { super(message) }
}
/** A structured resource-not-found can be replication only with our journal's creation evidence. */
export async function directoryWriteNotFound(response: Response): Promise<void> {
  if (response.status !== 404 || !jsonContent(response)) return
  let value: unknown
  try { value = await response.clone().json() } catch { return }
  if (object(value) && object(value.error) && value.error.code === "Request_ResourceNotFound") throw new DirectoryObjectNotFoundError()
}
/** Only the documented member-add replication failure proves this send was unapplied. */
export async function directoryWriteReplication(response: Response, method: string, url: URL): Promise<void> {
  if (response.status !== 400 || method !== "POST" || !/^\/(?:beta|v1\.0)\/groups\/[^/]+\/members\/\$ref$/.test(url.pathname) || !jsonContent(response)) return
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
  const path = url.pathname.replace(/^\/(?:beta|v1\.0)\//, "")
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
