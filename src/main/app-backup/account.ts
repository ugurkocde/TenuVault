import { sourceTenant } from "../app-sources/store"

/** A free, read-only device check. Authentication is independent of product licensing. */
export async function readAppBackupAccount(tenant: string, tokenForTenant: (tenant: string) => Promise<string>, fetchImpl: typeof fetch): Promise<string> {
  const id = sourceTenant(tenant), token = await tokenForTenant(id)
  if (!token) throw new Error("Sign in to this tenant before checking its Intune account.")
  const response = await fetchImpl("https://graph.microsoft.com/beta/deviceManagement?$select=intuneAccountId", {
    method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
  })
  if (response.status !== 200) throw new Error(`Could not confirm the Intune account (HTTP ${response.status}).`)
  const body: unknown = await response.json()
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Intune returned an invalid account response.")
  return sourceTenant((body as Record<string, unknown>).intuneAccountId)
}
