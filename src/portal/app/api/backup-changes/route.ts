import { type NextRequest, NextResponse } from "next/server"
import { decodeXml, listBlobPages } from "~/lib/storage/list"
import { typeForFolder } from "../../../../shared/intune/registry"
import { compareBackupFiles } from "~/lib/policies/compare-backups"
import { comparable, type BackupFingerprint } from "../../../../shared/intune/backup-changes"
import { compareObjects } from "../detect-drifts/route"
import { readOwnedBackup } from "~/lib/policies/backup-owner"

/** Changed items that also get a field by field comparison; the rest are listed without one. */
const MAX_DETAILED = 100
const BACKUP_ID = /^backup-\d{4}-\d{2}-\d{2}-\d{6}$/

/**
 * What changed in the tenant between a backup and the newest older backup it can be compared with:
 *   POST /api/backup-changes { tenantId, appId, clientSecret, storageAccountName, backupId }
 * Only types both backups hold are compared.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const { tenantId, appId, clientSecret, storageAccountName, backupId } = body as Record<string, string | undefined>
  if (!tenantId || !appId || !clientSecret || !storageAccountName || !backupId || !BACKUP_ID.test(backupId)) {
    return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
  }

  const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope: "https://storage.azure.com/.default", grant_type: "client_credentials" }),
  })
  if (!tokenResponse.ok) return NextResponse.json({ error: "Failed to authenticate with Azure", details: await tokenResponse.text() }, { status: 401 })
  const accessToken = (await tokenResponse.json()).access_token as string

  const container = `https://${storageAccountName}.blob.core.windows.net/intune-backups`
  try {
    const readBlob = (name: string) => fetch(`${container}/${name.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${accessToken}` },
    })
    const owned = await readOwnedBackup(readBlob, backupId, tenantId)
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
    const current = owned.metadata as BackupFingerprint | null
    if (!current || !comparable(current)) {
      return NextResponse.json({ error: "This backup was made by an older version of TenuVault or did not finish, so its changes cannot be listed.", code: "NOT_COMPARABLE" }, { status: 409 })
    }

    const listing = await listBlobPages(`${container}?restype=container&comp=list&prefix=backup-&delimiter=/`, accessToken)
    const older = [...listing.matchAll(/<BlobPrefix><Name>(backup-\d{4}-\d{2}-\d{2}-\d{6})\/<\/Name><\/BlobPrefix>/g)]
      .map((match) => decodeXml(match[1]!))
      .filter((name) => name < backupId)
      .sort()
      .reverse()

    let previous: { id: string; metadata: BackupFingerprint } | null = null
    for (const id of older) {
      // A shared container also holds other tenants' backups; only this tenant's are compared,
      // placed as the backup list places them. A backup that cannot be placed is skipped.
      const candidate = await readOwnedBackup(readBlob, id, tenantId)
      const metadata = candidate.ok ? candidate.metadata as BackupFingerprint | null : null
      if (metadata && comparable(metadata)) {
        previous = { id, metadata }
        break
      }
    }
    if (!previous) {
      return NextResponse.json({ backupId, comparedWith: null, changes: [] })
    }

    const { entries, partial, excludedPaths } = await compareBackupFiles(previous, { id: backupId, metadata: current }, readBlob, compareObjects, MAX_DETAILED)
    const items = entries.map(({ change, fields }) => {
      const type = typeForFolder(change.folder)
      const name = (change.file ?? "").replace(/\.json$/, "")
      return { ...change, name, typeLabel: type?.label ?? change.folder, area: type?.area ?? "Other", ...(fields ? { fields } : {}) }
    })
    const order = { removed: 0, modified: 1, added: 2 }
    items.sort((a, b) => order[a.change] - order[b.change] || a.typeLabel.localeCompare(b.typeLabel) || a.name.localeCompare(b.name))
    return NextResponse.json({ backupId, comparedWith: previous.id, changes: items, ...(partial ? { partial, excludedPaths } : {}) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Changes could not be listed." }, { status: 500 })
  }
}
