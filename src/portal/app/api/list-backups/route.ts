import { isBearerToken } from "../../../../shared/security"
import { signInLogCode } from "../../../../shared/sign-in-errors"
import { ownedRemnant, REMNANT_RECOVERY_DAYS, completeHalf, largeRunProblems, matchingCompanions, withRunRecord } from "../../../../shared/backup-companion"
import { backupStoragePath, isLargeBackup, LARGE_BACKUP_CONTAINER, LARGE_STORAGE_UNAVAILABLE } from "../../../../shared/backup-storage"
import { backupTypeUse } from "../../../../shared/services/backup-use"
import { BlobListError, decodeXml, listBlobPages, listLargeBackupPages } from "~/lib/storage/list"
import { typeForFolder } from "../../../../shared/intune/registry"
import { describeScope } from "../../../../shared/intune/scope"
import { comparable, compareBackups, summarize, type BackupFingerprint, type ChangeSummary } from "../../../../shared/intune/backup-changes"
import { BACKUP_OWNER_FILE, BACKUP_RUN_RECORD_FILE, LOCAL_STORAGE_PREFIX, MAX_BACKUP_ARCHIVE_BYTES } from "../../../../shared/constants"
import { mapLimit } from "../../../../shared/map-limit"
import { MetadataCache } from "~/lib/storage/metadata-cache"
import { manifestStatus } from "../../../../shared/intune/backup-status"
import { manifestCoverage } from "../../../../shared/backup-outcomes"
import { backupFoldersIn, parseBackupName } from "../../../../shared/intune/backup-names"
import { isLegacyOtherTenantError, isLegacySealedError } from "../../../../shared/legacy-sealed"
import { oversizedOwnershipFile, resolveBackupOwnership, type OwnershipFile } from "../../../../shared/backup-ownership"
import { readJsonCapped } from "../../../../shared/capped-body"
import { DAMAGE_KINDS, DAMAGE_KINDS_HEADER, damagedFileKindsFrom, type DamagedFileKinds } from "../../../../shared/damaged-files"
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

// At most eight missing-discovery companion lookups per history request.
export const COMPANION_LOOKUP_BUDGET = 8

interface MetadataRead { metadata: any; metadataError?: string; retryable?: boolean; unavailable?: boolean; sealed?: boolean; foreign?: boolean }

/**
 * Why a backup on this device is unavailable, from the local store's refusal: damaged or
 * unreadable files traced to it (BackupUnavailable). Null for every other failure, including a
 * blob that may only be in a file that could not be traced: that does not make the backup unavailable.
 */
function unavailableReason(status: number, body: string, local: boolean): string | null {
  if (status !== 409 || !body.includes('<Code>BackupUnavailable</Code>')) return null
  if (!local) return 'Backup files could not be read (HTTP 409, BackupUnavailable). Check storage access and retry.'
  return decodeXml(/<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? 'Files of this backup could not be read.')
}
const metadataCache = new MetadataCache<MetadataRead>(result => !!result.metadata && !result.metadataError && !result.metadata.CompanionBackup && !result.metadata.LargeBackupOutcomes)
/**
 * A folder's ownership marker as read. Only a marker that was read is cached: importing the
 * recovery key, or storage answering again, brings the folder back.
 */
const ownerCache = new MetadataCache<OwnershipFile>(result => result.kind === 'found')
/** Run records read at once in history, and how long one may take before the early manifest stands. */
const RUN_RECORD_READS = 8
const RUN_RECORD_TIMEOUT_MS = 10_000
const RUN_RECORD_BUDGET_MS = 15_000

