import { ConnectionCapabilities } from "../src/main/auth/connection-capabilities"
import { RESOURCE_SCOPES } from "../src/shared/constants"
import { describe, expect, it, vi } from "vitest"
import { AppMetadataAccess, withTemporaryDirectoryWrite } from "../src/main/restore/app-metadata-access"
import { appMetadataRemovalInstructions } from "../src/shared/app-metadata-removal"
import { APPLICATION_METADATA_RESTORE_PACK, GRANT_REMOVAL_SCOPE, tenantPermissionPacks } from "../src/shared/services/permission-packs"
import { TENUVAULT_CLIENT_ID } from "../src/shared/tenant-connection"
import { GRAPH_APP_ID } from "../src/shared/services/manifest"
import { privilegedRestoreConsent } from "../src/main/restore/privileged-consent"

const [metadata, removal] = APPLICATION_METADATA_RESTORE_PACK.scopes as [string, string]
const tenantId = "11111111-1111-4111-8111-111111111111"
const userId = "22222222-2222-4222-8222-222222222222"
const clientId = "33333333-3333-4333-8333-333333333333"
const resourceId = "44444444-4444-4444-8444-444444444444"
const otherUser = "55555555-5555-4555-8555-555555555555"
const runId = "66666666-6666-4666-8666-666666666666"
const identity = { tenantId, clientId: TENUVAULT_CLIENT_ID, userId }
const connection = (scopes: string[]) => ({ ...identity, token: "opaque-token", authorization: { ...identity, scopes } })
const normal = connection(["Directory.Read.All"])
const row = (id: string, scope: string, principalId: string | null = null) => ({
  id, clientId, resourceId, scope, principalId, consentType: principalId ? "Principal" : "AllPrincipals",
})

function setup(initial = [row("all", "Directory.Read.All User.Read")]) {
  let grants = initial
  let deny = false
  const writes: Array<[string, string, string]> = []
  const data = new Map<string, string>()
  const store = { get: (key: string) => data.get(key) ?? null, set: (key: string, value: string) => { data.set(key, value) }, delete: (key: string) => { data.delete(key) } }
  const after = (rows: typeof initial) => { grants = rows }
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    expect(url.origin).toBe("https://graph.microsoft.com")
    if (url.pathname.includes("servicePrincipals")) {
      const appId = url.pathname.split("'")[1]
      expect([GRAPH_APP_ID, TENUVAULT_CLIENT_ID]).toContain(appId)
      return Response.json({ id: appId === TENUVAULT_CLIENT_ID ? clientId : resourceId, appId })
    }
    if (url.pathname === "/beta/oauth2PermissionGrants") {
      expect(url.searchParams.get("$filter")).toBe(`clientId eq '${clientId}'`)
      const next = new URL(url)
      next.searchParams.set("$skiptoken", "next")
      return Response.json(url.searchParams.has("$skiptoken") || grants.length < 2
        ? { value: url.searchParams.has("$skiptoken") ? grants.slice(1) : grants }
        : { value: grants.slice(0, 1), "@odata.nextLink": next.href })
    }
    const id = url.pathname.split("/").at(-1)!
    const scope = init?.body ? JSON.parse(String(init.body)).scope : ""
    const old = grants.find(grant => grant.id === id)!
    if (deny && old.scope.includes(removal) && !scope.includes(removal)) return Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 })
    writes.push([method, id, scope])
    if (method === "PATCH") old.scope = scope
    else grants = grants.filter(grant => grant.id !== id)
    return new Response(null, { status: 204 })
  })
  const host = {
    available: vi.fn(async () => true),
    consent: vi.fn(async () => {
      after([row("all", `Directory.Read.All User.Read ${metadata} ${removal}`)])
      return { status: "received" as const }
    }),
    token: vi.fn(async (_tenant: string, scopes: readonly string[]) => connection([...scopes])),
    verifyOwner: vi.fn(async () => {}),
  }
  return { access: () => new AppMetadataAccess(store, host, fetchImpl), data, after, host, writes, setDeny: (value: boolean) => { deny = value } }
}

