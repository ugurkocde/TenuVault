import { graphContinuation } from "../../src/shared/graph-continuation"
import { directoryPayload, disabledUserBody } from "../../src/main/restore/directory-9a"
import type { Item } from "../../src/shared/intune/registry"
import { isGuid } from "../../src/shared/security"
import { LAB_8C_APP, LAB_8C_TENANT } from "./configuration-8c-lab"
export const LAB_9A_DOMAIN = "sl6ll.onmicrosoft.com"
export const LAB_9A_PREFIX = "TV06-TEST-"
export const LAB_9A_GROUP_BLOCKER = "Group fixture creation is blocked: Microsoft's permanent-delete operation table marks application mode unsupported for groups. Resolve cleanup evidence before creating a group."
export const LAB_9A_GROUP_CLEANUP = { admitted: false }
const root = "https://graph.microsoft.com/v1.0/"
const prefixed = (item: Item, folder: "users" | "groups") => typeof item.displayName === "string" && item.displayName.startsWith(LAB_9A_PREFIX) && typeof item[folder === "users" ? "userPrincipalName" : "mailNickname"] === "string" && String(item[folder === "users" ? "userPrincipalName" : "mailNickname"]).startsWith(LAB_9A_PREFIX)
export interface DirectoryLabIntent { name: string; folder: string; id?: string; state: "intent" | "created" | "removed" | "refused" }
class LabRefusal extends Error {}
export interface DirectoryLabRecovery {
  /** Durable intent precedes creation, including when the response is lost. No passwords or tokens. */
  save: (intent: DirectoryLabIntent) => void
  load: () => DirectoryLabIntent[]
  clear: () => void
  evidence: (event: Item) => void
}
/** Fixed lab adapter with discovery-based recovery. It has no arbitrary-path or arbitrary-payload write method. */
export function directory9aLab(token: string, tenant: string, app: string, recovery: DirectoryLabRecovery, fetchImpl: typeof fetch = fetch, pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let claims: { tid?: string; appid?: string; azp?: string; roles?: string[] }
  try { claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) } catch { throw new Error("Invalid lab token") }
  if (tenant !== LAB_8C_TENANT || app !== LAB_8C_APP || claims.tid !== tenant || (claims.appid ?? claims.azp) !== app) throw new Error("Outside the approved lab tenant and app.")
  for (const permission of ["User.Create", "User.ReadUpdate.All", "User.Read.All", "User.DeleteRestore.All"]) if (!claims.roles?.includes(permission)) throw new Error(`Missing lab application permission: ${permission}`)
  const created = new Map<string, { folder: "users" | "groups"; name: string }>()
  const request = async (path: string, method = "GET", body?: Item): Promise<Item | null> => {
    const url = new URL(root + path)
    if (url.origin !== "https://graph.microsoft.com" || url.hash || !/^\/v1\.0\/(users|groups|directory\/deletedItems)(\/|\?|$)/.test(url.pathname + url.search)) throw new Error("Outside the 9a lab path scope")
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url.href, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
      recovery.evidence({ method, path: url.pathname, status: response.status })
      if (response.status === 429 && ["GET", "DELETE"].includes(method) && attempt < 4) { await pause(Math.min(60_000, Math.max(1000, Number(response.headers.get("Retry-After")) * 1000 || 1000))); continue }
      if (response.status === 404 && ["GET", "DELETE"].includes(method)) return null
      if (!response.ok) {
        const message = `Lab ${method} failed with HTTP ${response.status}. Response bodies are not recorded.`
        if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new LabRefusal(message)
        throw new Error(message)
      }
      return response.status === 204 ? {} : await response.json() as Item
    }
  }
  async function* list(path: string) {
    const start = root + path, seen = new Set<string>()
    let next: string | undefined = start
    while (next) {
      const page = await request(graphContinuation(start, next, seen).slice(root.length))
      if (!Array.isArray(page?.value)) throw new Error("Incomplete lab audit")
      for (const value of page.value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed lab audit")
        yield value as Item
      }
      if (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string") throw new Error("Malformed lab continuation")
      next = page["@odata.nextLink"] as string | undefined
    }
  }
  const assertFixture = (item: Item, folder: "users" | "groups") => {
    if (!isGuid(item.id) || !prefixed(item, folder) || (folder === "users" && item.accountEnabled !== false)) throw new Error("Outside the disabled, prefixed fixture scope")
    return item.id
  }
  const currentFixture = async (id: string) => {
    const fixture = created.get(id)
    if (!fixture) throw new Error("Existing objects cannot be changed by this run")
    const item = await request(`${fixture.folder}/${id}`)
    if (!item || assertFixture(item, fixture.folder) !== id) throw new Error("Fixture ownership could not be verified")
    return { fixture, item }
  }
  const audit = async () => {
    const remnants: Array<{ folder: string; id: string }> = []
    for (const folder of ["users", "groups"] as const) for (const path of [folder, `directory/deletedItems/microsoft.graph.${folder === "users" ? "user" : "group"}`]) {
      for await (const item of list(path + "?$top=999")) if (String(item.displayName).startsWith(LAB_9A_PREFIX) || String(item[folder === "users" ? "userPrincipalName" : "mailNickname"]).startsWith(LAB_9A_PREFIX)) {
        // A partial prefix match is reported, never treated as authority to delete it.
        if (!isGuid(item.id)) throw new Error("Invalid remnant identity")
        remnants.push({ folder: path, id: item.id })
      }
    }
    recovery.evidence({ kind: "remnant-audit", remnants })
    return remnants
  }
  const cleanup = async () => {
    const failures: string[] = []
    for (let attempt = 0, stable = 0; attempt < 12; attempt++) {
      for (const folder of ["users", "groups"] as const) {
        for (const deleted of [false, true]) {
          const path = deleted ? `directory/deletedItems/microsoft.graph.${folder === "users" ? "user" : "group"}` : folder
          try {
            for await (const item of list(path + "?$top=999")) {
              if (!prefixed(item, folder)) continue
              // Cleanup is the only operation allowed on a fixture left by an earlier failed run.
              if (!isGuid(item.id)) throw new Error("Invalid cleanup identity")
              await request(deleted ? `directory/deletedItems/${item.id}` : `${folder}/${item.id}`, "DELETE")
              if (deleted) recovery.save({ name: String(item[folder === "users" ? "userPrincipalName" : "mailNickname"]).split("@")[0]!, folder, id: item.id, state: "removed" })
            }
          } catch { failures.push(`${folder}/${deleted ? "deleted" : "active"}`) }
        }
      }
      const remnants = await audit()
      stable = remnants.length ? 0 : stable + 1
      if (stable >= 3 && recovery.load().every(intent => ["removed", "refused"].includes(intent.state))) { recovery.clear(); created.clear(); return }
      await pause(1000)
    }
    throw new Error(`Cleanup remains unresolved (${[...new Set(failures)].join(", ")}). Recovery intent is retained. No non-prefixed object was removed.`)
  }
  const verify = async (folder: "users" | "groups", id: string, expected: Item) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const item = await request(`${folder}/${id}`)
      if (item && assertFixture(item, folder) === id && Object.entries(expected).every(([key, value]) => JSON.stringify(item[key]) === JSON.stringify(value))) return item
      await pause(1000)
    }
    throw new Error("Fixture read-back did not match")
  }
  return {
    cleanup, audit,
    async createUser(domain: string) {
      if (domain !== LAB_9A_DOMAIN) throw new Error("Use the approved lab onmicrosoft.com domain")
      const name = LAB_9A_PREFIX + crypto.randomUUID()
      recovery.save({ name, folder: "users", state: "intent" })
      const expected = { displayName: name, userPrincipalName: name + "@" + domain, mailNickname: name, accountEnabled: false }
      let item: Item | null
      try { item = await request("users", "POST", disabledUserBody(expected)) } catch (error) {
        if (error instanceof LabRefusal) recovery.save({ name, folder: "users", state: "refused" })
        throw error
      }
      if (!item || !isGuid(item.id)) throw new Error("User create outcome is unknown; cleanup must discover its prefix")
      recovery.save({ name, folder: "users", id: item.id, state: "created" })
      created.set(item.id, { folder: "users", name })
      await verify("users", item.id, expected)
      return item.id
    },
    async createGroup(roleAssignable = false, microsoft365 = false) {
      if (roleAssignable && !claims.roles?.includes("RoleManagement.ReadWrite.Directory")) throw new Error("Role-assignable creation requires its approved grant")
      if (!LAB_9A_GROUP_CLEANUP.admitted) throw new Error(LAB_9A_GROUP_BLOCKER)
      for (const permission of ["Group.Create", "Group.Read.All", "Group.ReadWrite.All", "GroupMember.ReadWrite.All"]) if (!claims.roles?.includes(permission)) throw new Error(`Missing lab application permission: ${permission}`)
      const name = LAB_9A_PREFIX + crypto.randomUUID()
      const expected = directoryPayload("Groups", "create", { displayName: name, mailNickname: name, groupTypes: microsoft365 ? ["Unified"] : [], securityEnabled: true, mailEnabled: microsoft365, isAssignableToRole: roleAssignable })
      recovery.save({ name, folder: "groups", state: "intent" })
      let item: Item | null
      try { item = await request("groups", "POST", expected) } catch (error) {
        if (error instanceof LabRefusal) recovery.save({ name, folder: "groups", state: "refused" })
        throw error
      }
      if (!item || !isGuid(item.id)) throw new Error("Group create outcome is unknown; cleanup must discover its prefix")
      recovery.save({ name, folder: "groups", id: item.id, state: "created" })
      created.set(item.id, { folder: "groups", name }); await verify("groups", item.id, expected)
      return item.id
    },
    async lifecycleGroup(id: string) {
      const { fixture } = await currentFixture(id)
      if (fixture.folder !== "groups") throw new Error("Not a group fixture")
      await request(`groups/${id}`, "PATCH", { description: "TV06-TEST-changed" }); await verify("groups", id, { description: "TV06-TEST-changed" })
      await request(`groups/${id}`, "PATCH", { description: "TV06-TEST-original" }); await verify("groups", id, { description: "TV06-TEST-original" })
      await request(`groups/${id}`, "DELETE"); await request(`directory/deletedItems/${id}/restore`, "POST", {})
      await verify("groups", id, { displayName: fixture.name, description: "TV06-TEST-original" })
    },
    async lifecycleUser(id: string) {
      const { fixture, item } = await currentFixture(id)
      if (fixture.folder !== "users") throw new Error("Not a user fixture")
      const original = String(item.displayName), changed = fixture.name + "-changed"
      await request(`users/${id}`, "PATCH", { displayName: changed }); await verify("users", id, { displayName: changed, accountEnabled: false })
      await request(`users/${id}`, "PATCH", { displayName: original }); await verify("users", id, { displayName: original, accountEnabled: false })
      await request(`users/${id}`, "DELETE")
      await request(`directory/deletedItems/${id}/restore`, "POST", {})
      await verify("users", id, { displayName: original, accountEnabled: false })
    },
    async relationship(groupId: string, principalId: string, kind: "members" | "owners", present: boolean) {
      const resource = await currentFixture(groupId), principal = await currentFixture(principalId)
      if (resource.fixture.folder !== "groups" || !["users", "groups"].includes(principal.fixture.folder)) throw new Error("Relationships must be between fixtures created in this run")
      if (resource.item.isAssignableToRole === true && !claims.roles?.includes("RoleManagement.ReadWrite.Directory")) throw new Error("Missing role-assignable group grant")
      await request(`groups/${groupId}/${kind}/${present ? "" : principalId + "/"}$ref`, present ? "POST" : "DELETE", present ? { "@odata.id": root + "directoryObjects/" + principalId } : undefined)
      const actual = await request(`groups/${groupId}/${kind}/${principalId}`)
      if (present ? actual?.id !== principalId : actual !== null) throw new Error("Relationship read-back did not match")
    },
    async manager(userId: string, managerId: string) {
      const user = await currentFixture(userId), manager = await currentFixture(managerId)
      if (user.fixture.folder !== "users" || manager.fixture.folder !== "users" || !claims.roles?.includes("User.ReadWrite.All")) throw new Error("Manager tests require two created user fixtures and User.ReadWrite.All")
      await request(`users/${userId}/manager/$ref`, "PUT", { "@odata.id": root + "users/" + managerId })
      const actual = await request(`users/${userId}/manager`)
      if (actual?.id !== managerId) throw new Error("Manager read-back did not match")
    },
  }
}
