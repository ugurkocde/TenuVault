import { afterEach, expect, it, vi } from "vitest"
import { POST as tenantDetails } from "../src/portal/app/api/fetch-tenant-details/route"
import { POST as azureResources } from "../src/portal/app/api/list-azure-resources/route"
import { POST as backupContents } from "../src/portal/app/api/list-backup-contents/route"
import { POST as backups } from "../src/portal/app/api/list-backups/route"
import { POST as loadMetadata } from "../src/portal/app/api/tenant-metadata/load/route"
import { POST as saveMetadata } from "../src/portal/app/api/tenant-metadata/save/route"
import { POST as deleteMetadata } from "../src/portal/app/api/tenant-metadata/delete/route"
import { POST as detectDrifts } from "../src/portal/app/api/detect-drifts/route"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const routes = [
  [tenantDetails, "Graph", true], [azureResources, "Azure", true], [backupContents, "Azure", true],
  [backups, "Azure", true], [loadMetadata, "Azure", false], [saveMetadata, "Azure", false], [deleteMetadata, "Azure", false],
] as const
const requestBody = { tenantId: "a1111111-1111-1111-1111-11111111111b", appId: "c3333333-3333-3333-3333-33333333333d", clientSecret: "fixture", storageAccountName: "fixture", subscriptionId: "fixture", resourceGroupName: "fixture", backupId: "backup-2026-01-01-120000", metadata: {} }

it.each(routes)("keeps sign-in details in the response and logs only the normalized code (%#)", async (route, label, returnsDetails) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const description = "Your session for admin@example.test has ended. Sign in again."
  const error = { error: "interaction_required", error_description: description }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(error, { status: 401 })))
  const response = await route(new Request("https://desktop.test/api", { method: "POST", body: JSON.stringify(requestBody) }) as never)
  expect(response.status).toBe(401)
  const result = await response.json()
  if (returnsDetails) expect(result).toMatchObject({ details: JSON.stringify(error) })
  else expect(result).toEqual({ error: "Failed to authenticate with Azure" })
  expect(log.mock.calls).toEqual([[`${label} auth error:`, "interaction_required"]])
})

it.each(routes)("logs a fixed code for malformed successful token responses (%#)", async (route, label) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const fetch = vi.fn(async () => new Response("admin@example.test returned an invalid response", { headers: { "content-type": "application/json" } }))
  vi.stubGlobal("fetch", fetch)
  const response = await route(new Request("https://desktop.test/api", { method: "POST", body: JSON.stringify(requestBody) }) as never)
  expect(log.mock.calls).toEqual([[`${label} auth error:`, "token_invalid_response"]])
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain("admin@example.test")
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each(routes)("rejects an invalid bearer in a JSON token response before building headers (%#)", async (route, label) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    if (init?.headers) new Headers(init.headers)
    return Response.json({ access_token: "invalid\nadmin@example.test" })
  })
  vi.stubGlobal("fetch", fetch)
  const response = await route(new Request("https://desktop.test/api", { method: "POST", body: JSON.stringify(requestBody) }) as never)
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain("admin@example.test")
  expect(log.mock.calls).toEqual([[`${label} auth error:`, "token_invalid_response"]])
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each([
  [403, '{"error":{"message":"Refused for admin@example.test"}}', "graph_request_failed"],
  [200, '{invalid JSON with admin@example.test', "graph_invalid_response"],
])("keeps Graph tenant detail response bodies out of HTTP %i logs", async (status, payload, code) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const body = { tenantId: "tenant", appId: "app", clientSecret: "fixture" }
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input)
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "fixture" })
    if (url.pathname.endsWith("/organization")) return new Response(payload, { status, headers: { "content-type": "application/json" } })
    return Response.json({ value: [], "@odata.count": 0 })
  }))
  const response = await tenantDetails(new Request("https://desktop.test/api", { method: "POST", body: JSON.stringify(body) }) as never)
  expect(response.status).toBe(502)
  expect(log.mock.calls).toEqual([[code, "/organization", status]])
})

it.each([
  [saveMetadata, "metadata container creation", "container", 403, "AuthorizationPermissionMismatch", 200],
  [saveMetadata, "metadata upload", "blob", 403, "AuthorizationPermissionMismatch", 403],
  [loadMetadata, "metadata load", "blob", 403, "AuthorizationPermissionMismatch", 403],
  [deleteMetadata, "metadata delete", "blob", 403, "AuthorizationPermissionMismatch", 403],
  [backups, "backup listing", "container", 403, "AuthorizationFailure", 403],
  [backupContents, "backup contents listing", "container", 403, "AuthorizationFailure", 500],
  [detectDrifts, "drift backup listing", "container", 403, "AuthorizationFailure", 500],
  [saveMetadata, "metadata upload", "blob", 503, "ServerBusy", 500],
  [loadMetadata, "metadata load", "blob", 503, "ServerBusy", 500],
  [deleteMetadata, "metadata delete", "blob", 503, "ServerBusy", 500],
] as const)("keeps Blob error details out of logs for $1 (%#)", async (route, endpoint, kind, status, code, expectedStatus) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const account = "private-account@example.test"
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "fixture" })
    if (route === backupContents && url.pathname.endsWith("/metadata.json")) {
      return Response.json({ TenantId: requestBody.tenantId })
    }
    if (route === saveMetadata && url.searchParams.has("restype") !== (kind === "container")) {
      return new Response(null, { status: 201 })
    }
    return new Response(`<Error><Code>${code}</Code><Message>Refused for ${account}</Message></Error>`, { status })
  }))
  const response = await route(new Request("https://desktop.test/api", { method: "POST", body: JSON.stringify(requestBody) }) as never)
  expect(response.status).toBe(expectedStatus)
  const result = await response.text()
  expect(result).not.toContain(account)
  if (code === "AuthorizationPermissionMismatch" && expectedStatus === 403) expect(result).toContain("Missing storage permissions")
  if (route === backups) expect(result).toContain("Storage network access denied")
  expect(log.mock.calls).toEqual([["blob_request_failed", endpoint, status]])
})

it("keeps account details out of malformed metadata logs", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  vi.stubGlobal("fetch", vi.fn(async (input: string) => new URL(input).hostname === "login.microsoftonline.com"
    ? Response.json({ access_token: "fixture" })
    : new Response("private-account@example.test")))
  const response = await loadMetadata(new Request("https://desktop.test/api", { method: "POST", body: JSON.stringify(requestBody) }) as never)
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain("private-account@example.test")
  expect(log.mock.calls).toEqual([["blob_invalid_response", "metadata load", 200]])
})
