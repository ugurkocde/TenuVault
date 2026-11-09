import { recoveryReadiness, type RecoveryReadiness } from "../../../../shared/intune/recovery"
import { type NextRequest, NextResponse } from "next/server"
import { validPolicyPath } from "~/lib/policies/restore"
import { readOwnedBackup, UNTAGGED_BACKUP } from "~/lib/policies/backup-owner"
import { graphCaller, locateLive, readLive } from "~/lib/policies/graph-restore"
import { itemName, typeForFolder, type Item, type ReviewChange } from "../../../../shared/intune/registry"
import { restoreCapabilities } from "../../../../shared/intune/restore-plan"
import { sameSnapshot } from "../../../../shared/intune/compare"
import { assignmentsUnread } from "../../../../shared/intune/read"
import { moduleForFolder, restorePermissionBlocker } from "../../../../shared/services/modules"
import { grantedPermissions } from "../../../../shared/services/token"
import { isLegacySealedError } from "../../../../shared/legacy-sealed"

const MAX_ITEMS = 2000
const CONCURRENCY = 6

export interface PreviewItem {
  path: string
  folder: string
  name: string
  /** Why the item cannot be recreated from the backup, when it cannot. */
  blocker?: string
  replaceBlocker?: string
  readiness?: RecoveryReadiness
  snapshot?: Item
  /** The item in the tenant now, when `live` was requested: deleted, identical, or changed since the backup. */
  live?: "missing" | "same" | "changed" | "error"
  /** Only the assignments differ from the backup. */
  assignmentsOnly?: boolean
  liveName?: string
  /** For types that describe it (IntuneType.review): what replacing the live item changes, setting by setting. */
  changes?: ReviewChange[]
  error?: string
}

async function token(tenantId: string, appId: string, clientSecret: string, scope: string, forceRefresh = false): Promise<string> {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope, force_refresh: String(forceRefresh), grant_type: "client_credentials" }),
  })
  if (!response.ok) throw new Error("Failed to get access token")
  return (await response.json()).access_token as string
}

