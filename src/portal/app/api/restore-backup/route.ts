import { approvalsEnabled, enrolledBatchDestinations, hasWriteApproval, verifyApprovalSource, withWriteApproval, WriteApprovalError } from "../../../../main/write-approvals/service"
import { sameObservation, withExemptGraphCaller } from "../../../../main/write-approvals/dispatch"
import { restoreApprovals, dismissRestoreApproval, saveRestoreApproval } from "../../../../main/storage/restore-approvals"
import { parseDependencyMappings } from "../../../../shared/intune/recovery"
import { randomUUID } from "node:crypto"
import { checkRestoreManifest, verifySnapshot, type ManifestEntry } from "~/lib/policies/backup-manifest"
import { readOwnedBackup, UNTAGGED_BACKUP } from "~/lib/policies/backup-owner"
import { validPolicyPath } from "~/lib/policies/restore"
import { graphCaller, Restorer, DependencyMappingError, type RestoreOutcome } from "~/lib/policies/graph-restore"
import { PROGRESS_ID, startProgress } from "~/lib/policies/restore-progress"
import { restoreOrder, type Item } from "../../../../shared/intune/registry"
import { grantedPermissions } from "../../../../shared/services/token"
import { isGuid } from "../../../../shared/security"
import { type NextRequest, NextResponse } from "next/server"
export async function getAccessToken(tenantId: string, appId: string, clientSecret: string, scope: string, forceRefresh = false) {
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

async function groupedApproval(tenants: string[]): Promise<boolean> {
  try {
    return (await enrolledBatchDestinations(tenants.map(tenant => tenant.toLowerCase()))).size > 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new WriteApprovalError(`The tenant approval batch could not be checked. No writes were sent. ${message}`)
  }
}

async function readSnapshot(policyPath: string, storageAccountName: string, storageToken: string, expected?: ManifestEntry): Promise<Item> {
  const response = await fetch(blobUrl(storageAccountName, policyPath), { headers: storageHeaders(storageToken) })
  if (!response.ok) throw new Error("Failed to fetch from backup")
  const snapshot = await response.json() as Item
  verifySnapshot(snapshot, expected)
  return snapshot
}

async function restoreSinglePolicy(restorer: Restorer, policyPath: string, storageAccountName: string, storageToken: string, expected?: ManifestEntry, repairToken?: string): Promise<RestoreOutcome> {
  try {
    if (repairToken) return await restorer.repair(policyPath, repairToken)
    return await restorer.restore(policyPath, await readSnapshot(policyPath, storageAccountName, storageToken, expected))
  } catch (error) {
    return { success: false, path: policyPath, error: error instanceof Error ? error.message : "Unknown error" }
  }
}

export async function POST(request: NextRequest) {
  let body: any
  try {
    body = await request.json()
    if (body.approvalAction === "check-destinations") {
      const { destinationIds } = body
      if (!Array.isArray(destinationIds) || destinationIds.length < 2 || destinationIds.length > 50 || !destinationIds.every(isGuid)) {
        return NextResponse.json({ error: "Choose the original restore destinations." }, { status: 400 })
      }
      return NextResponse.json({ grouped: await groupedApproval(destinationIds) })
    }
    if (body.approvalAction) return await approvalAction(body)
    if (body.justification !== undefined && (typeof body.justification !== "string" || body.justification.length > 700)) return NextResponse.json({ error: "Justification must be at most 700 characters" }, { status: 400 })
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
      targetTenants.some((t: any) => !guid.test(t?.tenantId ?? '') || (t.appId === undefined ? t.selectedPolicies === undefined || targetTenants.length < 2 : !guid.test(t.appId)) || String(t.tenantId).toLowerCase() === String(tenantId).toLowerCase()))) {
      return NextResponse.json({ error: 'Choose other connected tenants to copy to. Copies are created without assignments.' }, { status: 400 })
    }

    let dependencyMappings
    try { dependencyMappings = parseDependencyMappings(body.dependencyMappings) }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid dependency mappings" }, { status: 400 }) }
    if (dependencyMappings.length && (targetTenants?.length !== 1 || body.confirmMappings !== true)) return NextResponse.json({ error: "Review mappings and select exactly one target tenant" }, { status: 400 })
    type Selection = { path: string; repairToken?: string }
    type Destination = { tenantId: string; appId?: string; selectedPolicies?: Selection[] }
    const destinations = targetTenants as Destination[] | undefined
    const validSelections = (items: unknown): items is Selection[] => Array.isArray(items) && items.length > 0
      && items.every(item => validPolicyPath(item?.path, backupId) && (item.repairToken === undefined || typeof item.repairToken === "string" && guid.test(item.repairToken)))
      && new Set(items.map(item => item.path)).size === items.length
    const hasTargetSelections = destinations?.some(target => target.selectedPolicies !== undefined)
    const repairSelections: Selection[] = Array.isArray(selectedPolicies) ? selectedPolicies.filter((p: Selection) => p.repairToken !== undefined) : []
    if (destinations && new Set(destinations.map(target => target.tenantId.toLowerCase())).size !== destinations.length
      || hasTargetSelections && (restoreType !== "selective" || repairSelections.length > 0
        || !destinations?.every(target => validSelections(target.selectedPolicies)
          && target.selectedPolicies.every(item => selectedPolicies.some((policy: Selection) => policy.path === item.path))))
      || repairSelections.length > 0 && (restoreType !== "selective" || (destinations?.length ?? 0) > 1 || !validSelections(repairSelections))) {
      return NextResponse.json({ error: "Choose unique destinations and valid restore selections for each destination." }, { status: 400 })
    }
    const grouped = !!destinations && destinations.length > 1 && await groupedApproval(destinations.map(target => target.tenantId))
    if (hasTargetSelections && destinations!.length > 1 && !grouped) return NextResponse.json({ legacy: true })
    if (destinations?.some(target => !target.appId)) {
      return NextResponse.json({ error: "Reconnect all original destinations before applying this tenant approval batch." }, { status: 409 })
    }
    const repairScope = (target: string) => JSON.stringify([tenantId, storageAccountName, backupId, target.toLowerCase(), mode, assignments, dependencyMappings])

    // Get access tokens for both Storage and Graph API
    const [storageToken, graphToken] = await Promise.all([
      getAccessToken(tenantId, appId, clientSecret, "https://storage.azure.com/.default"),
      getAccessToken(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default")
    ])

    // A shared container can hold other tenants' backups; never restore one of those. Everyone who
    // can write to the backup container is trusted like an Intune admin, so every backup that names
    // this tenant supports each restore mode, and its manifest vouches for completeness and
    // fingerprints. A backup that records no tenant can only be restored as an unassigned copy.
    const owned = await readOwnedBackup((name) => fetch(blobUrl(storageAccountName, name), { headers: storageHeaders(storageToken) }), backupId, tenantId, storageAccountName)
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
    if (!owned.owned && (mode === 'replace' || assignments)) return NextResponse.json({ error: UNTAGGED_BACKUP }, { status: 400 })
    const metadata = owned.metadata

    // Correlate the completed operation with its desktop audit event.
    const jobId = randomUUID()

    // Start the restore process
    const startTime = new Date()
    const results: Array<RestoreOutcome & { targetTenantId?: string }> = []
    let restoredCount = 0
    let approvalCount = 0
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

    const targets = destinations
      ? await Promise.all(destinations.map(async (target) => {
          let token: string
          try {
            token = await getAccessToken(target.tenantId, target.appId!, clientSecret, "https://graph.microsoft.com/.default")
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { notSent: message, targetTenantId: target.tenantId.toLowerCase(), selection: target.selectedPolicies }
          }
          const graph = graphCaller(token, fetch, { tenant: target.tenantId, refreshToken: () => getAccessToken(target.tenantId, target.appId!, clientSecret, "https://graph.microsoft.com/.default", true) })
          const options = { writeApprovalTenant: target.tenantId, mode: "copy" as const, assignments: false, prefix: "", crossTenant: true, repairScope: repairScope(target.tenantId), granted: grantedPermissions(token) }
          return { targetTenantId: target.tenantId.toLowerCase(), restorer: new Restorer(graph, options), selection: target.selectedPolicies }
        }))
      : [{
          targetTenantId: undefined,
          restorer: new Restorer(graphCaller(graphToken, fetch, { tenant: tenantId, refreshToken: () => getAccessToken(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default", true) }),
            { writeApprovalTenant: tenantId, mode, assignments, approvalContext: requesterContext(graphToken, tenantId, body.justification), repairScope: repairScope(tenantId), granted: grantedPermissions(graphToken) }),
          selection: undefined,
        }]
    const readyTargets = targets.filter(target => target.restorer !== undefined)
    try {
      if (dependencyMappings.length) for (const { restorer } of readyTargets) await restorer.mapDependencies(dependencyMappings)
    } catch (error) {
      if (error instanceof DependencyMappingError && error.status === 404) return NextResponse.json({ error: error.message }, { status: 400 })
      throw error
    }

    const checked = checkRestoreManifest(metadata, backupId, paths, restoreType !== 'selective')
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 })
    const manifest = checked.manifest

    const admissions = readyTargets.map(target => {
      const ordered = restoreOrder(target.selection?.map(item => item.path) ?? paths)
      const repairs = new Map((target.selection ?? repairSelections).map(item => [item.path, item.repairToken]))
      const snapshots = new Map<string, { snapshot: Item; state: Awaited<ReturnType<Restorer["approvalObservation"]>> }>()
      const observePath = (path: string, snapshot: Item) => target.restorer.approvalObservation(path, snapshot, repairs.get(path))
      const summary: import("../../../../shared/write-approvals").WriteApprovalSummary = {
        kind: target.targetTenantId ? "Copy policies to another tenant" : mode === "replace" ? "Restore policies in place" : "Restore policy copies",
        count: ordered.length, reference: backupId, targets: ordered, assignments, mappings: dependencyMappings,
      }
      return {
        ...target, ordered, repairs, snapshots, observePath,
        operation: {
          tenant: target.targetTenantId ?? tenantId,
          reference: ["restore", tenantId, backupId, ordered, [...repairs]],
          summary,
          observe: async () => {
            verifyApprovalSource(tenantId, storageAccountName)
            const observed = []
            const planned: NonNullable<Parameters<Restorer["approvalObservation"]>[3]> = new Map()
            for (const path of ordered) {
              const snapshot = repairs.get(path) ? {} : await readSnapshot(path, storageAccountName, storageToken, manifest?.get(path))
              const state = await target.restorer.approvalObservation(path, snapshot, repairs.get(path), planned)
              if (state.creates) planned.set(state.creates.graphPath.toLowerCase(), { creation: path, sourceId: state.creates.sourceId })
              if (state.reuses) planned.set(state.reuses.graphPath.toLowerCase(), { creation: path, sourceId: state.reuses.sourceId, reused: state.reuses.reused })
              snapshots.set(path, { snapshot, state })
              observed.push(state)
            }
            const referenced = new Set(observed.flatMap(state => state.usesCreations ?? []))
            for (const [path, { state }] of snapshots) state.verifyCreation = referenced.has(path)
            summary.operations = observed.map(state => state.review)
            return {
              content: [tenantId, storageAccountName, backupId, mode, assignments, dependencyMappings, body.justification, observed.map(state => state.content)],
              target: observed.map(state => state.target),
            }
          },
        },
      }
    })
    const progress = progressId ? startProgress(progressId, targets.reduce((total, target) => total + (target.selection?.length ?? paths.length), 0)) : null
    const recordResult = (result: RestoreOutcome, targetTenantId?: string) => {
      const entry = targetTenantId ? { ...result, targetTenantId } : result
      results.push(entry)
      if (result.partial) partialCount++
      if (result.action === 'unchanged') unchangedCount++
      else if (result.success) restoredCount++
      else if (result.action === 'skipped') skippedCount++
      else if (result.approval) approvalCount++
      else failedCount++
      if (progress) {
        progress.done++
        progress.results.push(entry)
        progress.updatedAt = Date.now()
      }
    }
    const notSent = (items: string[], target: string | undefined, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      for (const path of items) recordResult({ path, success: false, writeNotSent: true, retryable: true, error: `Write not sent: ${message}` }, target)
    }
    const apply = async (batch: typeof admissions) => {
      let started = false
      try {
        await withWriteApproval(batch.map(entry => entry.operation), async () => {
          started = true
          for (const { restorer, targetTenantId, ordered, repairs, snapshots, observePath } of batch) {
            for (const path of ordered) {
              if (progress) progress.current = path
              const repair = repairs.get(path)
              const expected = snapshots.get(path)
              const active = hasWriteApproval(targetTenantId ?? tenantId)
              const check = active && expected && repair ? sameObservation(expected.state, () => observePath(path, expected.snapshot)) : undefined
              const result = active && expected
                ? expected.state.failure ?? (repair ? await restorer.repair(path, repair, check, expected.state.target) : await restorer.restore(path, expected.snapshot, undefined, expected.state))
                : await restoreSinglePolicy(restorer, path, storageAccountName, storageToken, manifest?.get(path), repair)
              recordResult(result, targetTenantId)
            }
          }
        })
      } catch (error) {
        if (started || error instanceof WriteApprovalError && error.reason && !results.length) throw error
        for (const { ordered, targetTenantId } of batch) notSent(ordered, targetTenantId, error)
      }
    }
    try {
      if (grouped) {
        const refused = targets.find(target => !target.restorer)
        if (refused) {
          for (const target of targets) notSent(target.selection?.map(item => item.path) ?? paths, target.targetTenantId,
            target.restorer ? "Another destination in this approval batch could not sign in." : target.notSent)
        } else await apply(admissions)
      } else if (!destinations) await apply(admissions)
      else {
        let next = 0
        for (const target of targets) {
          if (target.restorer) await apply([admissions[next++]!])
          else notSent(target.selection?.map(item => item.path) ?? paths, target.targetTenantId, target.notSent)
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
      success: failedCount === 0 && approvalCount === 0 && handled > 0,
      jobId: jobId,
      status: handled === 0 && approvalCount > 0 && failedCount === 0 && partialCount === 0 ? "AwaitingApproval" : partialCount > 0 || approvalCount > 0 ? "PartiallyCompleted" : handled === 0 ? "Failed" : failedCount > 0 ? "PartiallyCompleted" : "Completed",
      message: `${done}${approvalCount ? `; ${approvalCount} awaiting approval` : ""}; ${failedCount} failed${unchangedCount ? `; ${unchangedCount} already matched the backup` : ''}${skippedCount ? `; ${skippedCount} kept as reference only` : ''}`,
      details: {
        approvalCount,
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
    if (error instanceof WriteApprovalError) return NextResponse.json({ error: error.message }, { status: 409 })
    console.error("Restore backup error:", error)

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error while restoring" },
      { status: 500 }
    )
  }
}

const approvalLocks = new Set<string>()
export function requesterContext(token: string, tenantId: string, justification?: string) {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"))
    if (typeof claims.oid === "string" && claims.scp && typeof claims.tid === "string" && claims.tid.toLowerCase() === tenantId.toLowerCase()) return { tenantId, requesterId: claims.oid as string, requesterName: typeof claims.name === "string" ? claims.name : typeof claims.preferred_username === "string" ? claims.preferred_username : typeof claims.upn === "string" ? claims.upn : undefined, justification }
  } catch { /* No approval flow without a delegated requester identity. */ }
  return undefined
}

async function approvalAction(body: any): Promise<Response> {
  const { tenantId, appId, clientSecret, approvalAction: action, approvalId } = body
  if (typeof tenantId !== "string" || !/^[0-9a-f-]{36}$/i.test(tenantId) || !appId || !clientSecret) return NextResponse.json({ error: "Tenant credentials are required" }, { status: 400 })
  if (action === "list" && !body.refresh) return NextResponse.json({ records: restoreApprovals(tenantId).map(record => approvalRow(record, false)) })
  const token = await getAccessToken(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default")
  const context = requesterContext(token, tenantId)
  const graph = graphCaller(token, fetch, { tenant: tenantId, refreshToken: () => getAccessToken(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default", true) })
  if (action === "detect") {
    try {
      const result = await graph("GET", "deviceManagement/operationApprovalPolicies?$top=1")
      return NextResponse.json({ enabled: result.status === 200 && Array.isArray(result.body.value) && result.body.value.length > 0 })
    } catch { return NextResponse.json({ enabled: false }) }
  }
  if (!context) return NextResponse.json({ error: "Sign in with the requester account to manage restore approvals" }, { status: 403 })
  const restorer = new Restorer(graph, { writeApprovalTenant: tenantId, mode: "copy", assignments: false, approvalContext: context })
  if (action === "list") {
    const records = restoreApprovals(tenantId).filter(record => !(record.status === "completed" && record.stepNumber === 0))
    const refreshed = await Promise.all(records.map(async record => {
      try { return body.refresh ? await restorer.refreshApproval(record) : record } catch { return record }
    }))
    const protectedContinuations = refreshed.some(record => record.continuationPending && !record.continuationFingerprint)
      && await approvalsEnabled(tenantId).catch(() => false)
    return NextResponse.json({ records: refreshed.map(record => approvalRow(record, record.requesterId.toLowerCase() === context.requesterId.toLowerCase(), protectedContinuations)) })
  }
  const record = restoreApprovals(tenantId).find(entry => entry.id === approvalId)
  if (!record) return NextResponse.json({ error: "Request not found" }, { status: 404 })
  const key = `${tenantId.toLowerCase()}:${record.id}`
  if (approvalLocks.has(key)) return NextResponse.json({ error: "This request is already being processed" }, { status: 409 })
  approvalLocks.add(key)
  try {
    if (action === "dismiss") {
      if (record.status !== "justification-required" && record.requesterId.toLowerCase() !== context.requesterId.toLowerCase()) throw new Error("Only the original requester can dismiss this request")
      dismissRestoreApproval(tenantId, record.id)
    }
    else if (action === "submit" || action === "complete") {
      if (record.requesterId.toLowerCase() !== context.requesterId.toLowerCase()) throw new Error("Only the original requester can use this Intune request.")
      let expected: unknown
      const observe = () => restorer.pendingApprovalObservation(record, action)
      const summary: import("../../../../shared/write-approvals").WriteApprovalSummary = {
        kind: action === "submit" ? "Submit Intune approval" : "Complete Intune approval",
        count: record.remaining.length + (record.continuationPending ? 0 : 1), reference: record.id, targets: [record.label], assignments: record.assignments,
      }
      return await withWriteApproval([{
        tenant: tenantId, reference: ["intune-approval", action, record.id], summary,
        observe: async () => {
          const observation = await observe()
          summary.operations = [observation.review]
          expected = observation.target
          return { ...observation, content: [observation.content, action, body.justification ?? record.justification] }
        },
      }], async () => {
        const check = hasWriteApproval(tenantId) ? sameObservation(expected, async () => (await observe()).target) : undefined
        return NextResponse.json({ outcome: action === "submit" ? await restorer.submitApproval(record, body.justification, check, expected) : await restorer.completeApproval(record, check, expected) })
      })
    }
    else if (action === "withdraw") {
      if (record.requesterId.toLowerCase() !== context.requesterId.toLowerCase()) throw new Error("Only the original requester can withdraw this request")
      try {
        if (!record.continuationPending || record.continuationFingerprint || !await approvalsEnabled(tenantId).catch(() => false)) {
          const response = await withExemptGraphCaller("restore-withdraw", () => graph("POST", "deviceManagement/operationApprovalRequests/cancelMyRequest", { id: record.id }))
          if (response.status !== 204) throw new Error("Withdraw refused")
        }
      } catch {
        const latest = await restorer.refreshApproval(record)
        throw new Error(`Intune refused to withdraw this request. Current status: ${latest.status}`)
      }
      saveRestoreApproval({ ...record, status: "cancelled" })
    } else return NextResponse.json({ error: "Unknown approval action" }, { status: 400 })
    return NextResponse.json({ success: true })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }) }
  finally { approvalLocks.delete(key) }
}

function approvalRow(record: import("../../../../main/storage/restore-approvals").RestoreApproval, canComplete: boolean, protectedContinuations = false) {
  return { id: record.id, label: record.label, operation: record.operation, status: record.status, approverNote: record.approverNote, expiresAt: record.expiresAt, stepNumber: record.stepNumber, totalSteps: record.totalSteps, canComplete, legacyContinuation: protectedContinuations && record.continuationPending && !record.continuationFingerprint, requesterName: record.requesterName }
}
