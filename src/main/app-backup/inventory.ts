import { appMetadataGet, appText, appIcon, appDate } from "./graph-read"
import { sourceTenant } from "../app-sources/store"
import type { IntuneBackupApp } from "../../shared/app-sources/types"

/** Only this collection's beta next links may receive the delegated token. */
export async function readAppBackupApps(tenant: string, tokenForTenant: (tenant: string) => Promise<string>, fetchImpl: typeof fetch): Promise<{ apps: IntuneBackupApp[]; fetchedAt: string }> {
  const token = await tokenForTenant(sourceTenant(tenant))
  if (!token) throw new Error("Sign in to Microsoft to load this tenant's apps.")
  let next = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?$filter=isof('microsoft.graph.win32LobApp')&$select=id,displayName,publisher,largeIcon,lastModifiedDateTime,isAssigned,microsoft.graph.win32LobApp/displayVersion,microsoft.graph.win32LobApp/installExperience&$top=50"
  let iconBytes = 0
  const seen = new Set<string>(), apps = new Map<string, IntuneBackupApp>()
  while (next) {
    const url = new URL(next)
    if (url.origin !== "https://graph.microsoft.com" || url.pathname !== "/beta/deviceAppManagement/mobileApps" || url.username || url.password || url.hash || seen.has(next) || seen.size >= 500) throw new Error("Intune returned an invalid app-list continuation. Refresh the list.")
    seen.add(next)
    const body = await appMetadataGet(next, token, fetchImpl)
    if (!body || !Array.isArray(body.value)) throw new Error("Intune returned an invalid app list.")
    for (const row of body.value) {
      if (!row || row["@odata.type"] !== "#microsoft.graph.win32LobApp") continue
      const id = sourceTenant(row.id)
      if (typeof row.displayName !== "string") throw new Error("Intune returned incomplete app details.")
      const candidate = appIcon(row.largeIcon)
      const icon = candidate && iconBytes + candidate.length <= 12 * 1024 ** 2 ? candidate : null
      if (icon) iconBytes += icon.length
      apps.set(id, { id, name: row.displayName.trim().slice(0, 300) || "Unnamed app", publisher: appText(row.publisher, 300), version: appText(row.displayVersion, 200) || null, icon, modifiedAt: appDate(row.lastModifiedDateTime), installContext: appText(row.installExperience?.runAsAccount, 40) || null, assigned: typeof row.isAssigned === "boolean" ? row.isAssigned : null })
    }
    if (body["@odata.nextLink"] !== undefined && typeof body["@odata.nextLink"] !== "string") throw new Error("Intune returned an invalid app-list continuation.")
    next = (body["@odata.nextLink"] as string | undefined) ?? ""
  }
  return { apps: [...apps.values()].sort((a,b) => a.name.localeCompare(b.name)), fetchedAt: new Date().toISOString() }
}
