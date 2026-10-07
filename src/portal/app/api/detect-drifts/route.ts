import { decodeXml, listBlobPages } from "~/lib/storage/list"
import { typeForFolder } from "../../../../shared/intune/registry"
import { withoutUnreadAssignments } from "../../../../shared/intune/read"
import { coveredFolders, type ScopeMetadata } from "../../../../shared/intune/scope"
import { itemsOf, sameItem, type BackupFingerprint, type BackupItems } from "../../../../shared/intune/backup-changes"
import { backupRef, DriftPairError, selectBackupPair, summarizeDrifts, type BackupMetadata, type Drift, type DriftResult, type DriftScanProgress, type DriftWarning, type SelectedBackup } from "../../../../shared/intune/drift"
import { CANCELLED_HEADER, driftScanHooks, type DriftScanHooks } from "~/lib/drift/scan-hooks"
import { mapLimit } from "~/lib/map-limit"
import { type NextRequest, NextResponse } from "next/server"

interface PolicyFile {
  name: string
  url: string
  lastModified: string
  size: number
}

interface PolicyContent {
  id: string
  displayName: string
  lastModifiedDateTime?: string
  createdDateTime?: string
  [key: string]: any
}

export async function POST(request: NextRequest) {
  let hooks: DriftScanHooks | undefined
  try {
    const body = await request.json()
    const { 
      tenantId, 
      appId, 
      clientSecret,
      storageAccountName,
      backupLimit,
      baseline,
      comparison,
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }

    // A background scan (see ~/lib/drift/scan-hooks) follows the progress and can cancel it.
    hooks = driftScanHooks(body.scanId, tenantId)
    const signal = hooks?.signal
    const report = (progress: DriftScanProgress) => hooks?.onProgress(progress)
    report({ phase: "checking", detail: "Checking the backups", done: 0, total: 0 })

    // Get access token for Azure Storage
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
      return NextResponse.json(
        { error: "Failed to authenticate with Azure" },
        { status: 401 }
      )
    }

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token
    signal?.throwIfAborted()

    // Using delimiter=/ to get folder prefixes instead of all blobs
    const listUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&delimiter=/`
    const listText = await listBlobPages(listUrl, accessToken)
    const backupFolders = parseBackupFolders(listText)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    // Incomplete snapshots are missing policies and would report them as deleted, and a running
    // backup has no metadata yet, so the default pair skips both (see selectBackupPair).
    const loadMetadata = async (name: string): Promise<BackupMetadata | null> => {
      const response = await fetch(`https://${storageAccountName}.blob.core.windows.net/intune-backups/${encodeURIComponent(name)}/metadata.json`, { headers: { 'x-ms-version': '2021-12-02', Authorization: `Bearer ${accessToken}` }, signal })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Cannot verify that the backups are complete (${response.status}). Check storage access and retry.`)
      return await response.json()
    }
    const pair = await selectBackupPair({ folders: backupFolders, tenantId, baseline, comparison, limit: typeof backupLimit === "number" && backupLimit > 0 ? backupLimit : undefined, load: loadMetadata, signal })
    const newerBackup = pair.comparison
    const olderBackup = pair.baseline

    // Only types both backups hold are compared: a backup that left apps out has not seen them deleted.
    report({ phase: "listing", detail: "Listing the backed-up policies", done: 0, total: 0 })
    const olderFolders = coveredFolders(olderBackup.metadata as ScopeMetadata)
    const shared = [...coveredFolders(newerBackup.metadata as ScopeMetadata)].filter(folder => olderFolders.has(folder))
    const [newerPolicies, olderPolicies] = await Promise.all([
      fetchPolicyFiles(storageAccountName, newerBackup.name, accessToken, shared, signal),
      fetchPolicyFiles(storageAccountName, olderBackup.name, accessToken, shared, signal)
    ])
    
    const { drifts, warnings, stats } = await detectDrifts(newerPolicies, olderPolicies, newerBackup, olderBackup, accessToken, { signal, report, folders: new Set(shared) })
    signal?.throwIfAborted()
    
    // Fetch revert metadata for all drift policy IDs
    const policyIds = drifts.map(d => d.configId).filter(id => id)
    if (policyIds.length > 0) {
      report({ phase: "history", detail: "Checking the revert history", done: stats.compared, total: stats.compared })
      try {
        const metadataResponse = await fetch(
          `${request.nextUrl.origin}/api/revert-metadata`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              tenantId,
              appId,
              clientSecret,
              storageAccountName,
              policyIds
            }),
          }
        )
        
        if (metadataResponse.ok) {
          const metadataData = await metadataResponse.json()
          
          // Add revert history to drifts and check for revert drifts
          drifts.forEach(drift => {
            const revertHistory = metadataData.reverts?.[drift.configId]
            if (revertHistory && revertHistory.length > 0) {
              // Filter to only successful reverts
              const successfulReverts = revertHistory
                .filter((r: any) => r.status === "success" && r.action === "revert")
              
              if (successfulReverts.length > 0) {
                // Add revert history
                drift.revertHistory = successfulReverts.map((r: any) => ({
                  timestamp: r.timestamp,
                  action: r.action
                }))
                drift.lastRevertedAt = successfulReverts[successfulReverts.length - 1].timestamp
                
                // Check if this drift is the result of a recent revert
                const recentReverts = successfulReverts.filter((r: any) => {
                  const revertTime = new Date(r.timestamp).getTime()
                  const fromBackupTime = new Date(drift.fromBackupTimestamp ?? "").getTime()
                  const toBackupTime = new Date(drift.toBackupTimestamp ?? "").getTime()
                  
                  // Revert happened between the two backups being compared
                  return revertTime > fromBackupTime && revertTime < toBackupTime
                })
                
                if (recentReverts.length > 0 && drift.changeType === "modified") {
                  const mostRecentRevert = recentReverts[recentReverts.length - 1]
                  
                  // Check if the changes match a revert
                  if (mostRecentRevert.changesReverted && checkIfRevertDrift(drift.changes, mostRecentRevert.changesReverted)) {
                    drift.isRevertDrift = true
                    drift.revertTimestamp = mostRecentRevert.timestamp
                  }
                }
              }
            }
          })
        }
      } catch (error) {
        console.error("Failed to fetch revert metadata:", error)
        // Continue without metadata - don't fail the whole operation
      }
    }
    signal?.throwIfAborted()

    const result: DriftResult = {
      drifts,
      summary: summarizeDrifts(drifts),
      lastScan: new Date().toISOString(),
      backupsAnalyzed: 2,
      baseline: backupRef(olderBackup),
      comparison: backupRef(newerBackup),
      warnings,
      stats,
    }
    return NextResponse.json(result)
  } catch (error) {
    // The header tells the audit recorder that the admin stopped the scan; it did not fail.
    if (hooks?.signal.aborted) return NextResponse.json({ error: "The drift scan was cancelled.", code: "CANCELLED" }, { status: 409, headers: { [CANCELLED_HEADER]: "1" } })
    if (error instanceof DriftPairError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    console.error("Detect drifts error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error while detecting drifts" },
      { status: 500 }
    )
  }
}