describe("temporary app metadata access", () => {
  it("journals the exact delta, preserves earlier scopes and removes its authorizing scope last", async () => {
    const env = setup([row("all", `Directory.Read.All ${metadata}`), row("principal", "User.Read", userId)])
    const access = env.access()
    env.host.consent.mockImplementation(async () => {
      env.after([row("all", `Directory.Read.All ${metadata} ${removal}`), row("principal", `User.Read ${metadata}`, userId), row("unrelated", removal, otherUser)])
      return { status: "received" }
    })
    await access.run(normal, runId, new AbortController().signal, async () => {
      expect([...env.data.values()].join(" ")).toContain(`"principalId":"${userId}","scope":"${metadata}"`)
      expect(access.status(tenantId)?.status).toBe("active")
    })
    expect(env.writes).toEqual([["PATCH", "principal", "User.Read"], ["PATCH", "all", `Directory.Read.All ${metadata}`]])
    expect(access.status(tenantId, runId)).toMatchObject({ status: "verified", scopes: [
      { consentType: "AllPrincipals", principalId: null, scope: removal }, { consentType: "Principal", principalId: userId, scope: metadata },
    ] })
  })

  it("records pending after partial failure and retries with just the remaining authorizing scope after restart", async () => {
    const env = setup()
    env.setDeny(true)
    const access = env.access()
    await access.run(normal, runId, new AbortController().signal, async () => {})
    expect(env.writes).toEqual([["PATCH", "all", `Directory.Read.All User.Read ${removal}`]])
    const pending = env.access().status(tenantId)!
    expect(pending).toMatchObject({ status: "pending", scopes: [{ scope: removal }] })
    const instructions = appMetadataRemovalInstructions(pending)
    expect(instructions).toContain("All applications → TenuVault → Permissions")
    expect(instructions).toContain(`Admin consent: ${removal}`)
    expect(instructions).not.toContain(metadata)
    env.setDeny(false)
    expect(await env.access().retry(normal)).toMatchObject({ status: "verified" })
    expect(env.host.token).toHaveBeenLastCalledWith(tenantId, [removal], false)
    expect(env.host.consent).toHaveBeenCalledTimes(1)
    expect(env.writes.at(-1)).toEqual(["PATCH", "all", "Directory.Read.All User.Read"])
  })

  it("deletes an empty principal grant during cleanup even when restore fails", async () => {
    const env = setup()
    env.host.consent.mockImplementation(async () => {
      env.after([row("all", "Directory.Read.All User.Read"), row("principal", `${metadata} ${removal}`, userId)])
      return { status: "received" }
    })
    await expect(env.access().run(normal, runId, new AbortController().signal, async () => { throw new Error("restore failed") })).rejects.toThrow("restore failed")
    expect(env.writes).toEqual([["PATCH", "principal", removal], ["DELETE", "principal", ""]])
    expect(env.access().status(tenantId, runId)?.status).toBe("verified")
  })

  it("refuses before consent when the removal flow or the baseline grant read is unavailable", async () => {
    const env = setup()
    const restore = vi.fn(async () => {})
    env.host.available.mockResolvedValueOnce(false)
    await expect(env.access().run(normal, runId, new AbortController().signal, restore)).rejects.toThrow("permission removal can be verified")
    await expect(env.access().run(connection(["User.Read"]), runId, new AbortController().signal, restore)).rejects.toThrow("required permissions")
    expect(env.host.consent).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })

  it("keeps interrupted consent pending, cleans observed access and never opens consent on retry", async () => {
    const env = setup()
    const controller = new AbortController()
    env.host.consent.mockImplementation(async () => { controller.abort(); return { status: "received" } })
    const restore = vi.fn(async () => {})
    await expect(env.access().run(normal, runId, controller.signal, restore)).rejects.toThrow()
    expect(restore).not.toHaveBeenCalled()
    expect(env.access().status(tenantId)).toMatchObject({ status: "pending", uncertain: true })
    env.after([row("all", `Directory.Read.All User.Read ${metadata} ${removal}`)])
    expect(await env.access().retry(normal)).toMatchObject({ status: "verified" })
    expect(env.host.consent).toHaveBeenCalledTimes(1)
  })

  it("does not request consent or remove scopes that were already granted", async () => {
    const env = setup([row("all", `Directory.Read.All ${metadata} ${removal}`)])
    const access = env.access(), restore = vi.fn(async () => {})
    await access.run(normal, runId, new AbortController().signal, restore)
    expect(env.host.consent).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledTimes(1)
    expect(env.writes).toEqual([])
    expect(access.status(tenantId, runId)).toMatchObject({ status: "verified", scopes: [] })
  })

  it("keeps the Graph transport bound to the main-process grant path, action and bearer", async () => {
    const caps = new ConnectionCapabilities(() => ({ version: 1, origin: "wizard", method: "tenuvaultApp", clientId: TENUVAULT_CLIENT_ID, createdAt: "", updatedAt: "" }))
    const writer = connection([removal])
    caps.requireIssuedToken(tenantId, TENUVAULT_CLIENT_ID, RESOURCE_SCOPES.graph, writer.token, { grantedScopes: [removal] })
    const path = "/beta/oauth2PermissionGrants/test-grant"
    const authorize = (target: string, method = "DELETE", token = writer.token) => {
      const url = new URL("https://graph.microsoft.com" + target)
      return caps.authorizeRequest(url, url, { method, headers: { Authorization: `Bearer ${token}` } }, tenantId)
    }
    await withTemporaryDirectoryWrite(writer, path, "DELETE", "removal", async () => {
      const authorization = await authorize(path)
      expect(() => authorization?.beforeDispatch?.()).not.toThrow()
      await expect(authorize(path + "-another")).rejects.toThrow("could not verify")
      await expect(authorize(path, "PATCH")).rejects.toThrow("could not verify")
      await expect(authorize(path, "DELETE", "another-bearer")).rejects.toThrow("could not verify")
    })
    await expect(authorize(path)).rejects.toThrow()
  })

  it("limits both scopes to method B temporary access and excludes both from all normal packs", () => {
    expect(GRANT_REMOVAL_SCOPE).toBe("DelegatedPermissionGrant.ReadWrite.All")
    expect(APPLICATION_METADATA_RESTORE_PACK.scopes).toEqual(["Application.ReadWrite.All", GRANT_REMOVAL_SCOPE])
    expect(privilegedRestoreConsent("tenuvaultApp", "Applications")?.pack).toBe(APPLICATION_METADATA_RESTORE_PACK)
    expect(privilegedRestoreConsent("graphCli", "Applications")).toBeNull()
    expect(privilegedRestoreConsent("ownApp", "Applications")).toBeNull()
    for (const access of ["backup", "restore"] as const) {
      const packs = tenantPermissionPacks({
        entra: { access, areas: ["applications", "roles", "groups", "usersAndDevices"] },
        intune: { access }, defender: { access }, conditionalAccess: { access },
      }, { azure: true, audit: true })
      expect(packs.flatMap(pack => pack.scopes)).not.toContain(metadata)
      expect(packs.flatMap(pack => pack.scopes)).not.toContain(removal)
    }
  })
})
