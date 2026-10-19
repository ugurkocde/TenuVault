import { parseDependencyMappings } from "../../../../shared/intune/recovery"
import { randomUUID } from "node:crypto"
import { backupManifest, incompleteReason, snapshotHash, type ManifestEntry } from "~/lib/policies/backup-manifest"
import { OTHER_TENANT_BACKUP, ownedBy } from "~/lib/policies/backup-owner"
import { validPolicyPath } from "~/lib/policies/restore"
import { graphCaller, Restorer, DependencyMappingError, type RestoreOutcome } from "~/lib/policies/graph-restore"
import { PROGRESS_ID, startProgress } from "~/lib/policies/restore-progress"
import { restoreOrder, type Item } from "../../../../shared/intune/registry"
import { type NextRequest, NextResponse } from "next/server"
async function getAccessToken(tenantId: string, appId: string, clientSecret: string, scope: string, forceRefresh = false) {
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
        scope: scope,
        grant_type: "client_credentials",
        force_refresh: String(forceRefresh),
      }),
    }
  )

  if (!tokenResponse.ok) {
    throw new Error("Failed to get access token")
  }

  const tokenData = await tokenResponse.json()
  return tokenData.access_token
}

const blobUrl = (storageAccountName: string, name: string) => `https://${storageAccountName}.blob.core.windows.net/intune-backups/${name.split("/").map(encodeURIComponent).join("/")}`
const storageHeaders = (storageToken: string) => ({ 'x-ms-version': '2021-12-02', Authorization: `Bearer ${storageToken}` })

async function readSnapshot(policyPath: string, storageAccountName: string, storageToken: string, requireAuthenticated: boolean, expected?: ManifestEntry): Promise<Item> {
  const response = await fetch(blobUrl(storageAccountName, policyPath), { headers: storageHeaders(storageToken) })
  if (!response.ok) throw new Error("Failed to fetch from backup")
  if (requireAuthenticated && response.headers.get("x-tenuvault-authenticated") !== "true") throw new Error("Unverified legacy backups cannot replace live policies or restore assignments. Review the content and restore an unassigned copy instead.")
  const snapshot = await response.json() as Item
  if (expected && (snapshot.id !== expected.id || snapshotHash(snapshot) !== expected.hash)) throw new Error("This backup file does not match its recorded fingerprint. It was not restored.")
  return snapshot
}