export function parseBackupFolders(xmlText: string): { name: string; timestamp: string }[] {
  const folders: { name: string; timestamp: string }[] = []
  const blobPrefixes = xmlText.match(/<BlobPrefix>[\s\S]*?<\/BlobPrefix>/g) || []
  
  for (const prefix of blobPrefixes) {
    const nameMatch = prefix.match(/<Name>([^<]+)<\/Name>/)
    if (nameMatch?.[1]) {
      const name = nameMatch[1].replace(/\/$/, '')
      
      // Try different parsing formats
      // Format 1: backup-2024-08-01-020200 (from list-backups API)
      // Format 2: 2024-08-01_02-02-00_1234567890123
      // Format 3: 2024-08-01_02-02-00
      
      // Check for backup- prefix format
      if (name.startsWith('backup-')) {
        const dateMatch = /backup-(\d{4}-\d{2}-\d{2})-(\d{6})/.exec(name)
        if (dateMatch) {
          const [, dateStr, timeStr] = dateMatch
          const formattedTime = timeStr!.replace(/(\d{2})(\d{2})(\d{2})/, '$1:$2:$3')
          try {
            const timestamp = new Date(`${dateStr}T${formattedTime}Z`).toISOString()
            folders.push({ name, timestamp })
            console.log("Parsed backup folder (backup- format):", { name, timestamp })
          } catch (e) {
            console.error("Failed to parse date for folder:", name, e)
          }
        }
      } else {
        // Try underscore format
        const parts = name.split('_')
        if (parts.length >= 2) {
          const dateStr = parts[0]
          const timeStr = parts[1]?.replace(/-/g, ':')
          if (dateStr && timeStr) {
            try {
              const timestamp = new Date(`${dateStr}T${timeStr}Z`).toISOString()
              folders.push({ name, timestamp })
              console.log("Parsed backup folder (underscore format):", { name, timestamp })
            } catch (e) {
              console.error("Failed to parse date for folder:", name, e)
            }
          }
        }
      }
    }
  }
  
  console.log("Total folders parsed:", folders.length)
  return folders
}