/** One backup folder, described from metadata and either a folder listing or the summary inventory. */
async function describeBackup(storageAccountName: string, name: string, accessToken: string, tenantId: string, inventory?: { text: string; cacheKey: string; version: string; owner: string }) {
  const parsed = parseBackupName(name)!
  const legacy = parsed.precision === "day"
  const date = parsed.timestamp.slice(0, 10)
  const local = storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)
  const readMetadata = async (): Promise<MetadataRead> => {
    try {
      const response = await fetch(`https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(`${name}/metadata.json`)}`, { headers: storageHeaders(accessToken) })
      if (response.ok) {
        const body = await readJsonCapped(response, MAX_BACKUP_ARCHIVE_BYTES)
        if (body.kind === 'oversized') return { metadata: null, metadataError: oversizedOwnershipFile('metadata.json') }
        if (body.kind === 'invalid') return { metadata: null, metadataError: 'Backup metadata could not be read or parsed.' }
        const metadata = body.value as any
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { metadata: null, metadataError: 'Backup metadata could not be read or parsed.' }
        return { metadata }
      }
      const body = response.status === 409 ? await response.text() : ''
      const unavailable = unavailableReason(response.status, body, local)
      if (unavailable) return { metadata: null, metadataError: unavailable, unavailable: true }
      // A manifest that may only be in a file no backup can be traced to: the folder is treated as
      // having none, so it shows as running or incomplete and is never used as a complete backup.
      if (response.status === 409 && body.includes('<Code>InventoryIncomplete</Code>')) return { metadata: null }
      return { metadata: null, metadataError: response.status !== 404 ? `Backup metadata is unavailable (${response.status}).` : undefined, retryable: response.status >= 500 }
    } catch (error) {
      // A backup sealed by an earlier version for another tenant signed in here is that tenant's.
      if (isLegacyOtherTenantError(error)) return { metadata: null, foreign: true }
      // A backup sealed by an earlier version that no key on this device opens, or one that cannot be read for another reason, says why.
      if (error instanceof Error && (error.name === 'FetchApplicationError' || error.name === 'FetchPreconditionError')) return { metadata: null, metadataError: error.message, sealed: isLegacySealedError(error) }
      return { metadata: null, metadataError: 'Backup metadata could not be read or parsed.', retryable: true }
    }
  }
  // On this device a backup can become unavailable while its metadata.json stays unchanged (another
  // of its files is damaged), so its metadata is read each time: the store checks it then.
  const metadataRead: Promise<MetadataRead> = inventory?.version
    ? (local ? readMetadata() : metadataCache.read(inventory.cacheKey, inventory.version, readMetadata))
    // On this device a listing leaves out a metadata.json it cannot read, so a folder listed without
    // one is asked for it: the store answers 409 when damaged files made the backup unavailable.
    : inventory ? (local ? readMetadata().then((read) => read.unavailable || (isLargeBackup(name) && read.retryable) ? read : { metadata: null }) : Promise.resolve({ metadata: null })) : readMetadata()
  // A backup made unavailable by damaged files is still listed, with the reason, so the others stay usable.
  const filesRead: Promise<string | { unavailable: string }> = inventory ? Promise.resolve(inventory.text) : listBlobPages(`https://${storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=${encodeURIComponent(`${name}/`)}`, accessToken).catch((error) => {
    const unavailable = error instanceof BlobListError ? unavailableReason(error.status, error.body, local) : null
    if (unavailable) return { unavailable }
    throw new Error(`Backup ${name} inventory is unavailable. Check storage access and retry.`)
  })
  const [metadataResult, listing] = await Promise.all([metadataRead, filesRead])
  const unavailable = typeof listing === 'string' ? (metadataResult.unavailable ? metadataResult.metadataError! : null) : listing.unavailable
  const filesText = typeof listing === 'string' && !unavailable ? listing : ''
  const listedMetadata = unavailable ? null : metadataResult.metadata
  const readError = unavailable ?? metadataResult.metadataError
  // Ownership comes from the shared resolver (shared/backup-ownership.ts): the manifest's tenant,
  // else the ownership marker, read just for those folders and only when the listing holds one.
  // For a folder without a manifest the marker's run id lets the Dashboard count a failed run once.
  const readMarker = async (): Promise<OwnershipFile> => {
    try {
      const response = await fetch(`https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(`${name}/${BACKUP_OWNER_FILE}`)}`, { headers: storageHeaders(accessToken) })
      if (response.status === 404) return { kind: 'missing' }
      if (!response.ok) return { kind: 'unreadable', error: new Error(`The ownership record is unavailable (${response.status}).`) }
      const body = await readJsonCapped(response, MAX_BACKUP_ARCHIVE_BYTES)
      if (body.kind === 'oversized') return { kind: 'unreadable', error: new Error(oversizedOwnershipFile(BACKUP_OWNER_FILE)) }
      if (body.kind === 'invalid') return { kind: 'unreadable', error: new Error('The ownership record is not valid JSON.') }
      return { kind: 'found', value: body.value }
    } catch (error) {
      return { kind: 'unreadable', error }
    }
  }
  let claim: Record<string, any> | null = null
  const loadClaim = async (): Promise<OwnershipFile> => {
    if (!filesText.includes(`<Name>${name}/${BACKUP_OWNER_FILE}</Name>`)) return { kind: 'missing' }
    const marker = await (inventory?.owner ? ownerCache.read(inventory.cacheKey, inventory.owner, readMarker) : readMarker())
    if (marker.kind === 'found' && marker.value && typeof marker.value === 'object' && !Array.isArray(marker.value)) claim = { ...marker.value, BackupFolder: (marker.value as Record<string, unknown>).BackupFolder ?? name }
    return marker
  }
  const { manifest, owner } = await resolveBackupOwnership(async (file) => {
    if (file === 'metadata.json') return listedMetadata ? { kind: 'found', value: listedMetadata } : readError ? { kind: 'unreadable', error: new Error(readError) } : { kind: 'missing' }
    if (!filesText.includes(`<Name>${name}/${BACKUP_OWNER_FILE}</Name>`)) return { kind: 'missing' }
    return loadClaim()
  }, tenantId)
  // A marker sealed by an earlier version that cannot be opened for this tenant is foreign (another
  // tenant's, or a key this device lacks). One that could not be read otherwise (any status but 404,
  // a network error, a body that cannot be parsed or names no tenant) leaves the folder unresolved
  // until it can be. A missing sign-in on this device leaves the marker unreadable until it is fixed.
  // Metadata the resolver could not use (it records an invalid tenant) is shown as unreadable, as it is for every other caller.
  const metadata = listedMetadata && manifest.kind === 'found' ? listedMetadata : null
  const metadataError = readError ?? (listedMetadata && manifest.kind === 'unreadable' && manifest.error instanceof Error ? manifest.error.message : undefined)
  const markerFailure = owner.kind === 'unreadable' ? owner.error : null
  const foreignMarker = markerFailure instanceof Error && markerFailure.name === 'FetchApplicationError'
  // A folder whose manifest could not be read is not matched to its run: its status is unknown, so the run counts once, through its attempt record.
  const markerRunId = (owner.kind === 'owned' || owner.kind === 'other') && owner.source === 'marker' ? owner.runId : null
  const runId = typeof metadata?.RunId === 'string' ? metadata.RunId as string : !metadata && !metadataError ? markerRunId : null
  const recordedTimestamp = metadata?.timestamp ?? metadata?.Timestamp ?? metadata?.BackupDate
  const timestamp = legacy
    ? typeof recordedTimestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(recordedTimestamp) && Number.isFinite(Date.parse(recordedTimestamp)) ? recordedTimestamp : date
    : parsed.timestamp

  let size = 0
  let files = 0
  const counts: Record<string, number> = {}
  const sizes: Record<string, number> = {}
  for (const match of (isLargeBackup(name) ? "" : filesText).matchAll(/<Blob>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<Content-Length>(\d+)<\/Content-Length>[\s\S]*?<\/Blob>/g)) {
    const parts = decodeXml(match[1] ?? '').split('/')
    const bytes = parseInt(match[2]!)
    size += bytes
    files++
    // Backups from older app versions stored compliance policies under this name.
    const type = parts.length === 3 ? typeForFolder(parts[1] === 'DeviceCompliancePolicies' ? 'CompliancePolicies' : parts[1]!) : undefined
    const folder = type?.folder ?? (parts.length === 3 && ['AppProtectionPolicies', 'ConditionalAccess'].includes(parts[1]!) ? parts[1] : undefined)
    if (folder) {
      counts[folder] = (counts[folder] ?? 0) + 1
      sizes[folder] = (sizes[folder] ?? 0) + bytes
    }
  }
  if (metadata?.LargeItems) {
    for (const [folder, value] of Object.entries(metadata.ItemCounts ?? {})) if (folder !== "TotalPolicies" && typeof value === "number") counts[folder] = value
    for (const [folder, value] of Object.entries(metadata.LargeSizes ?? {})) if (typeof value === "number") { sizes[folder] = value; size += value }
  }
  const count = (...folders: string[]) => folders.reduce((sum, folder) => sum + (counts[folder] ?? 0), 0)
  const totalPolicies = Object.values(counts).reduce((sum, value) => sum + value, 0)
  // Inventory such as Autopilot devices is an item of the backup but not a policy.
  const policyCount = Object.entries(counts).reduce((sum, [folder, value]) => (typeForFolder(folder) && !backupTypeUse(typeForFolder(folder)!).policyCount ? sum : sum + value), 0)
  const excluded: string[] = Array.isArray(metadata?.Scope?.Excluded) ? metadata.Scope.Excluded : []
  const included = recordedInclusion(metadata)

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
    status: unavailable ? 'unavailable' : metadataError ? 'unknown' : metadata ? String(manifestStatus(metadata) ?? 'unknown') : legacy ? 'unknown' : Date.now() - Date.parse(timestamp) < 6 * 3600_000 ? 'running' : 'incomplete',
    configs: files,
    policyCount,
    totalPolicies,
    counts,
    sizes,
    ...(isLargeBackup(name) ? { largeInventory: true } : {}),
    // Kept for the dashboard's breakdown.
    policies: {
      deviceConfigurations: count('DeviceConfigurations'),
      compliancePolicies: count('CompliancePolicies', 'ComplianceSettingsPolicies'),
      configurationPolicies: count('ConfigurationPolicies', 'GroupPolicyConfigurations'),
      appProtectionPolicies: count('AppProtectionIOS', 'AppProtectionAndroid', 'AppProtectionWindows', 'AppProtectionPolicies'),
      conditionalAccess: count('ConditionalAccess'),
    },
    scope: metadata ? { excluded, included, description: describeScope({ excluded }) } : null,
    failures: typeof metadata?.Failures === 'number' ? metadata.Failures : 0,
    skippedTypes: Array.isArray(metadata?.SkippedTypes) ? metadata.SkippedTypes : [],
    failedTypes: Array.isArray(metadata?.FailedTypes) ? metadata.FailedTypes : [],
    // Whether the backup holds every type it was asked to cover; null for backups made before this was recorded.
    ...manifestCoverage(metadata),
    size,
    ownSize: size,
    remnant: false,
    sizeFormatted: formatBytes(size),
    duration: typeof metadata?.DurationSeconds === 'number' ? metadata.DurationSeconds : metadata?.Duration ?? metadata?.duration ?? null,
    changes: null as ChangeSummary | null,
    comparedWith: null as string | null,
    fingerprint: metadata as BackupFingerprint | null | undefined,
    claim,
    loadClaim,
    error: metadataError,
    metadataRetryable: metadataResult.retryable,
    warning: undefined,
    runbookVersion: metadata?.RunbookVersion ?? metadata?.runbookVersion ?? null,
    runId,
    ownerTenantId: owner.kind === 'owned' || owner.kind === 'other' ? owner.tenantId : null,
    ownerKind: owner.kind,
    foreign: foreignMarker || Boolean(metadataResult.foreign),
    unresolved: owner.kind === 'unreadable' && !foreignMarker,
    // Sealed by an earlier version and not opened on this device: its manifest, or its ownership marker.
    sealed: Boolean(metadataResult.sealed) || (foreignMarker && isLegacySealedError(markerFailure)),
  }
}

