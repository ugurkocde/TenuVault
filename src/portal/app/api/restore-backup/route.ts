import { auditUserFromToken, mainAuditSink } from "../../../../main/api/audit-sink"
import { AuditEventType, type AuditJobItem } from "~/lib/audit/types"
import { beginRestoreAudit, restoreAuditItem } from "~/lib/audit/restore"
import { restoreApprovals, dismissRestoreApproval, saveRestoreApproval } from "../../../../main/storage/restore-approvals"
import { parseDependencyMappings } from "../../../../shared/intune/recovery"
import { createHash, randomUUID } from "node:crypto"
import { checkRestoreManifest, verifySnapshot, type ManifestEntry } from "~/lib/policies/backup-manifest"
import { readOwnedBackup, UNTAGGED_BACKUP } from "~/lib/policies/backup-owner"
import { validPolicyPath } from "~/lib/policies/restore"
import { graphCaller, Restorer, ApprovalCompletionRefused, DependencyMappingError, RestoreReconcileRequired, type RestoreOutcome } from "~/lib/policies/graph-restore"
import { PROGRESS_ID, startProgress } from "~/lib/policies/restore-progress"
import { restoreOrder, type Item } from "../../../../shared/intune/registry"
import { grantedPermissions } from "../../../../shared/services/token"
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
      new Set(targetTenants.map((t: any) => String(t?.tenantId).toLowerCase())).size !== targetTenants.length ||
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
    const actor = auditUserFromToken(graphToken, tenantId)?.id.toLowerCase()
    const repairScope = (target: string) => JSON.stringify([tenantId, storageAccountName, backupId, target.toLowerCase(), mode, assignments, dependencyMappings, actor])
    const correlationSource = JSON.stringify([String(tenantId).toLowerCase(), storageAccountName, backupId])
    const destinations: string[] = targetTenants?.map((target: { tenantId: string }) => target.tenantId.toLowerCase()) ?? [tenantId.toLowerCase()]
    const prior = actor && typeof body.retryOf === "string" && guid.test(body.retryOf) ? mainAuditSink()?.restoreCorrelation(body.retryOf) : undefined
    const correlated = prior?.actor === actor && prior?.source === correlationSource && destinations.every(id => prior.destinations.includes(id))
      && Date.now() - prior.at < 60 * 60_000 ? prior.operationId : jobId

    // Start the restore process
    const startTime = new Date()
    const results = []
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

    const auditProgress: { save?: (result: RestoreOutcome) => void; submitted?: (result: RestoreOutcome) => void } = {}
    const onProgress = (result: RestoreOutcome) => auditProgress.save?.(result)
    const onSubmitted = (result: RestoreOutcome) => auditProgress.submitted?.(result)
    const targets: Array<{ restorer?: Restorer; graphToken?: string; targetTenantId?: string }> = targetTenants
      ? await Promise.all((targetTenants as Array<{ tenantId: string; appId: string }>).map(async (target) => {
          const targetToken = await getAccessToken(target.tenantId, target.appId, clientSecret, "https://graph.microsoft.com/.default").catch(() => undefined)
          if (!targetToken) return { targetTenantId: target.tenantId.toLowerCase() }
          return {
            targetTenantId: target.tenantId.toLowerCase(), graphToken: targetToken,
            restorer: new Restorer(graphCaller(targetToken, fetch, { tenant: target.tenantId, refreshToken: () => getAccessToken(target.tenantId, target.appId, clientSecret, "https://graph.microsoft.com/.default", true) }),
              { mode: 'copy', assignments: false, prefix: '', crossTenant: true, repairScope: repairScope(target.tenantId), granted: grantedPermissions(targetToken), operationId: correlated, auditProgress: onProgress, auditSubmitted: onSubmitted }),
          }
        }))
      : [{ graphToken, restorer: new Restorer(graphCaller(graphToken, fetch, { tenant: tenantId, refreshToken: () => getAccessToken(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default", true) }), { mode, assignments, approvalContext: requesterContext(graphToken, tenantId, body.justification), repairScope: repairScope(tenantId), granted: grantedPermissions(graphToken), operationId: correlated, auditProgress: onProgress, auditSubmitted: onSubmitted }) }]
    try {
      if (dependencyMappings.length) for (const { restorer } of targets) await restorer?.mapDependencies(dependencyMappings)
    } catch (error) {
      if (error instanceof DependencyMappingError && error.status === 404) return NextResponse.json({ error: error.message }, { status: 400 })
      throw error
    }

    const checked = checkRestoreManifest(metadata, backupId, paths, restoreType !== 'selective')
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 })
    const manifest = checked.manifest

    const progress = progressId ? startProgress(progressId, paths.length * targets.length) : null
    try {
      const ordered = restoreOrder(paths)
      for (const { restorer, targetTenantId, graphToken: targetToken } of targets) {
        const firstRepair = repairSelections[0]
        const operationId = (firstRepair && restorer?.repairOperationId(firstRepair.path, firstRepair.repairToken)) || correlated
        const audit = beginRestoreAudit({
          destination: targetTenantId ?? tenantId, graphToken: targetToken, sourceBackupId: backupId, operationId, runId: jobId,
          correlation: actor ? { actor, source: correlationSource, destinations, operationId: correlated, at: Date.now() } : undefined,
          action: mode === 'replace' ? 'Restore backup in place' : 'Restore backup as policy copies',
          items: ordered.map(path => restoreAuditItem(path, undefined, manifest?.get(path)?.id)),
        })
        const submitted: AuditJobItem[] = []
        try {
          for (const [index, path] of ordered.entries()) {
            if (progress) progress.current = path
            const sourceId = manifest?.get(path)?.id
            if (restorer) audit?.started(index)
            auditProgress.save = result => audit?.item(index, restoreAuditItem(path, result, sourceId))
            auditProgress.submitted = result => submitted.push(restoreAuditItem(path, result, sourceId))
            const result = restorer
              ? await restoreSinglePolicy(restorer, path, storageAccountName, storageToken, manifest?.get(path), repairSelections.find((p: any) => p.path === path)?.repairToken)
              : { success: false, path, error: "Could not sign in to the destination tenant." }
            auditProgress.save(result)
            auditProgress.save = undefined
            auditProgress.submitted = undefined
            const entry = { ...result, targetTenantId, retryJobId: jobId }
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
        } finally {
          if (submitted.length) {
            beginRestoreAudit({
              destination: targetTenantId ?? tenantId, graphToken: targetToken, sourceBackupId: backupId,
              operationId, runId: jobId, stage: "approval-submit", action: "Restore submitted for approval",
              eventType: AuditEventType.CONFIG_UPDATED, items: submitted,
            })?.finish()
          }
          audit?.finish()
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
    console.error("Restore backup could not finish")

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
  if (action === "list") {
    const restorer = new Restorer(graph, { mode: "copy", assignments: false, approvalContext: context })
    const records = restoreApprovals(tenantId).filter(record => !(record.status === "completed" && record.stepNumber === 0))
    const refreshed = await Promise.all(records.map(async record => {
      try { return body.refresh ? await restorer.refreshApproval(record) : record } catch { return record }
    }))
    return NextResponse.json({ records: refreshed.map(record => approvalRow(record, record.requesterId.toLowerCase() === context.requesterId.toLowerCase())) })
  }
  const record = restoreApprovals(tenantId).find(entry => entry.id === approvalId)
  if (!record) return NextResponse.json({ error: "Request not found" }, { status: 404 })
  const completion = action === "complete"
  if (completion && record.requesterId.toLowerCase() !== context.requesterId.toLowerCase()) {
    return NextResponse.json({ error: "Only the original requester can complete this request" }, { status: 409 })
  }
  if (completion && record.status === "completed" && !record.continuationPending) return NextResponse.json({ error: "This request was already completed" }, { status: 409 })
  const key = `${tenantId.toLowerCase()}:${record.id}`
  if (approvalLocks.has(key)) return NextResponse.json({ error: "This request is already being processed" }, { status: 409 })
  approvalLocks.add(key)
  const stage = action === "submit" ? "approval-submit" : action === "complete" ? "approval-complete" : "approval-withdraw"
  const eventId = completion ? createHash("sha256").update(`approval-complete:${tenantId.toLowerCase()}:${record.id.toLowerCase()}`).digest("hex") : undefined
  const approval = record.auditApprover ?? { system: "intune" as const, requestId: record.id }
  const initialItem = { ...restoreAuditItem(record.backupPath, undefined, record.snapshotId), ...(completion ? { approval } : {}) }
  const audit = ["submit", "complete", "withdraw"].includes(action) ? beginRestoreAudit({
    destination: tenantId, graphToken: token, sourceBackupId: record.backupPath.split("/")[0]!,
    operationId: record.operationId ?? record.id, stage, eventId, runId: eventId,
    eventType: action === "complete" ? AuditEventType.RESTORE_COMPLETED : AuditEventType.CONFIG_UPDATED,
    action: action === "submit" ? "Restore submitted for approval" : action === "complete" ? "Complete approved restore item" : "Approval request withdrawn",
    items: [initialItem],
  }) : undefined
  if (!completion) audit?.started(0)
  const capture = (outcome: RestoreOutcome) => {
    audit?.item(0, restoreAuditItem(record.backupPath, outcome, record.snapshotId))
    return outcome
  }
  let completionDispatched = false
  let completionProgress: RestoreOutcome | undefined
  const restorer = new Restorer(graph, {
    mode: "copy", assignments: false, approvalContext: context, operationId: record.operationId ?? record.id,
    auditApprovalDispatched: () => {
      completionDispatched = true
      audit?.started(0)
    },
    auditProgress: outcome => {
      if (!completion) return
      completionProgress = outcome
      capture(outcome)
    },
    auditApprovalCompleted: outcome => {
      if (!completion) return
      audit?.ready(0, restoreAuditItem(record.backupPath, outcome, record.snapshotId))
    },
    auditSubmitted: outcome => {
      if (action === "submit") {
        capture(outcome)
        audit?.finish()
        return
      }
      if (completion) beginRestoreAudit({
        destination: tenantId, graphToken: token, sourceBackupId: record.backupPath.split("/")[0]!,
        operationId: record.operationId ?? record.id, stage: "approval-submit", action: "Restore submitted for approval",
        eventType: AuditEventType.CONFIG_UPDATED, items: [restoreAuditItem(record.backupPath, outcome, record.snapshotId)],
      })?.finish()
    },
  })
  try {
    if (action === "dismiss") {
      if (record.status !== "justification-required" && record.requesterId.toLowerCase() !== context.requesterId.toLowerCase()) throw new Error("Only the original requester can dismiss this request")
      dismissRestoreApproval(tenantId, record.id)
    }
    else if (action === "submit") return NextResponse.json({ outcome: capture(await restorer.submitApproval(record, body.justification)) })
    else if (completion) {
      if (record.status === "completed" || (eventId && mainAuditSink()?.approvalCompletionReady(eventId))) {
        if (record.continuationPending) saveRestoreApproval({ ...record, status: "completed", continuationPending: false })
        return NextResponse.json({ error: "This request was already completed" }, { status: 409 })
      }
      return NextResponse.json({ outcome: await restorer.completeApproval(record) })
    }
    else if (action === "withdraw") {
      if (record.requesterId.toLowerCase() !== context.requesterId.toLowerCase()) throw new Error("Only the original requester can withdraw this request")
      try {
        const response = await graph("POST", "deviceManagement/operationApprovalRequests/cancelMyRequest", { id: record.id })
        if (response.status !== 204) throw new Error("Withdraw refused")
      } catch {
        const latest = await restorer.refreshApproval(record)
        throw new Error(`Intune refused to withdraw this request. Current status: ${latest.status}`)
      }
      saveRestoreApproval({ ...record, status: "cancelled" })
      capture({ success: true, path: record.backupPath, action: "unchanged", auditApprover: record.auditApprover ?? { system: "intune", requestId: record.id } })
    } else return NextResponse.json({ error: "Unknown approval action" }, { status: 400 })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (completion && !completionProgress) {
      const refused = !completionDispatched || error instanceof ApprovalCompletionRefused
      const reason = error instanceof RestoreReconcileRequired ? "RECONCILE_REQUIRED" : "APPROVAL_COMPLETION_REFUSED"
      if (refused) audit?.refuse(0, { ...initialItem, outcome: "failed", reason })
      else audit?.item(0, { ...initialItem, outcome: "uncertain", reason: "WRITE_UNCONFIRMED" })
    }
    if (error instanceof ApprovalCompletionRefused) {
      return NextResponse.json({ error: error.message, code: "APPROVAL_COMPLETION_REFUSED" }, { status: error.status })
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 })
  } finally {
    audit?.finish()
    approvalLocks.delete(key)
  }
}

function approvalRow(record: import("../../../../main/storage/restore-approvals").RestoreApproval, canComplete: boolean) {
  return { id: record.id, label: record.label, operation: record.operation, status: record.status, approverNote: record.approverNote, expiresAt: record.expiresAt, stepNumber: record.stepNumber, totalSteps: record.totalSteps, canComplete, requesterName: record.requesterName }
}