async function fetchPolicyFiles(
  storageAccountName: string,
  backupFolder: string,
  accessToken: string,
  folders: string[],
  signal?: AbortSignal
): Promise<PolicyFile[]> {
  const policies: PolicyFile[] = []
  
  // The compared types, plus the folder older backups used for compliance policies.
  const policyTypes = folders.includes('CompliancePolicies') ? [...folders, 'DeviceCompliancePolicies'] : folders
  
  for (const policyType of policyTypes) {
    signal?.throwIfAborted()
    const listUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=${encodeURIComponent(`${backupFolder}/${policyType}/`)}`
    
    {
      const text = await listBlobPages(listUrl, accessToken)
      const blobs = text.match(/<Blob>[\s\S]*?<\/Blob>/g) || []
      
      for (const blob of blobs) {
        const nameMatch = blob.match(/<Name>([^<]+)<\/Name>/)
        const lastModifiedMatch = blob.match(/<Last-Modified>([^<]+)<\/Last-Modified>/)
        const sizeMatch = blob.match(/<Content-Length>([^<]+)<\/Content-Length>/)
        
        if (nameMatch?.[1] && nameMatch[1].endsWith('.json')) {
          policies.push({
            name: decodeXml(nameMatch[1]),
            url: `https://${storageAccountName}.blob.core.windows.net/intune-backups/${decodeXml(nameMatch[1]).split("/").map(encodeURIComponent).join("/")}`,
            lastModified: lastModifiedMatch?.[1] || '',
            size: parseInt(sizeMatch?.[1] || '0')
          })
        }
      }
    }
  }
  
  return policies
}

/** "<type folder>/<Intune ID>" to the item's file path (Type/Name.json) and fingerprint, from a backup's metadata.json Items. */
function itemsByIdentity(metadata: BackupMetadata): Map<string, { path: string; item: BackupItems[string] }> | null {
  const items = itemsOf(metadata as BackupFingerprint)
  if (!items) return null
  const entries = new Map<string, { path: string; item: BackupItems[string] }>()
  for (const [key, item] of Object.entries(items)) {
    if (item && typeof item.file === 'string' && typeof item.hash === 'string') entries.set(key, { path: `${key.slice(0, key.indexOf('/'))}/${item.file}`, item })
  }
  return entries
}

/** Policy files read at once. */
const READ_CONCURRENCY = 8

/**
 * Added, changed and deleted items between the two backups. Items whose stored fingerprints
 * match in both backups are unchanged and not read; backups without fingerprints (made by older
 * versions) are compared file by file. The rest are read a few at a time. A file that cannot be
 * read is reported as a warning and left out, rather than failing the whole comparison.
 *
 * For backups with Items, the counts match the backup list's changes (compareBackups) for the same
 * pair, except where drift deliberately reports less: new "[Restored]" copies are left out, and an
 * item whose fingerprint changed only in properties compareObjects ignores (such as description or
 * @odata.type) is not reported as modified.
 */
