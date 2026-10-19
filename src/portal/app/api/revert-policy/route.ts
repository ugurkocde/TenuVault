import { readOwnedBackup } from "~/lib/policies/backup-owner"
import { validPolicyPath } from "~/lib/policies/restore"
import { isGraphId } from "../../../../shared/security"
import { graphCaller, Restorer } from "~/lib/policies/graph-restore"
import { type NextRequest, NextResponse } from "next/server"
interface RevertPolicyRequest {
  tenantId: string
  appId: string
  clientSecret: string
  storageAccountName: string
  action: "revert" | "restore"
  policyId: string
  policyType: string
  backupPath: string // Path to the backup file containing the desired version
  originalName?: string
  fromBackup?: string // Backup timestamp where change was detected
  toBackup?: string // Backup timestamp with the change
  changes?: Array<{
    field: string
    oldValue: any
    newValue: any
  }>
}

interface RevertMetadata {
  timestamp: string
  action: "revert" | "restore"
  fromBackup: string
  toBackup?: string
  policyName: string
  policyType: string
  changesReverted?: Array<{
    field: string
    oldValue: any
    revertedTo: any
  }>
  newPolicyId?: string // For restore action
  status: "success" | "failed"
  errorMessage?: string
}

export async function POST(request: NextRequest) {
  let body: RevertPolicyRequest | null = null;
  
  try {
    body = await request.json() as RevertPolicyRequest
    
    if (!body) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      )
    }
    
    const { 
      tenantId, 
      appId, 
      clientSecret,
      storageAccountName,
      action,
      policyId,
      policyType,
      backupPath,
      originalName
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName || !action || !policyId || !policyType || !backupPath) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }

    if (action !== 'restore' && action !== 'revert') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
    if (!isGraphId(policyId)) {
      return NextResponse.json({ error: 'Invalid policy ID' }, { status: 400 })
    }
    if (!validPolicyPath(backupPath, backupPath.split('/')[0] ?? '')) {
      return NextResponse.json({ error: 'Invalid policy backup path' }, { status: 400 })
    }

    // Get access tokens for both Azure Storage and Microsoft Graph
    const [storageToken, graphToken] = await Promise.all([
      getAccessToken(tenantId, appId, clientSecret, "https://storage.azure.com/.default"),
      getAccessToken(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default")
    ])

    // A shared container can hold other tenants' backups; never restore from one of those.
    const owned = await readOwnedBackup((name) => fetch(`https://${storageAccountName}.blob.core.windows.net/intune-backups/${name.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { 'x-ms-version': '2021-12-02', 'Authorization': `Bearer ${storageToken}` },
    }), backupPath.split('/')[0] ?? '', tenantId)
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })

    // Fetch the policy content from the backup
    const policyUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups/${backupPath.split("/").map(encodeURIComponent).join("/")}`
    console.log("Attempting to fetch policy from:", policyUrl)
    
    const backupResponse = await fetch(policyUrl, {
      headers: {
        'x-ms-version': '2021-12-02',
        'Authorization': `Bearer ${storageToken}`,
      },
    })

    if (!backupResponse.ok) {
      const errorText = await backupResponse.text()
      console.error("Failed to fetch policy from backup:", {
        status: backupResponse.status,
        statusText: backupResponse.statusText,
        error: errorText,
        url: policyUrl
      })
      
      // Provide more specific error messages
      if (backupResponse.status === 404) {
        return NextResponse.json(
          { error: "Policy backup file not found" },
          { status: 404 }
        )
      }
      
      if (backupResponse.status === 403 || errorText.includes("AuthorizationPermissionMismatch")) {
        return NextResponse.json(
          { error: "Storage access denied. Please check app permissions." },
          { status: 403 }
        )
      }
      
      return NextResponse.json(
        { error: `Failed to fetch policy from backup: ${backupResponse.statusText}` },
        { status: 500 }
      )
    }

    if (action === "revert" && backupResponse.headers.get("x-tenuvault-authenticated") !== "true") throw new Error("Unverified legacy snapshots cannot revert live policies. Review and restore a copy instead.")
    const policyContent = await backupResponse.json()
    if (action === "revert" && policyContent.id !== policyId) throw new Error("The authenticated snapshot does not belong to the selected policy")
    
    // Restore creates an unassigned copy; revert puts the existing policy back to the backed-up version.
    const outcome = await new Restorer(graphCaller(graphToken, fetch, { tenant: tenantId, refreshToken: () => getAccessToken(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default", true) }), { mode: action === 'revert' ? 'replace' : 'copy', assignments: false })
      .restore(backupPath, policyContent)
    const result = { success: outcome.success, error: outcome.error, policyId: outcome.policyId }

    if (!result.success) {
      // Write failed metadata
      await writeRevertMetadata(
        storageAccountName,
        storageToken,
        policyId,
        {
          timestamp: new Date().toISOString(),
          action,
          fromBackup: body.fromBackup || backupPath,
          toBackup: body.toBackup,
          policyName: originalName || policyContent.displayName,
          policyType,
          status: "failed",
          errorMessage: result.error
        }
      )
      
      return NextResponse.json(
        { error: result.error || "Failed to apply policy changes", policyId: outcome.policyId, partial: outcome.partial, retryable: false },
        { status: 500 }
      )
    }

    // Write success metadata
    const metadata: RevertMetadata = {
      timestamp: new Date().toISOString(),
      action,
      fromBackup: body.fromBackup || backupPath,
      toBackup: body.toBackup,
      policyName: originalName || policyContent.displayName,
      policyType,
      status: "success"
    }
    
    if (body.action === "revert" && body.changes) {
      metadata.changesReverted = body.changes.map(change => ({
        field: change.field,
        oldValue: change.newValue, // The "new" value is what we're reverting FROM
        revertedTo: change.oldValue // The "old" value is what we're reverting TO
      }))
    }
    
    if (action === "restore") {
      metadata.newPolicyId = result.policyId
    }
    
    await writeRevertMetadata(storageAccountName, storageToken, policyId, metadata)

    return NextResponse.json({
      success: true,
      message: action === 'revert' ? "The policy was put back to the backed-up version." : "Created an unassigned restored copy. The original policy is unchanged.",
      policyId: result.policyId
    })

  } catch (error) {
    console.error("Revert policy error:", error)
    
    return NextResponse.json(
      { error: "Internal server error while reverting policy" },
      { status: 500 }
    )
  }
}

async function getAccessToken(tenantId: string, appId: string, clientSecret: string, scope: string, forceRefresh = false): Promise<string> {
  const tokenResponse = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: clientSecret,
        scope,
        force_refresh: String(forceRefresh), grant_type: "client_credentials",
      }),
    }
  )

  if (!tokenResponse.ok) {
    throw new Error("Failed to authenticate")
  }

  const tokenData = await tokenResponse.json()
  return tokenData.access_token
}

async function writeRevertMetadata(
  storageAccountName: string,
  accessToken: string,
  policyId: string,
  metadata: RevertMetadata
): Promise<void> {
  const metadataPath = "metadata/revert-history.json"
  const metadataUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups/${metadataPath}`
  
  try {
    // First, try to fetch existing metadata
    const getResponse = await fetch(metadataUrl, {
      headers: {
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'Authorization': `Bearer ${accessToken}`,
      },
    })
    
    let existingData: { reverts: { [key: string]: RevertMetadata[] } } = { reverts: {} }
    
    if (getResponse.ok) {
      try {
        existingData = await getResponse.json()
      } catch {
        console.log("No existing metadata or invalid JSON, creating new")
      }
    }
    
    // Ensure structure exists
    if (!existingData.reverts) {
      existingData.reverts = {}
    }
    
    // Add new metadata entry
    if (!existingData.reverts[policyId]) {
      existingData.reverts[policyId] = []
    }
    
    existingData.reverts[policyId].push(metadata)
    
    // Write back to storage
    const putResponse = await fetch(metadataUrl, {
      method: 'PUT',
      headers: {
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'Authorization': `Bearer ${accessToken}`,
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': 'application/json',
        'x-ms-blob-content-type': 'application/json'
      },
      body: JSON.stringify(existingData, null, 2),
    })
    
    if (!putResponse.ok) {
      const errorBody = await putResponse.text()
      console.error("Failed to write revert metadata:", putResponse.status, putResponse.statusText, errorBody)
      
      // If it's a permission error, try to store locally or in a different way
      if (putResponse.status === 403) {
        console.warn("No write permission for metadata. The revert was successful but metadata tracking is unavailable.")
        console.log("To enable metadata tracking, ensure the service principal has 'Storage Blob Data Contributor' role on the storage account.")
        
        // Optional: Store metadata in local storage or session storage as fallback
        // This would only work for the current session but better than nothing
        if (typeof window !== 'undefined' && window.localStorage) {
          try {
            const localMetadata = JSON.parse(localStorage.getItem('revert-metadata') || '{}')
            if (!localMetadata[policyId]) localMetadata[policyId] = []
            localMetadata[policyId].push(metadata)
            localStorage.setItem('revert-metadata', JSON.stringify(localMetadata))
            console.log("Stored revert metadata locally as fallback")
          } catch (e) {
            console.error("Failed to store metadata locally:", e)
          }
        }
      }
    } else {
      console.log("Successfully wrote revert metadata for policy:", policyId)
    }
  } catch (error) {
    console.error("Error writing revert metadata:", error)
    // Don't throw - we don't want metadata writing to fail the entire operation
  }
}