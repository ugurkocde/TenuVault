import { vi } from "vitest"
import { GRAPH_APP_ID } from "../../src/shared/services/manifest"
import type { AdditionConnection } from "../../src/main/auth/registration-additions"

export const additionConnection: AdditionConnection = {
  tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222",
  username: "admin@contoso.test", homeAccountId: "home.tenant", scopes: ["User.Read", "openid", "profile", "offline_access"],
  allowed: ["Policy.Read.All", "Group.Read.All"],
}
export function additionGraph() {
  const app = { id: "app-object", appId: additionConnection.clientId, displayName: "Contoso Backup", signInAudience: "AzureADMyOrg", publicClient: { redirectUris: ["http://localhost"] }, web: { redirectUris: [] as string[] }, spa: { redirectUris: [] as string[] }, passwordCredentials: [] as unknown[], keyCredentials: [] as unknown[], requiredResourceAccess: [
    { resourceAppId: "other-api", resourceAccess: [{ id: "unknown", type: "Role", extra: "keep" } as { id: string; type: string; extra?: string }] },
    { resourceAppId: GRAPH_APP_ID.toUpperCase(), resourceAccess: [{ id: "pending-id", type: "Scope" }, { id: "role-id", type: "Role" }] },
  ] }
  const client = { id: "client-object", appId: additionConnection.clientId, accountEnabled: true, passwordCredentials: [] as unknown[], keyCredentials: [] as unknown[], publishedPermissionScopes: [] }
  const resource = { id: "graph-object", appId: GRAPH_APP_ID, accountEnabled: true, passwordCredentials: [], keyCredentials: [], publishedPermissionScopes: [{ id: "policy-id", value: "Policy.Read.All", isEnabled: true }, { id: "group-id", value: "Group.Read.All", isEnabled: true }] }
  const grants = [{ id: "grant-id", clientId: client.id, resourceId: resource.id, consentType: "AllPrincipals", principalId: null as string | null, scope: "User.Read Unknown.Read" }, { id: "other-grant", clientId: client.id, resourceId: "other-resource", consentType: "AllPrincipals", principalId: null as string | null, scope: "Other.Read" }]
  const state = { app, client, resource, grants, federated: [] as { id: string }[], failure: "", throwAfter: "", stale: false, badPage: "", readFailure: false }
  const writes: { method: string; path: string; body: unknown }[] = []
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET"
    if (method !== "GET") {
      const body = JSON.parse(String(init?.body))
      writes.push({ method, path: url.pathname, body })
      if (state.failure === url.pathname) return new Response("", { status: 403 })
      if (!state.stale) {
        if (url.pathname.includes("/applications/")) Object.assign(state.app, body)
        else if (method === "PATCH") Object.assign(grants.find(g => url.pathname.endsWith(g.id))!, body)
        else grants.push({ id: "created", principalId: null, ...body })
      }
      if (state.throwAfter === url.pathname) { state.readFailure = state.failure === "readAfter"; throw new Error("No answer") }
      return new Response(null, { status: 204 })
    }
    if (state.readFailure) return new Response("", { status: 503 })
    const value = url.pathname.includes("federatedIdentityCredentials") ? { value: state.federated }
      : (url.pathname.includes("/applications(") || url.pathname.toLowerCase() === `/beta/applications/${state.app.id.toLowerCase()}`) ? state.app
      : url.pathname === "/beta/oauth2PermissionGrants/grant-id" ? state.grants[0]
      : url.pathname.endsWith("servicePrincipals") ? { value: [url.searchParams.get("$filter")?.toLowerCase().includes(state.client.appId.toLowerCase()) ? state.client : state.resource] }
      : { value: state.grants, ...(state.badPage ? { "@odata.nextLink": state.badPage } : {}) }
    return Response.json(value)
  }) as unknown as typeof fetch
  return { state, request, writes }
}