async function detectDrifts(
  newerPolicies: PolicyFile[],
  olderPolicies: PolicyFile[],
  newerBackup: SelectedBackup,
  olderBackup: SelectedBackup,
  accessToken: string,
  options: { signal?: AbortSignal; report: (progress: DriftScanProgress) => void; /** The type folders both backups cover. */ folders: Set<string> }
): Promise<{ drifts: Drift[]; warnings: DriftWarning[]; stats: DriftResult["stats"] }> {
  const { signal, report } = options
  const detectedAt = new Date().toISOString()
  const warnings: DriftWarning[] = []
  
  // Remove the backup folder prefix to compare just the policy path
  const relative = (p: PolicyFile) => p.name.substring(p.name.indexOf('/') + 1)
  const newerMap = new Map(newerPolicies.map(p => [relative(p), p]))
  const olderMap = new Map(olderPolicies.map(p => [relative(p), p]))

  // Items are matched by their Intune ID, as compareBackups (the backup list) does, so a renamed
  // policy is one modified item rather than a deleted and an added file. Backups made before
  // metadata recorded Items, and any file Items does not name, are matched by file path.
  type Task = { name: string; change: Drift["changeType"]; newer?: PolicyFile; older?: PolicyFile }
  const tasks: Task[] = []
  const pairedNewer = new Set<string>()
  const pairedOlder = new Set<string>()
  let unchanged = 0
  const newerItems = itemsByIdentity(newerBackup.metadata)
  const olderItems = itemsByIdentity(olderBackup.metadata)
  if (newerItems && olderItems) {
    // A file metadata names but storage does not hold cannot be compared; reported rather than
    // shown as the item being added or deleted.
    const missing = (path: string, backup: string) => warnings.push({ file: path, backup, message: 'Could not be compared: the file is missing from the backup.' })
    const compared = (path: string) => options.folders.has(path.slice(0, path.indexOf('/')))
    for (const [key, after] of newerItems) {
      const before = olderItems.get(key)
      const newer = newerMap.get(after.path)
      if (!newer) {
        if (!compared(after.path)) continue
        missing(after.path, newerBackup.name)
        if (before) pairedOlder.add(before.path)
        continue
      }
      pairedNewer.add(after.path)
      if (before && !olderMap.has(before.path) && compared(before.path)) { missing(before.path, olderBackup.name); continue }
      const older = before && !pairedOlder.has(before.path) ? olderMap.get(before.path) : undefined
      if (!before || !older) { tasks.push({ name: after.path, change: 'added', newer }); continue }
      pairedOlder.add(before.path)
      // The same assignment handling as compareBackups: reading assignments now that an older version could not is no change.
      if (sameItem(before.item, after.item)) { unchanged++; continue }
      // Named by the baseline file: reverting a modified item restores it from the baseline backup.
      tasks.push({ name: before.path, change: 'modified', newer, older })
    }
    for (const [key, before] of olderItems) {
      const older = olderMap.get(before.path)
      if (!older || pairedOlder.has(before.path) || newerItems.has(key)) continue
      pairedOlder.add(before.path)
      tasks.push({ name: before.path, change: 'deleted', older })
    }
  }
  for (const [name, newer] of newerMap) {
    if (pairedNewer.has(name)) continue
    const older = pairedOlder.has(name) ? undefined : olderMap.get(name)
    if (!older) { tasks.push({ name, change: 'added', newer }); continue }
    pairedOlder.add(name)
    tasks.push({ name, change: 'modified', newer, older })
  }
  for (const [name, older] of olderMap) if (!pairedOlder.has(name)) tasks.push({ name, change: 'deleted', older })

  const base = {
    tenant: "Current Tenant",
    tenantId: "current-tenant",
    detectedAt,
    fromBackup: olderBackup.name,
    toBackup: newerBackup.name,
    fromBackupTimestamp: olderBackup.timestamp,
    toBackupTimestamp: newerBackup.timestamp,
    affectedPolicies: 1,
    affectedDevices: 0,
    comparisonIndex: 0,
  }
  const fallbackName = (name: string) => name.split('/').pop()?.replace('.json', '') || 'Unknown'

  let done = 0
  const progress = () => report({ phase: "comparing", detail: `Comparing policies: ${done} of ${tasks.length}`, done, total: tasks.length })
  progress()

  const results = await mapLimit(tasks, READ_CONCURRENCY, async (task): Promise<Omit<Drift, 'id'> | null> => {
    // Checked before every read, so a cancelled scan reads nothing further.
    signal?.throwIfAborted()
    const read = async (file: PolicyFile, backup: string): Promise<PolicyContent | null> => {
      try {
        return await fetchPolicyContent(file.url, accessToken, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        warnings.push({ file: task.name, backup, message: error instanceof Error ? error.message : 'The file could not be read.' })
        return null
      }
    }
    try {
      const policyType = getPolicyType(task.name)
      if (task.change === 'added') {
        const policyContent = await read(task.newer!, newerBackup.name)
        // Skip policies that were restored by the user (those with [Restored] prefix)
        if ([policyContent?.displayName, policyContent?.name].some(name => typeof name === 'string' && name.startsWith('[Restored]'))) return null
        return {
          ...base,
          severity: determineSeverity(policyType, "added", policyContent),
          type: policyType,
          configName: policyContent?.displayName || policyContent?.name || fallbackName(task.name),
          backupFile: task.name,
          configId: policyContent?.id || '',
          changeType: "added",
          description: `New ${policyType} policy added`,
          impact: determineImpact(policyType, "added", policyContent),
        }
      }
      if (task.change === 'deleted') {
        const policyContent = await read(task.older!, olderBackup.name)
        return {
          ...base,
          severity: determineSeverity(policyType, "deleted", policyContent),
          type: policyType,
          configName: policyContent?.displayName || policyContent?.name || fallbackName(task.name),
          backupFile: task.name,
          configId: policyContent?.id || '',
          changeType: "deleted",
          description: `${policyType} policy deleted`,
          impact: determineImpact(policyType, "deleted", policyContent),
        }
      }
      const [newerContent, olderContent] = await Promise.all([read(task.newer!, newerBackup.name), read(task.older!, olderBackup.name)])
      // Without both versions there is nothing to compare; the warning says which file is missing.
      if (!newerContent || !olderContent) return null
      const changes = compareObjects(...withoutUnreadAssignments(typeOfFile(task.name), olderContent, newerContent))
      if (changes.length === 0) return null
      const previousName = olderContent?.displayName || olderContent?.name
      return {
        ...base,
        severity: determineSeverity(policyType, "modified", newerContent, changes),
        type: policyType,
        configName: newerContent?.displayName || newerContent?.name || fallbackName(task.name),
        ...(previousName && previousName !== (newerContent?.displayName || newerContent?.name) ? { previousName } : {}),
        backupFile: task.name,
        configId: newerContent?.id || '',
        changeType: "modified",
        description: generateChangeDescription(policyType, changes),
        impact: determineImpact(policyType, "modified", newerContent, changes),
        changes,
      }
    } finally {
      done++
      progress()
    }
  })

  let driftIdCounter = Date.now()
  const drifts = results.filter((drift): drift is Omit<Drift, 'id'> => drift !== null).map(drift => ({ id: `drift-${driftIdCounter++}`, ...drift }))
  return { drifts, warnings, stats: { compared: tasks.length, unchanged } }
}

async function fetchPolicyContent(url: string, accessToken: string, signal?: AbortSignal): Promise<PolicyContent> {
  const response = await fetch(url, { headers: { 'x-ms-version': '2021-12-02', Authorization: `Bearer ${accessToken}` }, signal })
  if (!response.ok) throw new Error(`The file could not be read (${response.status}).`)
  return await response.json()
}

/** The drift page maps these three labels back to their backup folders. */
const LEGACY_LABELS: Record<string, string> = {
  DeviceConfigurations: 'Device Configuration',
  CompliancePolicies: 'Compliance Policy',
  DeviceCompliancePolicies: 'Compliance Policy',
  ConfigurationPolicies: 'Configuration Policy',
}

/** The type folder holds the file, with or without the backup folder in front of it. */
function folderOf(fileName: string): string {
  const parts = fileName.split('/')
  return parts[parts.length - 2] ?? ''
}

function typeOfFile(fileName: string) {
  const folder = folderOf(fileName)
  return typeForFolder(folder === 'DeviceCompliancePolicies' ? 'CompliancePolicies' : folder)
}

function getPolicyType(fileName: string): string {
  const folder = folderOf(fileName)
  const label = LEGACY_LABELS[folder] ?? typeForFolder(folder)?.label
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Unknown Policy'
}

/** Stable identity for each array item, or null when the items cannot be matched reliably. */
function arrayItemKeys(items: any[], path: string): string[] | null {
  const keys = items.map((item): string | undefined => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item)
    if (path.endsWith('omaSettings')) return item.displayName || item.omaUri
    return item.settingInstance?.settingDefinitionId ?? item.settingDefinitionId
  })
  if (keys.some(key => typeof key !== 'string') || new Set(keys).size !== keys.length) return null
  return keys as string[]
}