/**
 * What restoring items from a backup would do, without changing anything:
 *   POST /api/restore-preview { tenantId, appId, clientSecret, storageAccountName, backupId, paths, live? }
 * Reads each snapshot for its name and restore blockers and, with `live`, the object in the tenant.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const { tenantId, appId, clientSecret, storageAccountName, backupId, paths, live } = body as {
    tenantId?: string; appId?: string; clientSecret?: string; storageAccountName?: string; backupId?: string; paths?: unknown; live?: unknown
  }
  if (!tenantId || !appId || !clientSecret || !storageAccountName || !backupId || !/^[a-zA-Z0-9_-]+$/.test(backupId)) {
    return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
  }
  if (!Array.isArray(paths) || paths.length > MAX_ITEMS || !paths.every((path) => validPolicyPath(path, backupId))) {
    return NextResponse.json({ error: "Select items from the chosen backup" }, { status: 400 })
  }

  try {
    const [storageToken, graphToken] = await Promise.all([
      token(tenantId, appId, clientSecret, "https://storage.azure.com/.default"),
      // An opt-in service's items are checked against the app registration's permissions, so a restore
      // that would be refused shows as not restorable here instead of failing when it starts.
      live === true
        ? token(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default")
        : paths.some((path) => moduleForFolder(String(path).split("/")[1] ?? "")?.module.optIn)
          // Without the token the restore still checks the permission before its first write.
          ? token(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default").catch(() => "")
          : Promise.resolve(""),
    ])
    const granted = grantedPermissions(graphToken)
    const owned = await readOwnedBackup((name) => fetch(`https://${storageAccountName}.blob.core.windows.net/intune-backups/${name.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${storageToken}` },
    }), backupId, tenantId, storageAccountName)
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
    // A backup that records no tenant cannot change live policies; it can still be restored as a copy.
    const ownership = owned.owned ? undefined : UNTAGGED_BACKUP
    const graph = graphCaller(graphToken, fetch, { tenant: tenantId, refreshToken: () => token(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default", true) })

    const preview = async (path: string): Promise<PreviewItem> => {
      const folder = path.split("/")[1] ?? ""
      const type = typeForFolder(folder === "DeviceCompliancePolicies" ? "CompliancePolicies" : folder)
      const fallbackName = (path.split("/")[2] ?? "").replace(/\.json$/, "")
      if (!type) return { path, folder, name: fallbackName, blocker: "This backup file is not an Intune type TenuVault can restore.", replaceBlocker: "This type cannot be replaced." }
      const response = await fetch(`https://${storageAccountName}.blob.core.windows.net/intune-backups/${path.split("/").map(encodeURIComponent).join("/")}`, {
        headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${storageToken}` },
      })
      if (!response.ok) return { path, folder: type.folder, name: fallbackName, live: "error", error: "The backup file could not be read.", blocker: "The backup file could not be read.", replaceBlocker: "The backup file could not be read." }
      const snapshot = (await response.json()) as Item
      const item: PreviewItem = { path, folder: type.folder, name: itemName(type, snapshot), snapshot, readiness: recoveryReadiness(type, snapshot), ...restoreCapabilities(type, snapshot) }
      if (ownership) item.replaceBlocker = ownership
      if (live !== true || typeof snapshot.id !== "string") return item
      try {
        // An object added again under a new ID (such as an Autopilot device imported again) is found by the type's locateBy property.
        const current = (await readLive(graph, type, snapshot.id)) ?? (ownership ? undefined : await locateLive(graph, type, snapshot))
        if (!current) return { ...item, live: "missing" }
        Object.assign(item, restoreCapabilities(type, snapshot, current))
        if (ownership) item.replaceBlocker = ownership
        const name = current[type.nameKey] ?? current.displayName ?? current.name
        // A device found again under a new ID compares by its properties, as the restore does.
        const { assignments: _a, ...wanted } = typeof current.id === "string" ? { ...snapshot, id: current.id } : snapshot
        const { assignments: _b, ...now } = current
        const settingsSame = sameSnapshot(wanted, now)
        // A snapshot without assignments and an item with none mean the same. A backup that could not read
        // the assignments says nothing about them, and restore leaves them alone.
        const same = settingsSame && (assignmentsUnread(type, snapshot) || sameSnapshot(snapshot.assignments ?? [], current.assignments ?? []))
        const changes = !settingsSame ? type.review?.(snapshot, current) : undefined
        return { ...item, live: same ? "same" : "changed", ...(settingsSame && !same ? { assignmentsOnly: true } : {}), ...(changes ? { changes } : {}), liveName: typeof name === "string" ? name : undefined }
      } catch (error) {
        return { ...item, live: "error", error: error instanceof Error ? error.message : String(error) }
      }
    }

    const items: PreviewItem[] = new Array(paths.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, async () => {
      while (next < paths.length) {
        const index = next++
        const path = paths[index] as string
        try { items[index] = withPermission(await preview(path), granted) }
        catch (error) {
          // A backup sealed by an earlier version says which key it needs.
          const sealed = isLegacySealedError(error) ? (error as Error).message : null
          items[index] = { path, folder: path.split("/")[1] ?? "", name: path.split("/").pop() ?? path, live: "error", error: sealed ?? "This snapshot could not be read or assessed.", blocker: sealed ?? "This snapshot could not be assessed.", replaceBlocker: sealed ?? "This snapshot could not be assessed." }
        }
      }
    }))
    return NextResponse.json({ backupId, items })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The restore preview failed." }, { status: 500 })
  }
}

/** Marks an item not restorable when the app registration lacks its opt-in service's write permission. */
function withPermission(item: PreviewItem, granted: ReturnType<typeof grantedPermissions>): PreviewItem {
  const blocker = restorePermissionBlocker(item.folder, granted)
  return blocker ? { ...item, blocker: item.blocker ?? blocker, replaceBlocker: item.replaceBlocker ?? blocker } : item
}