async function readBackupMetadata(storageAccountName: string, storageToken: string, backupId: string): Promise<{ data: Record<string, any>; authenticated: boolean } | null> {
  const response = await fetch(blobUrl(storageAccountName, `${backupId}/metadata.json`), { headers: storageHeaders(storageToken) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error("Failed to read backup metadata")
  return { data: await response.json() as Record<string, any>, authenticated: response.headers.get("x-tenuvault-authenticated") === "true" }
}

async function restoreSinglePolicy(restorer: Restorer, policyPath: string, storageAccountName: string, storageToken: string, requireAuthenticated: boolean, expected?: ManifestEntry, repairToken?: string): Promise<RestoreOutcome> {
  try {
    if (repairToken) return await restorer.repair(policyPath, repairToken)
    return await restorer.restore(policyPath, await readSnapshot(policyPath, storageAccountName, storageToken, requireAuthenticated, expected))
  } catch (error) {
    return { success: false, path: policyPath, error: error instanceof Error ? error.message : "Unknown error" }
  }
}

export async function POST(request: NextRequest) {
  let body: any
  try {
    body = await request.json()
    const {
      tenantId,
      appId,
      clientSecret,
      storageAccountName,
      backupId,
      restoreType,
      selectedPolicies,
      mode = 'copy',
      assignments = false,
      targetTenants,
      progressId,
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName || !backupId) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(backupId) || !['full', 'selective'].includes(restoreType ?? 'full') || !['copy', 'replace'].includes(mode) || typeof assignments !== 'boolean') {
      return NextResponse.json({ error: 'Invalid backup or restore type' }, { status: 400 })
    }
    if (progressId !== undefined && (typeof progressId !== 'string' || !PROGRESS_ID.test(progressId))) {
      return NextResponse.json({ error: 'Invalid progress ID' }, { status: 400 })
    }
    if (restoreType === 'selective' && (!Array.isArray(selectedPolicies) || !selectedPolicies.length || selectedPolicies.some((p: any) => !validPolicyPath(p?.path, backupId)) || new Set(selectedPolicies.map((p: any) => p.path)).size !== selectedPolicies.length)) {
      return NextResponse.json({ error: 'Select unique policy files from the chosen backup' }, { status: 400 })
    }

    // Copying to other tenants (MSP): each target is written with its own sign-in, as copies
    // under the original names, without assignments.
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (targetTenants !== undefined && (!Array.isArray(targetTenants) || !targetTenants.length || targetTenants.length > 50 || mode !== 'copy' || assignments ||
      targetTenants.some((t: any) => !guid.test(t?.tenantId ?? '') || !guid.test(t?.appId ?? '') || String(t.tenantId).toLowerCase() === String(tenantId).toLowerCase()))) {
      return NextResponse.json({ error: 'Choose other connected tenants to copy to. Copies are created without assignments.' }, { status: 400 })
    }

    let dependencyMappings
    try { dependencyMappings = parseDependencyMappings(body.dependencyMappings) }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid dependency mappings" }, { status: 400 }) }
    if (dependencyMappings.length && (targetTenants?.length !== 1 || body.confirmMappings !== true)) return NextResponse.json({ error: "Review mappings and select exactly one target tenant" }, { status: 400 })
    const repairSelections = Array.isArray(selectedPolicies) ? selectedPolicies.filter((p: any) => p.repairToken !== undefined) : []
    if (repairSelections.some((p: any) => typeof p.repairToken !== 'string' || !guid.test(p.repairToken)) ||
      (repairSelections.length && (restoreType !== 'selective' || targetTenants?.length > 1))) {
      return NextResponse.json({ error: 'Repair requests must select one target and valid repair tokens' }, { status: 400 })
    }
    const repairScope = (target: string) => JSON.stringify([tenantId, storageAccountName, backupId, target.toLowerCase(), mode, assignments, dependencyMappings])

    // Get access tokens for both Storage and Graph API
    const [storageToken, graphToken] = await Promise.all([
      getAccessToken(tenantId, appId, clientSecret, "https://storage.azure.com/.default"),
      getAccessToken(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default")
    ])

    // A shared container can hold other tenants' backups; never restore one of those.
    const readMetadata = await readBackupMetadata(storageAccountName, storageToken, backupId)
    if (readMetadata && !ownedBy(readMetadata.data, tenantId)) return NextResponse.json({ error: OTHER_TENANT_BACKUP }, { status: 403 })

    // Correlate the completed operation with its desktop audit event.
    const jobId = randomUUID()

    // Start the restore process
    const startTime = new Date()
    const results = []
    let restoredCount = 0
    let failedCount = 0
    let skippedCount = 0
    let unchangedCount = 0
    let partialCount = 0

    let paths: string[]
    if (restoreType === 'selective' && selectedPolicies) {
      paths = selectedPolicies.map((policy: { path: string }) => policy.path)
    } else {
      // Full restore - fetch all policies from the backup
      const policyFiles: string[] = []
      const seenMarkers = new Set<string>()
      let marker = ""
      const decodeXml = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      do {
        const listUrl = new URL(`https://${storageAccountName}.blob.core.windows.net/intune-backups`)
        listUrl.search = new URLSearchParams({ restype: 'container', comp: 'list', prefix: `${backupId}/`, marker }).toString()
        const listResponse = await fetch(listUrl, { headers: { 'x-ms-version': '2021-12-02', Authorization: `Bearer ${storageToken}` } })
        if (!listResponse.ok) throw new Error('Failed to list backup contents')
        const xmlText = await listResponse.text()
        for (const match of xmlText.matchAll(/<Blob>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<\/Blob>/g)) {
          const blobName = decodeXml(match[1] ?? '')
          if (validPolicyPath(blobName, backupId)) policyFiles.push(blobName)
        }
        marker = decodeXml(/<NextMarker>([^<]*)<\/NextMarker>/.exec(xmlText)?.[1] ?? '')
        if (marker && seenMarkers.has(marker)) throw new Error('Storage returned a repeated continuation marker')
        seenMarkers.add(marker)
      } while (marker)
      paths = policyFiles
    }

    const targets: Array<{ restorer: Restorer; targetTenantId?: string }> = targetTenants
      ? await Promise.all((targetTenants as Array<{ tenantId: string; appId: string }>).map(async (target) => ({
          targetTenantId: target.tenantId.toLowerCase(),
          restorer: new Restorer(graphCaller(await getAccessToken(target.tenantId, target.appId, clientSecret, "https://graph.microsoft.com/.default"), fetch, { tenant: target.tenantId, refreshToken: () => getAccessToken(target.tenantId, target.appId, clientSecret, "https://graph.microsoft.com/.default", true) }),
            { mode: 'copy', assignments: false, prefix: '', crossTenant: true, repairScope: repairScope(target.tenantId) }),
        })))
      : [{ restorer: new Restorer(graphCaller(graphToken, fetch, { tenant: tenantId, refreshToken: () => getAccessToken(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default", true) }), { mode, assignments, repairScope: repairScope(tenantId) }) }]
    try {
      if (dependencyMappings.length) for (const { restorer } of targets) await restorer.mapDependencies(dependencyMappings)
    } catch (error) {
      if (error instanceof DependencyMappingError && error.status === 404) return NextResponse.json({ error: error.message }, { status: 400 })
      throw error
    }

    const requireAuthenticated = mode === "replace" || assignments
    // An unauthenticated metadata record cannot vouch for completeness or fingerprints in a
    // restore that requires authenticated snapshots.
    const metadata = readMetadata && (!requireAuthenticated || readMetadata.authenticated) ? readMetadata.data : null
    let manifest: Map<string, ManifestEntry> | null
    try { manifest = backupManifest(metadata, backupId) }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid backup inventory manifest" }, { status: 400 }) }
    const incomplete = incompleteReason(metadata, manifest, paths, restoreType !== 'selective')
    if (incomplete) return NextResponse.json({ error: incomplete }, { status: 400 })

    const progress = progressId ? startProgress(progressId, paths.length * targets.length) : null
    try {
      for (const { restorer, targetTenantId } of targets) {
        for (const path of restoreOrder(paths)) {
          if (progress) progress.current = path
          const result = await restoreSinglePolicy(restorer, path, storageAccountName, storageToken, requireAuthenticated, manifest?.get(path), repairSelections.find((p: any) => p.path === path)?.repairToken)
          const entry = targetTenantId ? { ...result, targetTenantId } : result
          results.push(entry)
          if (result.partial) partialCount++
          if (result.action === 'unchanged') unchangedCount++
          else if (result.success) restoredCount++
          else if (result.action === 'skipped') skippedCount++
          else failedCount++
          if (progress) {
            progress.done++
            progress.results.push(entry)
            progress.updatedAt = Date.now()
          }
        }
      }
    } finally {
      if (progress) {
        progress.finished = true
        progress.current = null
      }
    }

    const endTime = new Date()
    const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000)

    const done = targetTenants
      ? `Copied ${restoredCount} item${restoredCount === 1 ? '' : 's'} to ${targetTenants.length} tenant${targetTenants.length === 1 ? '' : 's'}`
      : mode === 'copy'
      ? `Created ${restoredCount} ${assignments ? '' : 'unassigned '}[Restored] cop${restoredCount === 1 ? 'y' : 'ies'}`
      : `Restored ${restoredCount} item${restoredCount === 1 ? '' : 's'} in place`
    // Replace in place leaves items that already match the backup alone; they count as done.
    const handled = restoredCount + unchangedCount
    return NextResponse.json({
      success: failedCount === 0 && handled > 0,
      jobId: jobId,
      status: partialCount > 0 ? "PartiallyCompleted" : handled === 0 ? "Failed" : failedCount > 0 ? "PartiallyCompleted" : "Completed",
      message: `${done}; ${failedCount} failed${unchangedCount ? `; ${unchangedCount} already matched the backup` : ''}${skippedCount ? `; ${skippedCount} kept as reference only` : ''}`,
      details: {
        restoredCount,
        failedCount,
        partialCount,
        skippedCount,
        unchangedCount,
        duration,
        results
      }
    })
  } catch (error) {
    console.error("Restore backup error:", error)

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error while restoring" },
      { status: 500 }
    )
  }
}