export function compareObjects(
  oldObj: any,
  newObj: any,
  path: string = '',
  context: any = { parent: null, arrayIndex: null }
): { field: string; oldValue: any; newValue: any; displayName?: string }[] {
  const changes: { field: string; oldValue: any; newValue: any; displayName?: string }[] = []

  if (oldObj === null || newObj === null || typeof oldObj !== 'object' || typeof newObj !== 'object') {
    return JSON.stringify(oldObj) === JSON.stringify(newObj) ? [] : [{ field: path, oldValue: oldObj, newValue: newObj }]
  }

  // Skip metadata fields and fields that should not be considered as drifts
  const skipFields = [
    '@odata.context', 
    '@odata.type', 
    'lastModifiedDateTime', 
    'createdDateTime',
    'modifiedDateTime',  // Changes on every write, like lastModifiedDateTime; backup fingerprints leave it out too
    'id',  // ID changes when policy is recreated
    'version',  // Version auto-increments
    'description',  // Description contains our revert notices
    'settings@odata.context',  // Contains policy ID in URL
    'secretReferenceValueId'  // Regenerated by Intune on every write of an encrypted OMA-URI value
  ]
  
  if (Array.isArray(oldObj) && Array.isArray(newObj)) {
    // Match items by a stable key when every item has a unique one, so an added, removed or
    // reordered setting is reported as itself instead of shifting every later index.
    const oldKeys = arrayItemKeys(oldObj, path)
    const newKeys = arrayItemKeys(newObj, path)
    if (oldKeys && newKeys) {
      const newMap = new Map(newKeys.map((key, i) => [key, newObj[i]]))
      const oldSet = new Set(oldKeys)
      oldKeys.forEach((key, i) => {
        const itemPath = `${path}[${key}]`
        if (newMap.has(key)) changes.push(...compareObjects(oldObj[i], newMap.get(key), itemPath, { parent: oldObj[i], arrayIndex: key }))
        else changes.push({ field: itemPath, oldValue: oldObj[i], newValue: undefined })
      })
      newKeys.forEach((key, i) => {
        if (!oldSet.has(key)) changes.push({ field: `${path}[${key}]`, oldValue: undefined, newValue: newObj[i] })
      })
    } else {
      const maxLength = Math.max(oldObj.length, newObj.length)
      for (let i = 0; i < maxLength; i++) {
        if (i < oldObj.length && i < newObj.length) {
          changes.push(...compareObjects(oldObj[i], newObj[i], `${path}[${i}]`, { parent: oldObj[i], arrayIndex: i }))
        } else {
          changes.push({ field: `${path}[${i}]`, oldValue: oldObj[i], newValue: newObj[i] })
        }
      }
    }
    return changes
  }
  
  // Compare all keys in both objects
  const allKeys = new Set([
    ...Object.keys(oldObj || {}),
    ...Object.keys(newObj || {})
  ])
  
  for (const key of allKeys) {
    // Annotations such as assignments@odata.context describe the read, not the configuration.
    if (skipFields.includes(key) || key.endsWith('@odata.context') || key.endsWith('@odata.nextLink')) continue
    
    const oldValue = oldObj?.[key]
    const newValue = newObj?.[key]
    const currentPath = path ? `${path}.${key}` : key
    
    if (typeof oldValue === 'object' && typeof newValue === 'object' && oldValue !== null && newValue !== null) {
      // Recursively compare objects
      changes.push(...compareObjects(oldValue, newValue, currentPath, { parent: oldObj, arrayIndex: null }))
    } else if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      const change: any = {
        field: currentPath,
        oldValue,
        newValue
      }
      
      // Add display name for omaSettings values
      if (currentPath.includes('omaSettings') && key === 'value' && context.parent?.displayName) {
        change.displayName = context.parent.displayName
      }
      
      changes.push(change)
    }
  }
  
  return changes
}