function recordedInclusion(metadata: { Scope?: { Included?: unknown } } | null | undefined): string[] | undefined {
  const value = metadata?.Scope?.Included
  return Array.isArray(value) ? value.filter((folder): folder is string => typeof folder === "string") : undefined
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
      console.error("Azure auth error:", signInLogCode(errorData) ?? "token_request_failed")
      return NextResponse.json(
        { error: "Failed to authenticate with Azure", details: errorData },
        { status: 401 }
      )
    }

    const tokenData = await tokenResponse.json().catch(() => null)
    const accessToken = tokenData?.access_token
    if (!isBearerToken(accessToken)) {
      console.error("Azure auth error:", "token_invalid_response")
      return NextResponse.json({ error: "Microsoft returned an invalid sign-in response. Try again." }, { status: 502 })
    }


    // Skip container listing and go directly to listing blobs in intune-backups
    // This avoids needing account-level permissions

    // List blobs in the intune-backups container
    const summary = body.summary === true
    const blobsUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=${summary ? "" : "&delimiter=/"}`

    let blobsText: string
    try {
      blobsText = await listBlobPages(blobsUrl, accessToken)
    } catch (error) {
      if (!(error instanceof BlobListError)) throw error
      console.error("blob_request_failed", "backup listing", error.status)

      // A local import may hold only the large container.
      if (error.status === 404) {
        blobsText = ""
      } else {
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
    }

    // Large discovery contains only claims and manifests. Payloads live under a disjoint prefix
    // in their own container, so no history path can enumerate snapshots, even after a crash.
    const discoveryUrl = `https://${storageAccountName}.blob.core.windows.net/${LARGE_BACKUP_CONTAINER}?restype=container&comp=list&prefix=backup-large-`
    const warnings: string[] = []
    const largeText = await listLargeBackupPages(discoveryUrl, accessToken, warnings)
    const largeDiscoveryComplete = warnings.length === 0

    // Parse XML response to extract backup folders
    // Summary mode groups one flat inventory in process, including older backups without manifests.
    const inventories = new Map<string, { text: string; cacheKey: string; version: string; owner: string }>()
    {
      for (const match of (summary ? blobsText + largeText : largeText).matchAll(/<Blob>[\s\S]*?<\/Blob>/g)) {
        const name = decodeXml(match[0].match(/<Name>(.*?)<\/Name>/)?.[1] ?? '')
        const folder = name.split('/')[0]!
        if (!parseBackupName(folder)) continue
        let inventory = inventories.get(folder)
        if (!inventory) {
          inventory = { text: '', cacheKey: JSON.stringify([String(tenantId).toLowerCase(), storageAccountName, appId, folder]), version: '', owner: '' }
          inventories.set(folder, inventory)
        }
        inventory.text += match[0]
        if (name === `${folder}/metadata.json`) inventory.version = match[0]
        if (name === `${folder}/${BACKUP_OWNER_FILE}`) inventory.owner = match[0]
      }
    }
    const backupFolders = summary ? [...inventories.keys()] : [...backupFoldersIn(blobsText).map((folder) => folder.name), ...inventories.keys()]
    // Backups on this device: the store says how many files in the folder could not be read, so
    // the list can say that some backups may be missing from it or unavailable.
    let damagedFiles = 0
    let damagedFileNames: string[] = []
    // Why they cannot be used, by kind, so the list can say what to do about them.
    let damagedKinds: DamagedFileKinds | null = null
    if (storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)) {
      const containers = ['intune-backups', LARGE_BACKUP_CONTAINER]
      const kinds: DamagedFileKinds[] = []
      let knownKinds = true
      for (const container of containers) {
        const properties = await fetch(`https://${storageAccountName}.blob.core.windows.net/${container}?restype=container`, { headers: storageHeaders(accessToken) }).catch(() => null)
        const count = Number(properties?.headers.get('x-tenuvault-unreadable-files') ?? 0) || 0
        damagedFiles += count
        damagedFileNames.push(...(properties?.headers.get('x-tenuvault-unreadable-file-names') ?? '').split(',').filter((name) => /^[0-9a-f]{1,64}\.tvb$/i.test(name)))
        if (count) {
          try {
            const value = damagedFileKindsFrom(JSON.parse(properties?.headers.get(DAMAGE_KINDS_HEADER) ?? 'null'), count)
            if (value) kinds.push(value)
            else knownKinds = false
          } catch { knownKinds = false }
        }
      }
      if (knownKinds && kinds.length) {
        damagedKinds = kinds[0]!
        for (const next of kinds.slice(1)) {
          for (const kind of DAMAGE_KINDS) { damagedKinds.counts[kind] += next.counts[kind]; damagedKinds.names[kind].push(...next.names[kind]) }
          damagedKinds.codes = [...new Set([...damagedKinds.codes, ...next.codes])]
        }
      }
    }
    
    // Get details for each backup folder
    const backups: any[] = []
    
    // A container can be shared by several tenants. Backups recorded as another tenant's, in the
    // manifest or for a folder without one in its ownership marker, are left out, and so are folders
    // whose marker cannot be opened for this tenant. Older backups that do not record a tenant are still listed.
    // A folder whose marker could not be read may be another tenant's, so it is left out too and
    // counted as unresolved; its run, if it failed, counts once through its attempt record.
    const described = await mapLimit(backupFolders, 6, (name) => describeBackup(storageAccountName, name, accessToken, String(tenantId), inventories.get(name)))
    const omittedLarge = described.filter(backup => isLargeBackup(backup.id) && (backup.unresolved || backup.error) && !backup.foreign && backup.status !== "unavailable")
    if (omittedLarge.length) warnings.push(LARGE_STORAGE_UNAVAILABLE)
    const unresolved = described.filter((backup) => backup.unresolved).length
    // Folders sealed by an earlier version that this device cannot open, for the backups page's offer
    // to import a recovery key. Without the key nobody can tell whose such a folder is, so it counts
    // only when a readable record names this tenant, or when nothing in the container shows another
    // tenant: in a container another tenant also uses it may be theirs, and a key would not help.
    // Filtering and attribution use only the shared resolver's outcome, never a raw manifest field.
    const otherTenantSeen = described.some((backup) => backup.ownerKind === 'other' || (backup.foreign && !backup.sealed))
    const sealed = described.filter((backup) => backup.sealed && (backup.ownerKind === 'owned' || (backup.ownerKind !== 'other' && !otherTenantSeen))).length
    backups.push(...described.filter((backup) => !omittedLarge.includes(backup) && !backup.foreign && !backup.unresolved && backup.ownerKind !== 'other'))

    // Resolve only linked manifests. Existing descriptions are reused, including their cached reads.
    // Successful discovery is authoritative. A failed or partial discovery has a fixed lookup budget.
    const byId = new Map(described.map(backup => [backup.id, backup]))
    const linkedReads = new Map<string, Promise<MetadataRead>>()
    const hidden = new Set<string>()
    const mismatched = new Set<string>()
    // A split run whose early manifest could not be replaced keeps its final result in its own record. Only
    // those manifests, which lack the run status, are read for one: a few at a time and each bounded, so
    // a slow record leaves the early manifest standing instead of holding up history.
    const records = new Map<string, Record<string, any>>()
    // Records that may exist but could not be read in time; their run is not judged from the early manifest.
    const unreadRecords = new Set<string>()
    // Reads that finished, with a record, without one (404) or with one that is not valid JSON.
    const settledRecords = new Set<string>()
    const pending = backups.filter(backup => !isLargeBackup(backup.id) && backup.fingerprint?.CompanionBackup !== undefined && typeof backup.fingerprint?.RunStatus !== "string")
    // One budget covers every record read, so many stalled records cost history at most this long.
    const budget = AbortSignal.timeout(RUN_RECORD_BUDGET_MS)
    for (let start = 0; start < pending.length && !budget.aborted; start += RUN_RECORD_READS) {
      await Promise.all(pending.slice(start, start + RUN_RECORD_READS).map(async backup => {
        const signal = AbortSignal.any([AbortSignal.timeout(RUN_RECORD_TIMEOUT_MS), budget])
        let abort: (() => void) | undefined
        try {
          // The local store may ignore the signal. Bound the fetch and the body read together.
          const stopped = new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason)
            if (signal.aborted) abort()
            else signal.addEventListener("abort", abort, { once: true })
          })
          const reading = (async () => {
            const response = await fetch(`https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(`${backup.id}/${BACKUP_RUN_RECORD_FILE}`)}`, { headers: storageHeaders(accessToken), signal })
            return { status: response.status, read: response.ok ? await readJsonCapped(response, MAX_BACKUP_ARCHIVE_BYTES) : null }
          })()
          const { status, read } = await Promise.race([stopped, reading])
          if (!read && status !== 404) { unreadRecords.add(backup.id); return }
          settledRecords.add(backup.id)
          if (read?.kind === "json" && read.value && typeof read.value === "object") records.set(backup.id, read.value as Record<string, any>)
        } catch { unreadRecords.add(backup.id) }
        finally { if (abort) signal.removeEventListener("abort", abort) }
      }))
    }
    // Only reads the budget cut off or never started are unread; a finished read decided the row already.
    for (const backup of pending) if (!settledRecords.has(backup.id) && budget.aborted) unreadRecords.add(backup.id)
    for (const backup of backups.filter(backup => !isLargeBackup(backup.id))) {
      let metadata = backup.fingerprint
      if (!metadata || (metadata.CompanionBackup === undefined && metadata.LargeBackupOutcomes === undefined)) continue
      const merged = withRunRecord(backup.id, metadata, records.get(backup.id))
      if (merged && merged !== metadata) {
        metadata = merged
        backup.duration = typeof merged.DurationSeconds === "number" ? merged.DurationSeconds : merged.Duration ?? backup.duration
      }
      const companionId = metadata.CompanionBackup
      const describedCompanion = byId.get(companionId)
      let other: any = describedCompanion?.fingerprint
      let companionUnavailable = describedCompanion?.metadataRetryable === true
      let cause: string | undefined
      if (!other) {
        if (describedCompanion) {
          cause = describedCompanion.error ? `Large companion is unreadable. ${describedCompanion.error}` : describedCompanion.status === "running" ? "Large companion is still running." : "Large companion stopped before completion (crashed or interrupted)."
        } else if (typeof companionId === "string" && parseBackupName(companionId) && isLargeBackup(companionId)) {
          let reading = linkedReads.get(companionId)
          if (!reading && largeDiscoveryComplete) {
            cause = "Large companion is missing (not found by complete discovery)."
          } else if (!reading && linkedReads.size >= COMPANION_LOOKUP_BUDGET) {
            companionUnavailable = true
            cause = `Large companion is unresolved: discovery was unavailable or partial and the ${COMPANION_LOOKUP_BUDGET}-lookup recovery budget was reached. Refresh after checking large storage access.`
          } else if (!reading) {
            reading = (async (): Promise<MetadataRead> => {
              try {
                const response = await fetch(`https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(`${companionId}/metadata.json`)}`, { headers: storageHeaders(accessToken) })
                if (!response.ok) return { metadata: null, metadataError: response.status === 404 ? "Large companion is missing (removed or never committed)." : `Large companion is unreadable (${response.status}).`, retryable: response.status >= 500 }
                const read = await readJsonCapped(response, MAX_BACKUP_ARCHIVE_BYTES)
                return read.kind === "json" ? { metadata: read.value } : { metadata: null, metadataError: "Large companion is unreadable." }
              } catch { return { metadata: null, metadataError: "Large companion is unreadable.", retryable: true } }
            })()
            linkedReads.set(companionId, reading)
          }
          if (reading) {
            const read = await reading
            other = read.metadata
            cause = read.metadataError
            companionUnavailable = read.retryable === true
          }
        } else cause = "Large companion does not match: invalid or missing companion ID."
      }
      // A reciprocal claim identifies an unfinished half, but can never certify completion.
      const evidence = other ?? describedCompanion?.claim
      const matches = matchingCompanions(backup.id, metadata, companionId, evidence) && evidence?.TenantId?.toLowerCase() === String(tenantId).toLowerCase()
      if (evidence && !matches) { cause = "Large companion does not match this run."; mismatched.add(companionId) }
      if (matches) {
        hidden.add(companionId)
        backup.companionId = companionId
        if (other && !completeHalf(other)) cause = `Large companion is ${String(other.Status ?? "incomplete").toLowerCase()}; large capture is incomplete.`
        if (describedCompanion) {
          backup.counts = { ...backup.counts, ...describedCompanion.counts }
          backup.sizes = { ...backup.sizes, ...describedCompanion.sizes }
          backup.totalPolicies += describedCompanion.totalPolicies
          backup.policyCount += describedCompanion.policyCount
          backup.size += describedCompanion.size
          backup.sizeFormatted = formatBytes(backup.size)
          backup.failures += describedCompanion.failures
        } else if (other) {
          // Discovery missed the companion, but its manifest was read: summarize it the same way,
          // so a run whose items are all large stays restorable.
          const counts: Record<string, number> = {}, sizes: Record<string, number> = {}
          for (const [folder, value] of Object.entries(other.ItemCounts ?? {})) if (folder !== "TotalPolicies" && typeof value === "number") counts[folder] = value
          for (const [folder, value] of Object.entries(other.LargeSizes ?? {})) if (typeof value === "number") sizes[folder] = value
          const added = Object.values(counts).reduce((sum, value) => sum + value, 0)
          backup.counts = { ...backup.counts, ...counts }
          backup.sizes = { ...backup.sizes, ...sizes }
          backup.totalPolicies += added
          backup.policyCount += Object.entries(counts).reduce((sum, [folder, value]) => (typeForFolder(folder) && !backupTypeUse(typeForFolder(folder)!).policyCount ? sum : sum + value), 0)
          backup.size += Object.values(sizes).reduce((sum, value) => sum + value, 0)
          backup.sizeFormatted = formatBytes(backup.size)
          if (typeof other.Failures === "number") backup.failures += other.Failures
        }
      }
      const largeProblems = largeRunProblems(metadata, cause, matches ? other : null)
      backup.largeProblems = largeProblems
      if (backup.scope?.included) {
        const companionTypes = matches ? recordedInclusion(other) : undefined
        backup.scope.included = [...new Set([...backup.scope.included, ...(companionTypes ?? []), ...largeProblems.map(problem => problem.folder).filter(folder => typeForFolder(folder))])]
      }
      if (matches) {
        const { emptyTypes } = manifestCoverage(other)
        if (emptyTypes?.length) backup.emptyTypes = [...(backup.emptyTypes ?? []), ...emptyTypes]
      }
      // An unread record or an unresolved companion can still belong to a complete run.
      // Keep the full download offered so it can check storage again.
      backup.ordinaryOnlyAvailable = companionUnavailable && (!evidence || matches)
      backup.ordinaryOnlyExport = !unreadRecords.has(backup.id) && !backup.ordinaryOnlyAvailable && (backup.largeProblems.length > 0 || !matches || !completeHalf(metadata) || !completeHalf(other))
      if (backup.largeProblems.length || backup.ordinaryOnlyExport || backup.ordinaryOnlyAvailable) {
        backup.coverage = "incomplete"
        backup.status = "incomplete"
        backup.notRead = [...new Set([...backup.notRead, ...backup.largeProblems.map((problem: { folder: string }) => problem.folder)])]
        backup.warning = backup.largeProblems.map((problem: { folder: string; reason: string }) => `${problem.folder}: ${problem.reason}`).join(" ") || cause
      }
      if (backup.ordinaryOnlyExport && metadata.Export?.kind !== "ordinary-only") {
        backup.remnant = true
        if (matches && describedCompanion) describedCompanion.remnant = true
      }
      if (metadata.Export?.kind === "ordinary-only") backup.ordinaryOnlyExport = true
    }
    for (const backup of backups) {
      if (isLargeBackup(backup.id) && (backup.fingerprint?.CompanionBackup || backup.claim?.CompanionBackup || mismatched.has(backup.id)) && !hidden.has(backup.id)) {
        backup.runId = null
        backup.status = "incomplete"
        backup.coverage = "incomplete"
        backup.warning = "Ordinary companion does not match or is missing. This orphaned large companion needs recovery or remnant cleanup."
        backup.largeProblems = largeRunProblems({}, backup.warning, backup.fingerprint)
        backup.notRead = [...new Set([...backup.notRead, ...backup.largeProblems.map((problem: { folder: string }) => problem.folder)])]
      }
      if (backup.fingerprint?.Export?.kind === "ordinary-only") {
        backup.ordinaryOnlyExport = true
        backup.warning = "Ordinary-only export. Large types were omitted from this copy."
      }
    }
    for (let index = backups.length - 1; index >= 0; index--) if (hidden.has(backups[index].id)) backups.splice(index, 1)

    // Reuse discovery and manifests for costs. Never enumerate large payloads just to show a notice.
    let ownedRemnants = 0, unownedRemnants = 0, remnantBytes = 0, unknownCosts = 0
    for (const backup of [...backups, ...described.filter(backup => hidden.has(backup.id))]) {
      const metadata = backup.fingerprint
      const remnant = backup.remnant || !metadata || isLargeBackup(backup.id) && backup.status === "incomplete"
      if (!remnant || backup.error) continue
      const marker = backup.claim ? { kind: "found", value: backup.claim } : await backup.loadClaim()
      const owned = ownedRemnant(backup.id, String(tenantId), marker.kind === "found" ? marker.value : null, metadata)
      if (owned) ownedRemnants++; else unownedRemnants++
      remnantBytes += backup.ownSize
      if (isLargeBackup(backup.id) && !metadata?.LargeSizes) unknownCosts++
    }
    if (ownedRemnants || unownedRemnants) warnings.push(`Backup remnants: ${ownedRemnants} owned and ${unownedRemnants} unverified halves, at least ${formatBytes(remnantBytes)}.${unknownCosts ? ` Payload size is unavailable for ${unknownCosts} unfinished large halves; inspect storage for their full cost.` : ""} Owned halves expire after retention plus ${REMNANT_RECOVERY_DAYS} recovery days; Forever deletes nothing. Recover needed files before cleanup. Check ownership and remove unverified remnants manually.`)

    // Sort by timestamp descending
    backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    
    // Each backup is compared with the newest older backup that can be compared.
    for (let i = 0; i < backups.length; i++) {
      const current = backups[i]!
      if (!current.fingerprint || !comparable(current.fingerprint)) continue
      const previous = backups.slice(i + 1).find((backup) => isLargeBackup(backup.id) === isLargeBackup(current.id) && backup.fingerprint && comparable(backup.fingerprint))
      if (!previous) continue
      current.changes = summarize(compareBackups(previous.fingerprint, current.fingerprint))
      current.comparedWith = previous.id
    }
    for (const backup of backups) {
      delete backup.ownSize
      delete backup.remnant
      delete backup.loadClaim
      delete backup.claim
      delete backup.fingerprint
      delete backup.metadataRetryable
      delete backup.ownerTenantId
      delete (backup as { ownerKind?: unknown }).ownerKind
      delete backup.foreign
      delete backup.unresolved
      delete backup.sealed
    }

    return NextResponse.json({ backups, unresolved, sealed, ...(warnings.length ? { warnings } : {}), ...(damagedFiles ? { damagedFiles, damagedFileNames, ...(damagedKinds ? { damagedKinds } : {}) } : {}) })
  } catch (error) {
    console.error("List backups error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error while listing backups" },
      { status: 500 }
    )
  }
}
