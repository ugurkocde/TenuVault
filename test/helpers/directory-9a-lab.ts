import { graphContinuation } from "../../src/shared/graph-continuation"
import { directoryPayload, disabledUserBody } from "../../src/main/restore/directory-9a"
import type { Item } from "../../src/shared/intune/registry"
import { isGuid } from "../../src/shared/security"
import { LAB_8C_APP, LAB_8C_TENANT } from "./configuration-8c-lab"
export const LAB_9A_DOMAIN = "sl6ll.onmicrosoft.com"
export const LAB_9A_PREFIX = "TV06-TEST-"
export const LAB_9A_GROUP_BLOCKER = "Group cleanup requires the owner-approved soft-delete retention policy."
export const LAB_9A_GROUP_CLEANUP = { admitted: true }
const root = "https://graph.microsoft.com/v1.0/"
const prefixed = (item: Item, folder: "users" | "groups") => typeof item.displayName === "string" && item.displayName.startsWith(LAB_9A_PREFIX) && (String(item.mailNickname ?? "").startsWith(LAB_9A_PREFIX) || (folder === "users" && String(item.userPrincipalName ?? "").startsWith(LAB_9A_PREFIX)))
export interface DirectoryLabIntent { name: string; folder: string; id?: string; state: "intent" | "created" | "removed" | "refused" }
class LabRefusal extends Error { constructor(message: string, readonly status: number) { super(message) } }
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
    if (method === "GET" && /^(users|groups|directory\/deletedItems\/microsoft.graph.(user|group))([?]|$)/.test(path)) url.searchParams.set("$select", path.includes("group") ? "id,displayName,mailNickname,deletedDateTime" : "id,displayName,userPrincipalName,mailNickname,accountEnabled,deletedDateTime")
    if (url.origin !== "https://graph.microsoft.com" || url.hash || !/^\/v1\.0\/(users|groups|directory\/deletedItems)(\/|\?|$)/.test(url.pathname + url.search)) throw new Error("Outside the 9a lab path scope")
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url.href, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
      recovery.evidence({ method, path: url.pathname, status: response.status })
      if (response.status === 429 && ["GET", "DELETE"].includes(method) && attempt < 4) { await pause(Math.min(60_000, Math.max(1000, Number(response.headers.get("Retry-After")) * 1000 || 1000))); continue }
      if (response.status === 404 && ["PATCH", "PUT", "POST"].includes(method) && path !== "users" && path !== "groups" && attempt < 4) { await pause(3000); continue }
      if (response.status === 404 && ["GET", "DELETE"].includes(method)) return null
      if (!response.ok) {
        const message = `Lab ${method} failed with HTTP ${response.status}. Response bodies are not recorded.`
        if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new LabRefusal(message, response.status)
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
    for (let attempt = 0; attempt < 60; attempt++) {
      const item = await request(`${fixture.folder}/${id}?$select=${fixture.folder === "users" ? "id,displayName,userPrincipalName,mailNickname,accountEnabled" : "id,displayName,mailNickname,groupTypes,mailEnabled,securityEnabled,isAssignableToRole,membershipRule,membershipRuleProcessingState"}`)
      if (item && assertFixture(item, fixture.folder) === id) return { fixture, item }
      await pause(1000)
    }
    throw new Error("Fixture ownership could not be verified")
  }
  const audit = async () => {
    const remnants: Array<{ folder: string; id: string; deletedDateTime?: string }> = []
    for (const folder of ["users", "groups"] as const) for (const path of [folder, `directory/deletedItems/microsoft.graph.${folder === "users" ? "user" : "group"}`]) {
      for await (const item of list(path + "?$top=999")) if (String(item.displayName).startsWith(LAB_9A_PREFIX) || String(item[folder === "users" ? "userPrincipalName" : "mailNickname"]).startsWith(LAB_9A_PREFIX)) {
        // A partial prefix match is reported, never treated as authority to delete it.
        if (!isGuid(item.id)) throw new Error("Invalid remnant identity")
        remnants.push({ folder: path, id: item.id, ...(typeof item.deletedDateTime === "string" ? { deletedDateTime: item.deletedDateTime } : {}) })
      }
    }
    recovery.evidence({ kind: "remnant-audit", remnants })
    return remnants
  }
  const cleanup = async () => {
    const failures: string[] = []
    for (let attempt = 0, stable = 0; attempt < 60; attempt++) {
      for (const folder of ["users", "groups"] as const) {
        for (const deleted of [false, true]) {
          const path = deleted ? `directory/deletedItems/microsoft.graph.${folder === "users" ? "user" : "group"}` : folder
          try {
            for await (const item of list(path + "?$top=999")) {
              if (!prefixed(item, folder)) continue
              // Cleanup is the only operation allowed on a fixture left by an earlier failed run.
              if (!isGuid(item.id)) throw new Error("Invalid cleanup identity")
              if (folder === "groups" && deleted) { recovery.save({ name: String(item.mailNickname), folder, id: item.id, state: "removed" }); continue }
              await request(deleted ? `directory/deletedItems/${item.id}` : `${folder}/${item.id}`, "DELETE")
              if (deleted || folder === "groups") recovery.save({ name: String(item.mailNickname ?? item.userPrincipalName).split("@")[0]!, folder, id: item.id, state: "removed" })
            }
          } catch { failures.push(`${folder}/${deleted ? "deleted" : "active"}`) }
        }
      }
      const remnants = await audit()
      stable = remnants.some(item => item.folder !== "directory/deletedItems/microsoft.graph.group") ? 0 : stable + 1
      if (stable >= 3 && recovery.load().every(intent => ["removed", "refused"].includes(intent.state))) { recovery.clear(); created.clear(); return }
      await pause(1000)
    }
    throw new Error(`Cleanup remains unresolved (${[...new Set(failures)].join(", ")}). Recovery intent is retained. No non-prefixed object was removed.`)
  }
  const verify = async (folder: "users" | "groups", id: string, expected: Item) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const item = await request(`${folder}/${id}?$select=${["id", ...Object.keys(expected), ...(folder === "users" ? ["displayName", "userPrincipalName", "accountEnabled"] : ["displayName", "mailNickname"])].filter((key, index, keys) => keys.indexOf(key) === index).join(",")}`)
      if (item && assertFixture(item, folder) === id && Object.entries(expected).every(([key, value]) => JSON.stringify(item[key]) === JSON.stringify(value))) { recovery.evidence({ kind: "read-back-matched", folder, id, expected }); return item }
      await pause(1000)
    }
    throw new Error("Fixture read-back did not match")
  }
  const waitDeleted = async (id: string) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await request(`directory/deletedItems/${id}`)) return
      await pause(1000)
    }
    throw new Error("Deleted fixture did not become readable")
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
    async createGroup(roleAssignable = false, microsoft365 = false, dynamic = false) {
      if (roleAssignable && !claims.roles?.includes("RoleManagement.ReadWrite.Directory")) throw new Error("Role-assignable creation requires its approved grant")
      if (!LAB_9A_GROUP_CLEANUP.admitted) throw new Error(LAB_9A_GROUP_BLOCKER)
      for (const permission of ["Group.Create", "Group.Read.All", "Group.ReadWrite.All", "GroupMember.ReadWrite.All"]) if (!claims.roles?.includes(permission)) throw new Error(`Missing lab application permission: ${permission}`)
      const name = LAB_9A_PREFIX + crypto.randomUUID()
      const expected = directoryPayload("Groups", "create", { displayName: name, mailNickname: name, groupTypes: dynamic ? ["DynamicMembership"] : microsoft365 ? ["Unified"] : [], ...(dynamic ? { membershipRule: `(user.displayName -eq "${name}")`, membershipRuleProcessingState: "Paused" } : {}), securityEnabled: true, mailEnabled: microsoft365, isAssignableToRole: roleAssignable })
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
    async recreateUser(id: string) {
      const { fixture, item } = await currentFixture(id)
      if (fixture.folder !== "users") throw new Error("Not a user fixture")
      await request(`users/${id}`, "DELETE"); await waitDeleted(id)
      await request(`directory/deletedItems/${id}`, "DELETE"); await pause(3000)
      const expected = { displayName: item.displayName!, userPrincipalName: item.userPrincipalName!, mailNickname: item.mailNickname!, accountEnabled: false }
      let result: Item | null = null
      // A definite 400 after confirmed permanent deletion can be a stale UPN index.
      // This lab-only retry never follows a lost create response and never changes the alias.
      for (let attempt = 0; ; attempt++) {
        try { result = await request("users", "POST", disabledUserBody(expected)); break }
        catch (error) { if (!(error instanceof LabRefusal) || error.status !== 400 || attempt >= 12) throw error; await pause(3000) }
      }
      if (!result || !isGuid(result.id) || result.id === id) throw new Error("Recreation did not return a new ID")
      created.delete(id); created.set(result.id, fixture)
      recovery.save({ name: fixture.name, folder: "users", id: result.id, state: "created" })
      await verify("users", result.id, expected)
      recovery.evidence({ kind: "new-id-matched", previousId: id, id: result.id })
      return result.id
    },
    async dynamicRule(id: string) {
      const { fixture, item } = await currentFixture(id)
      if (fixture.folder !== "groups" || !Array.isArray(item.groupTypes) || !item.groupTypes.includes("DynamicMembership")) throw new Error("Not a dynamic fixture")
      const original = item.membershipRule!
      const changed = `(user.displayName -eq "${fixture.name}-changed")`
      await request(`groups/${id}`, "PATCH", { membershipRule: changed, membershipRuleProcessingState: "Paused" })
      await verify("groups", id, { membershipRule: changed, membershipRuleProcessingState: "Paused" })
      await request(`groups/${id}`, "PATCH", { membershipRule: original, membershipRuleProcessingState: "Paused" })
      await verify("groups", id, { membershipRule: original, membershipRuleProcessingState: "Paused" })
    },
    async lifecycleGroup(id: string) {
      const { fixture } = await currentFixture(id)
      if (fixture.folder !== "groups") throw new Error("Not a group fixture")
      await request(`groups/${id}`, "PATCH", { description: "TV06-TEST-changed" }); await verify("groups", id, { description: "TV06-TEST-changed" })
      await request(`groups/${id}`, "PATCH", { description: "TV06-TEST-original" }); await verify("groups", id, { description: "TV06-TEST-original" })
      await request(`groups/${id}`, "DELETE"); await waitDeleted(id); await request(`directory/deletedItems/${id}/restore`, "POST", {})
      await verify("groups", id, { displayName: fixture.name, description: "TV06-TEST-original" })
    },
    async profileUser(id: string) {
      const { fixture, item } = await currentFixture(id)
      if (fixture.folder !== "users") throw new Error("Not a user fixture")
      const original = String(item.displayName), changed = fixture.name + "-changed"
      await request(`users/${id}`, "PATCH", { displayName: changed }); await verify("users", id, { displayName: changed, accountEnabled: false })
      await request(`users/${id}`, "PATCH", { displayName: original }); await verify("users", id, { displayName: original, accountEnabled: false })
    },
    async lifecycleUser(id: string) {
      const { fixture, item } = await currentFixture(id)
      if (fixture.folder !== "users") throw new Error("Not a user fixture")
      const original = String(item.displayName), changed = fixture.name + "-changed"
      await request(`users/${id}`, "PATCH", { displayName: changed }); await verify("users", id, { displayName: changed, accountEnabled: false })
      await request(`users/${id}`, "PATCH", { displayName: original }); await verify("users", id, { displayName: original, accountEnabled: false })
      await request(`users/${id}`, "DELETE"); await waitDeleted(id)
      await request(`directory/deletedItems/${id}/restore`, "POST", {})
      await verify("users", id, { displayName: original, accountEnabled: false })
    },
    async relationship(groupId: string, principalId: string, kind: "members" | "owners", present: boolean) {
      if (!["members", "owners"].includes(kind) || typeof present !== "boolean") throw new Error("Outside the approved relationship kind")
      const resource = await currentFixture(groupId), principal = await currentFixture(principalId)
      if (resource.fixture.folder !== "groups" || !["users", "groups"].includes(principal.fixture.folder)) throw new Error("Relationships must be between fixtures created in this run")
      if (resource.item.isAssignableToRole === true && !claims.roles?.includes("RoleManagement.ReadWrite.Directory")) throw new Error("Missing role-assignable group grant")
      await request(`groups/${groupId}/${kind}/${present ? "" : principalId + "/"}$ref`, present ? "POST" : "DELETE", present ? { "@odata.id": root + "directoryObjects/" + principalId } : undefined)
      for (let attempt = 0; attempt < 60; attempt++) {
        const actual = await request(`groups/${groupId}/${kind}/${principalId}`)
        if (present ? actual?.id === principalId : actual === null) { recovery.evidence({ kind: "relationship-matched", groupId, principalId, relationship: kind, present }); return }
        await pause(1000)
      }
      throw new Error("Relationship read-back did not match")
    },
    async manager(userId: string, managerId: string) {
      const user = await currentFixture(userId), manager = await currentFixture(managerId)
      if (user.fixture.folder !== "users" || manager.fixture.folder !== "users" || !claims.roles?.includes("User.ReadWrite.All")) throw new Error("Manager tests require two created user fixtures and User.ReadWrite.All")
      await request(`users/${userId}/manager/$ref`, "PUT", { "@odata.id": root + "users/" + managerId })
      let matched = false
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await request(`users/${userId}/manager`))?.id === managerId) { matched = true; break }
        await pause(1000)
      }
      if (!matched) throw new Error("Manager read-back did not match")
      recovery.evidence({ kind: "manager-matched", userId, managerId })
      await request(`users/${userId}/manager/$ref`, "DELETE")
      for (let attempt = 0; ; attempt++) {
        if (!await request(`users/${userId}/manager`)) break
        if (attempt >= 60) throw new Error("Manager removal did not match")
        await pause(1000)
      }
      recovery.evidence({ kind: "manager-round-trip-matched", userId })
    },
  }
}