function checkIfRevertDrift(
  driftChanges: { field: string; oldValue: any; newValue: any }[] | undefined,
  revertChanges: { field: string; oldValue: any; revertedTo: any }[] | undefined
): boolean {
  if (!driftChanges || !revertChanges) return false
  
  // For each revert change, check if there's a matching drift change
  for (const revertChange of revertChanges) {
    const matchingDrift = driftChanges.find(dc => {
      // Same field
      if (dc.field !== revertChange.field) return false
      
      // The drift's "old value" should match what we reverted from
      // and the drift's "new value" should match what we reverted to
      const oldValueMatches = JSON.stringify(dc.oldValue) === JSON.stringify(revertChange.oldValue)
      const newValueMatches = JSON.stringify(dc.newValue) === JSON.stringify(revertChange.revertedTo)
      
      return oldValueMatches && newValueMatches
    })
    
    if (!matchingDrift) return false
  }
  
  return true
}

function determineSeverity(
  policyType: string,
  changeType: string,
  content: any,
  changes?: { field: string; oldValue: any; newValue: any }[]
): "critical" | "warning" | "info" {
  // Critical changes
  if (changeType === "deleted" && policyType === "Compliance Policy") return "critical"
  if (changeType === "deleted" && policyType === "Conditional Access") return "critical"
  
  // Check for security-related field changes
  if (changes) {
    const criticalFields = ['passwordRequired', 'encryption', 'jailbreak', 'firewall', 'antivirus', 'bitLocker']
    const hasCriticalChange = changes.some(c => 
      criticalFields.some(f => c.field.toLowerCase().includes(f.toLowerCase()))
    )
    if (hasCriticalChange) return "critical"
  }
  
  // Warning level changes
  if (changeType === "deleted") return "warning"
  if (changeType === "modified" && (policyType === "Compliance Policy" || policyType === "Device Configuration")) return "warning"
  
  // Everything else is info
  return "info"
}

