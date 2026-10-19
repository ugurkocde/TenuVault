import { type NextRequest, NextResponse } from "next/server"
import { decodeXml, listBlobPages } from "~/lib/storage/list"
import { typeForFolder } from "../../../../shared/intune/registry"
import { comparable, compareBackups, type BackupFingerprint } from "../../../../shared/intune/backup-changes"
import { compareObjects } from "../detect-drifts/route"
import { withoutUnreadAssignments } from "../../../../shared/intune/read"
import { ownedBy, readOwnedBackup } from "~/lib/policies/backup-owner"

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
  const read = async (path: string) => {
    const response = await fetch(`${container}/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${accessToken}` },
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Backup storage returned ${response.status}. Check storage access and retry.`)
    return response.json()
  }

  try {
    const owned = await readOwnedBackup((name) => fetch(`${container}/${name.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${accessToken}` },
    }), backupId, tenantId)
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
      const metadata = (await read(`${id}/metadata.json`)) as BackupFingerprint | null
      // A shared container also holds other tenants' backups; only this tenant's are compared.
      if (metadata && ownedBy(metadata, tenantId) && comparable(metadata)) {
        previous = { id, metadata }
        break
      }
    }
    if (!previous) {
      return NextResponse.json({ backupId, comparedWith: null, changes: [] })
    }

    const changes = compareBackups(previous.metadata, current)
    let detailed = 0
    const items = await Promise.all(
      changes.map(async (change) => {
        const type = typeForFolder(change.folder)
        const name = (change.file ?? "").replace(/\.json$/, "")
        const base = { ...change, name, typeLabel: type?.label ?? change.folder, area: type?.area ?? "Other" }
        if (change.change !== "modified" || detailed++ >= MAX_DETAILED) return base
        const [before, after] = await Promise.all([
          read(`${previous!.id}/${change.folder}/${change.previousFile}`),
          read(`${backupId}/${change.folder}/${change.file}`),
        ])
        if (!before || !after) return base
        // Field level changes, capped so one large policy does not flood the response.
        const fields = compareObjects(...withoutUnreadAssignments(type, before, after)).slice(0, 50)
        return { ...base, fields }
      }),
    )
    const order = { removed: 0, modified: 1, added: 2 }
    items.sort((a, b) => order[a.change] - order[b.change] || a.typeLabel.localeCompare(b.typeLabel) || a.name.localeCompare(b.name))
    return NextResponse.json({ backupId, comparedWith: previous.id, changes: items })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Changes could not be listed." }, { status: 500 })
  }
}
