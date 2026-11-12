import { sourceTenant } from "../app-sources/store"
import type { IntuneBackupApp } from "../../shared/app-sources/types"

/** Only this collection's beta next links may receive the delegated token. */
export async function readAppBackupApps(tenant: string, tokenForTenant: (tenant: string) => Promise<string>, fetchImpl: typeof fetch): Promise<{ apps: IntuneBackupApp[]; fetchedAt: string }> {
  const token = await tokenForTenant(sourceTenant(tenant))
  if (!token) throw new Error("Sign in to Microsoft to load this tenant's apps.")
  let next = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?$select=id,displayName,publisher&$top=100"
  const seen = new Set<string>(), apps = new Map<string, IntuneBackupApp>()
  while (next) {
    const url = new URL(next)
    if (url.origin !== "https://graph.microsoft.com" || url.pathname !== "/beta/deviceAppManagement/mobileApps" || url.username || url.password || url.hash || seen.has(next) || seen.size >= 500) throw new Error("Intune returned an invalid app-list continuation. Refresh the list.")
    seen.add(next)
    const response = await fetchImpl(next, { method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) })
    if (response.status !== 200) throw new Error(`Could not load Intune apps (HTTP ${response.status}). Check Microsoft sign-in and Intune permissions.`)
    const body = await response.json() as Record<string, unknown>
    if (!body || !Array.isArray(body.value)) throw new Error("Intune returned an invalid app list.")
    for (const row of body.value) {
      if (!row || row["@odata.type"] !== "#microsoft.graph.win32LobApp") continue
      const id = sourceTenant(row.id)
      if (typeof row.displayName !== "string") throw new Error("Intune returned incomplete app details.")
      apps.set(id, { id, name: row.displayName.trim().slice(0, 300) || "Unnamed app", publisher: typeof row.publisher === "string" ? row.publisher.slice(0, 300) : "" })
    }
    if (body["@odata.nextLink"] !== undefined && typeof body["@odata.nextLink"] !== "string") throw new Error("Intune returned an invalid app-list continuation.")
    next = (body["@odata.nextLink"] as string | undefined) ?? ""
  }
  return { apps: [...apps.values()].sort((a,b) => a.name.localeCompare(b.name)), fetchedAt: new Date().toISOString() }
}