function generateChangeDescription(policyType: string, changes: { field: string; oldValue: any; newValue: any; displayName?: string }[]): string {
  if (changes.length === 0) return `${policyType} modified`
  
  // Find the most significant change - look for omaSettings value changes
  const omaValueChange = changes.find(c => c.field.includes('omaSettings') && c.field.includes('.value'))
  const significantChange = omaValueChange || changes.find(c => 
    !c.field.includes('version') && 
    !c.field.includes('modified') &&
    !c.field.includes('description')
  ) || changes[0]
  
  if (!significantChange) return `${policyType} modified`
  
  // Handle omaSettings changes specially
  if (significantChange.field.includes('omaSettings[')) {
    const match = significantChange.field.match(/omaSettings\[([^\]]+)\]\.(.+)/)
    if (match) {
      const [, settingName, property] = match
      if (property === 'value' && settingName) {
        return `${settingName} changed from ${significantChange.oldValue} to ${significantChange.newValue}`
      }
    }
  }
  
  const field = significantChange.field.split('.').pop() || significantChange.field
  
  if (typeof significantChange.oldValue === 'boolean') {
    return `${field} ${significantChange.newValue ? 'enabled' : 'disabled'}`
  }
  
  if (field === 'version') {
    return `Policy version updated`
  }
  
  return `${field} changed from "${significantChange.oldValue}" to "${significantChange.newValue}"`
}

function determineImpact(
  policyType: string,
  changeType: string,
  content: any,
  changes?: { field: string; oldValue: any; newValue: any }[]
): string {
  if (changeType === "deleted") {
    return `${policyType} no longer applied to devices`
  }
  
  if (changeType === "added") {
    return `New ${policyType} will be applied to assigned devices`
  }
  
  if (changes && changes.length > 0) {
    return `${changes.length} configuration ${changes.length === 1 ? 'change' : 'changes'} will affect assigned devices`
  }
  
  return "Configuration updated"
}