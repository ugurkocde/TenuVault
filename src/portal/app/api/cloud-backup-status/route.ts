import { blobPath, isGuid } from "../../../../shared/security"
import { assertStorageAccountName } from "../../../../shared/storage-account"
import { cloudAuditStatusBlobName, cloudStatusBlobName, parseCloudStatus } from "../../../../shared/cloud-backup"
import { BACKUP_CONTAINER } from "../../../../shared/constants"
import { CLOUD_OUTCOME_CONTAINER } from "../../../../shared/notifications/cloud-outcome"
import { type NextRequest, NextResponse } from "next/server"

const storageHeaders = (token: string) => ({ 'x-ms-version': '2021-12-02', 'x-ms-date': new Date().toUTCString(), Authorization: `Bearer ${token}` })

/**
 * The last cloud backup run for a tenant, read from the status blob the Azure Automation
 * runbook writes to the backup container. Audit delivery health comes from the results
 * container for the same run, when available.
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
    const auditBlob = cloudAuditStatusBlobName(parsed, tenantId)
    let auditStatus: unknown
    if (auditBlob) {
      try {
        const auditResponse = await fetch(`https://${storageAccountName}.blob.core.windows.net/${CLOUD_OUTCOME_CONTAINER}/${blobPath(auditBlob)}`, {
          headers: storageHeaders(accessToken),
          signal: AbortSignal.timeout(2000),
        })
        if (auditResponse.ok) auditStatus = await auditResponse.json()
      } catch {
        // Schedule status is still usable if the audit status cannot be read.
      }
    }
    return NextResponse.json({ cloudStatus: parseCloudStatus(parsed, tenantId, auditStatus) })
  } catch (error) {
    if (error instanceof Error && (error.name === 'FetchApplicationError' || error.name === 'FetchPreconditionError')) {
      return NextResponse.json({ error: error.message }, { status: 502 })
    }
    return NextResponse.json({ error: "Cloud backup status could not be read." }, { status: 502 })
  }
}
