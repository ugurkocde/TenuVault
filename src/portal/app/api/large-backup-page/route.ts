import { backupStoragePath } from "../../../../shared/backup-storage"
import { NextRequest, NextResponse } from "next/server"
import { readOwnedBackup } from "~/lib/policies/backup-owner"
import { compareLargePage } from "../../../../main/backup/large-page"
import { largeIndexes } from "../../../../shared/large-backup"
import { isBackupName } from "../../../../shared/intune/backup-names"
import { readJsonCapped } from "../../../../shared/capped-body"
import { comparisonCoverage } from "../../../../shared/intune/backup-read-coverage"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { tenantId, appId, clientSecret, storageAccountName, backupId, baseline, folder } = body
    if (!tenantId || !appId || !clientSecret || !storageAccountName || !isBackupName(backupId) || !isBackupName(baseline) || typeof folder !== "string") return NextResponse.json({ error: "Choose an inventory and two backups" }, { status: 400 })
    const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope: "https://storage.azure.com/.default", grant_type: "client_credentials" }) })
    if (!tokenResponse.ok) throw new Error("Storage sign-in failed")
    const token = (await tokenResponse.json()).access_token
    const readResponse = (name: string) => fetch(`https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(name)}`, { headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${token}` } })
    const [older, newer] = await Promise.all([readOwnedBackup(readResponse, baseline, tenantId, storageAccountName), readOwnedBackup(readResponse, backupId, tenantId, storageAccountName)])
    if (!older.ok) return NextResponse.json({ error: older.error }, { status: older.status })
    if (!newer.ok) return NextResponse.json({ error: newer.error }, { status: newer.status })
    if (!largeIndexes(older.metadata)[folder]?.complete || !largeIndexes(newer.metadata)[folder]?.complete || !comparisonCoverage(older.metadata, newer.metadata).shared.has(folder)) throw new Error("Both backups must completely cover this inventory")
    const reader = (id: string) => async (name: string) => {
      const response = await readResponse(`${id}/${name}`)
      if (!response.ok) throw new Error("Inventory page could not be read")
      const json = await readJsonCapped(response, 1024 * 1024)
      if (json.kind !== "json") throw new Error("Invalid inventory page")
      return json.value
    }
    const cursor = body.cursor ?? [0, 0]
    if (!Array.isArray(cursor) || cursor.length !== 2) throw new Error("Invalid comparison cursor")
    return NextResponse.json(await compareLargePage(folder, older.metadata!, newer.metadata!, cursor as [number, number], reader(baseline), reader(backupId)))
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Inventory comparison failed" }, { status: 400 }) }
}
