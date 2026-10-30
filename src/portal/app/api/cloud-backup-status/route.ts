import { blobPath, isGuid } from "../../../../shared/security"
import { assertStorageAccountName } from "../../../../shared/storage-account"
import { cloudStatusBlobName, parseCloudStatus } from "../../../../shared/cloud-backup"
import { BACKUP_CONTAINER } from "../../../../shared/constants"
import { type NextRequest, NextResponse } from "next/server"

const storageHeaders = (token: string) => ({ 'x-ms-version': '2021-12-02', 'x-ms-date': new Date().toUTCString(), Authorization: `Bearer ${token}` })

/**
 * The last cloud backup run for a tenant, read from the status blob the Azure Automation
 * runbook writes after every run (Invoke-TenuVaultBackup.ps1). Nothing is written here and no
 * Azure resource is touched: the app only reports what the runbook already recorded in the
 * tenant's own backup container, through the same sealed storage reads as the backup list.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { tenantId, appId, clientSecret, storageAccountName } = body
    if (!isGuid(tenantId) || !appId || !clientSecret || typeof storageAccountName !== 'string' || !storageAccountName) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
    }
    try {
      assertStorageAccountName(storageAccountName)
    } catch {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
    }

    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: appId,
          client_secret: clientSecret,
          scope: "https://storage.azure.com/.default",
          grant_type: "client_credentials",
        }),
      },
    )
    if (!tokenResponse.ok) {
      return NextResponse.json({ error: "Failed to authenticate with Azure" }, { status: 401 })
    }
    const accessToken = (await tokenResponse.json()).access_token

    const blob = cloudStatusBlobName(tenantId)
    const response = await fetch(`https://${storageAccountName}.blob.core.windows.net/${BACKUP_CONTAINER}/${blobPath(blob)}`, { headers: storageHeaders(accessToken) })
    if (response.status === 404) return NextResponse.json({ cloudStatus: null })
    if (!response.ok) {
      return NextResponse.json(
        { error: `Cloud backup status is unavailable (${response.status}). Check storage access and try again.` },
        { status: 502 },
      )
    }
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return NextResponse.json({ cloudStatus: null })
    }
    return NextResponse.json({ cloudStatus: parseCloudStatus(parsed, tenantId) })
  } catch (error) {
    if (error instanceof Error && (error.name === 'FetchApplicationError' || error.name === 'FetchPreconditionError')) {
      return NextResponse.json({ error: error.message }, { status: 502 })
    }
    return NextResponse.json({ error: "Cloud backup status could not be read." }, { status: 502 })
  }
}
