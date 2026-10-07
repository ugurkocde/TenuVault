import { BlobListError, decodeXml, listBlobPages } from "~/lib/storage/list"
import { typeForFolder } from "../../../../shared/intune/registry"
import { describeScope } from "../../../../shared/intune/scope"
import { comparable, compareBackups, summarize, type BackupFingerprint, type ChangeSummary } from "../../../../shared/intune/backup-changes"
import { blobPath } from "../../../../shared/security"
import { mapLimit } from "~/lib/map-limit"
import { type NextRequest, NextResponse } from "next/server"

// Helper function to format bytes to human readable format
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 KB'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

const storageHeaders = (token: string) => ({ 'x-ms-version': '2021-12-02', 'x-ms-date': new Date().toUTCString(), Authorization: `Bearer ${token}` })

/** One backup-yyyy-MM-dd-HHmmss folder, from its metadata.json and its file listing. */
async function describeBackup(storageAccountName: string, name: string, accessToken: string) {
  const legacy = /^\d{4}-\d{2}-\d{2}$/.test(name)
  const date = legacy ? name : name.slice(7, 17)
  const time = legacy ? "" : name.slice(18)
  let metadata: any = null
  let metadataError: string | undefined
  try {
    const response = await fetch(`https://${storageAccountName}.blob.core.windows.net/intune-backups/${blobPath(name)}/metadata.json`, { headers: storageHeaders(accessToken) })
    if (response.ok) {
      metadata = await response.json()
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid metadata')
    } else if (response.status !== 404) metadataError = `Backup metadata is unavailable (${response.status}).`
  } catch {
    metadata = null
    metadataError = 'Backup metadata could not be read or parsed.'
  }
  const recordedTimestamp = metadata?.timestamp ?? metadata?.Timestamp ?? metadata?.BackupDate
  const timestamp = legacy
    ? typeof recordedTimestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(recordedTimestamp) && Number.isFinite(Date.parse(recordedTimestamp)) ? recordedTimestamp : date
    : `${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`

  let size = 0
  let files = 0
  const counts: Record<string, number> = {}
  const filesText = await listBlobPages(`https://${storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=${encodeURIComponent(`${name}/`)}`, accessToken).catch(() => { throw new Error(`Backup ${name} inventory is unavailable. Check storage access and retry.`) })
  for (const match of filesText.matchAll(/<Blob>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<Content-Length>(\d+)<\/Content-Length>[\s\S]*?<\/Blob>/g)) {
    const parts = decodeXml(match[1] ?? '').split('/')
    size += parseInt(match[2]!)
    files++
    // Backups from older app versions stored compliance policies under this name.
    const type = parts.length === 3 ? typeForFolder(parts[1] === 'DeviceCompliancePolicies' ? 'CompliancePolicies' : parts[1]!) : undefined
    const folder = type?.folder ?? (parts.length === 3 && ['AppProtectionPolicies', 'ConditionalAccess'].includes(parts[1]!) ? parts[1] : undefined)
    if (folder) counts[folder] = (counts[folder] ?? 0) + 1
  }
  const count = (...folders: string[]) => folders.reduce((sum, folder) => sum + (counts[folder] ?? 0), 0)
  const totalPolicies = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const excluded: string[] = Array.isArray(metadata?.Scope?.Excluded) ? metadata.Scope.Excluded : []

  return {
    id: name,
    name,
    timestamp,
    timestampPrecision: timestamp === date ? "day" : "second",
    lastModified: timestamp,
    folder: `${name}/`,
    // Backups made before the trigger was recorded do not say how they started.
    type: typeof metadata?.Trigger === 'string' ? metadata.Trigger : typeof metadata?.trigger === 'string' ? metadata.trigger : null,
    // metadata.json is written last. Without it the backup is still running, or it stopped (for example
    // when the app quit) and holds only part of the tenant.
    status: metadataError ? 'unknown' : metadata ? String(metadata.Status ?? metadata.status ?? 'unknown') : legacy ? 'unknown' : Date.now() - Date.parse(timestamp) < 6 * 3600_000 ? 'running' : 'incomplete',
    configs: files,
    policyCount: totalPolicies,
    totalPolicies,
    counts,
    // Kept for the dashboard's breakdown.
    policies: {
      deviceConfigurations: count('DeviceConfigurations'),
      compliancePolicies: count('CompliancePolicies', 'ComplianceSettingsPolicies'),
      configurationPolicies: count('ConfigurationPolicies', 'GroupPolicyConfigurations'),
      appProtectionPolicies: count('AppProtectionIOS', 'AppProtectionAndroid', 'AppProtectionWindows', 'AppProtectionPolicies'),
      conditionalAccess: count('ConditionalAccess'),
    },
    scope: metadata ? { excluded, description: describeScope({ excluded }) } : null,
    failures: typeof metadata?.Failures === 'number' ? metadata.Failures : 0,
    skippedTypes: Array.isArray(metadata?.SkippedTypes) ? metadata.SkippedTypes : [],
    failedTypes: Array.isArray(metadata?.FailedTypes) ? metadata.FailedTypes : [],
    size,
    sizeFormatted: formatBytes(size),
    duration: typeof metadata?.DurationSeconds === 'number' ? metadata.DurationSeconds : metadata?.Duration ?? metadata?.duration ?? null,
    changes: null as ChangeSummary | null,
    comparedWith: null as string | null,
    fingerprint: metadata as BackupFingerprint | null | undefined,
    error: metadataError,
    warning: undefined,
    runbookVersion: metadata?.RunbookVersion ?? metadata?.runbookVersion ?? null,
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { 
      tenantId, 
      appId, 
      clientSecret,
      subscriptionId,
      resourceGroupName,
      storageAccountName
    } = body

    if (!tenantId || !appId || !clientSecret || !subscriptionId || !resourceGroupName || !storageAccountName) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }

    // Get access token for Azure Storage data plane operations
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
          scope: "https://storage.azure.com/.default",
          grant_type: "client_credentials",
        }),
      }
    )

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text()
      console.error("Azure auth error:", errorData)
      return NextResponse.json(
        { error: "Failed to authenticate with Azure", details: errorData },
        { status: 401 }
      )
    }

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token


    // Skip container listing and go directly to listing blobs in intune-backups
    // This avoids needing account-level permissions

    // List blobs in the intune-backups container
    const blobsUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=&delimiter=/`

    let blobsText: string
    try {
      blobsText = await listBlobPages(blobsUrl, accessToken)
    } catch (error) {
      if (!(error instanceof BlobListError)) throw error
      console.error("Failed to list blobs:", error.body)

      // If container doesn't exist, return empty
      if (error.status === 404) {
        return NextResponse.json({ backups: [] })
      }

      // AuthorizationFailure is the storage firewall rejecting this network, not a missing role
      if (error.body.includes("<Code>AuthorizationFailure</Code>")) {
        return NextResponse.json({
          error: "Storage network access denied",
          details: `Storage account ${storageAccountName} rejected the request from this network. Allow this computer's public IP address in the storage account's networking settings, or connect through a network it allows.`,
          backups: []
        }, { status: 403 })
      }

      // If authorization error, provide helpful message
      if (error.body.includes("AuthorizationPermissionMismatch")) {
        return NextResponse.json({ 
          error: "Missing storage permissions",
          details: `Your account cannot read backups in storage account ${storageAccountName}. Ask an Azure administrator for the "Storage Blob Data Contributor" role on it. New role assignments can take a few minutes to apply.`,
          backups: []
        }, { status: 403 })
      }

      return NextResponse.json({ error: "Backup storage is unavailable. Check storage access and retry." }, { status: error.status })
    }
    
    // Parse XML response to extract backup folders
    const backupFolders = extractBackupFolders(blobsText)
    
    // Get details for each backup folder
    const backups: any[] = []
    
    // A container can be shared by several tenants. Backups recorded as another tenant's are left
    // out; older backups that do not record a tenant are still listed.
    const described = await mapLimit(backupFolders, 6, (name) => describeBackup(storageAccountName, name, accessToken))
    backups.push(...described.filter((backup) => {
      const owner = (backup.fingerprint as { TenantId?: unknown } | null | undefined)?.TenantId
      return typeof owner !== 'string' || owner.toLowerCase() === String(tenantId).toLowerCase()
    }))

    // Sort by timestamp descending
    backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    
    // Each backup is compared with the newest older backup that can be compared.
    for (let i = 0; i < backups.length; i++) {
      const current = backups[i]!
      if (!current.fingerprint || !comparable(current.fingerprint)) continue
      const previous = backups.slice(i + 1).find((backup) => backup.fingerprint && comparable(backup.fingerprint))
      if (!previous) continue
      current.changes = summarize(compareBackups(previous.fingerprint, current.fingerprint))
      current.comparedWith = previous.id
    }
    for (const backup of backups) delete backup.fingerprint

    return NextResponse.json({ backups })
  } catch (error) {
    console.error("List backups error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error while listing backups" },
      { status: 500 }
    )
  }
}


function extractBackupFolders(xmlText: string): string[] {
  const names = [...xmlText.matchAll(/<Name>((?:backup-\d{4}-\d{2}-\d{2}-\d{6}|\d{4}-\d{2}-\d{2}))\/?<\/Name>/g)]
    .map((match) => match[1]!)
  return [...new Set(names)]
}
