import { assignmentDirectory, assignmentReviewer, parseAssignmentMappings, parseSkippedAssignments } from "~/lib/policies/assignment-review"
import { graphCaller } from "~/lib/policies/graph-restore"
import { isGuid } from "../../../../shared/security"
import { type NextRequest, NextResponse } from "next/server"
import { decodeXml, listBlobPages } from "~/lib/storage/list"
import { validPolicyPath } from "~/lib/policies/restore"
import { validateBackup, type SnapshotRead } from "~/lib/policies/restore-validation"
import { readOwnedBackup } from "~/lib/policies/backup-owner"
import type { Item } from "../../../../shared/intune/registry"

const blobUrl = (storageAccountName: string, name: string) => `https://${storageAccountName}.blob.core.windows.net/intune-backups/${name.split("/").map(encodeURIComponent).join("/")}`
const storageHeaders = (storageToken: string) => ({ "x-ms-version": "2021-12-02", Authorization: `Bearer ${storageToken}` })

async function readToken(tenantId: string, appId: string, clientSecret: string, scope = "https://storage.azure.com/.default"): Promise<string> {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope, grant_type: "client_credentials" }),
  })
  if (!response.ok) throw new Error("Failed to get access token")
  return ((await response.json()) as { access_token: string }).access_token
}

/**
 * Restore dry run: validates a whole backup end to end without changing anything:
 *   POST /api/restore-validate { tenantId, appId, clientSecret, storageAccountName, backupId }
 * With liveAssignmentTargets, it also reads the groups, filters and scope tags of the selected tenant(s).
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const { tenantId, appId, clientSecret, storageAccountName, backupId } = body as {
    tenantId?: string; appId?: string; clientSecret?: string; storageAccountName?: string; backupId?: string
  }
  if (!tenantId || !appId || !clientSecret || !storageAccountName || !backupId || !/^[a-zA-Z0-9_-]+$/.test(backupId)) {
    return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
  }

  try {
    const token = await readToken(tenantId, appId, clientSecret)

    const listUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=${encodeURIComponent(`${backupId}/`)}`
    const xml = await listBlobPages(listUrl, token)
    const listedPaths: string[] = []
    for (const match of xml.matchAll(/<Blob>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<\/Blob>/g)) {
      const name = decodeXml(match[1] ?? "")
      if (validPolicyPath(name, backupId)) listedPaths.push(name)
    }

    const owned = await readOwnedBackup((name) => fetch(blobUrl(storageAccountName, name), { headers: storageHeaders(token) }), backupId, tenantId)
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
    const metadata = owned.metadata

    const readSnapshot = async (path: string): Promise<SnapshotRead> => {
      let response: Response
      try {
        response = await fetch(blobUrl(storageAccountName, path), { headers: storageHeaders(token) })
      } catch (error) {
        return { ok: false, error: `The backup file could not be read: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (!response.ok) return { ok: false, error: "The backup file could not be read." }
      try {
        const snapshot = (await response.json()) as Item
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return { ok: false, error: "The backup file is not a policy object." }
        return { ok: true, snapshot }
      } catch {
        return { ok: false, error: "The backup file could not be parsed. It may be damaged." }
      }
    }

    const sourceId = tenantId.toLowerCase()
    const cross = body.targetTenants !== undefined
    let targets = [{ tenantId: sourceId, appId }]
    if (cross) {
      if (body.liveAssignmentTargets !== true || !Array.isArray(body.targetTenants) || !body.targetTenants.length || body.targetTenants.length > 50 ||
        body.targetTenants.some((target) => !isGuid(target?.tenantId) || !isGuid(target?.appId) || target.tenantId.toLowerCase() === sourceId)) {
        return NextResponse.json({ error: "Choose connected destination tenants." }, { status: 400 })
      }
      targets = body.targetTenants.map((target) => ({ tenantId: target.tenantId.toLowerCase(), appId: target.appId }))
    }
    let mappings, skipped
    try {
      mappings = parseAssignmentMappings(body.assignmentMappings, targets.map((target) => target.tenantId))
      skipped = parseSkippedAssignments(body.skippedAssignments, listedPaths)
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid assignment review options." }, { status: 400 })
    }
    const directory = async (id: string, client: string) => assignmentDirectory(graphCaller(await readToken(id, client, clientSecret, "https://graph.microsoft.com/.default")))
    const sourceDirectory = body.liveAssignmentTargets === true && owned.owned ? await directory(tenantId, appId) : undefined
    const reviewers = sourceDirectory ? await Promise.all(targets.map(async (target) => ({
      id: target.tenantId,
      reader: assignmentReviewer(sourceDirectory, cross ? await directory(target.tenantId, target.appId) : sourceDirectory,
        metadata, !cross, mappings[target.tenantId] ?? [], skipped),
    }))) : []
    const report = await validateBackup({
      backupId, metadata, listedPaths, readSnapshot,
      checkAssignmentTargets: reviewers.length ? async (path, snapshot) => {
        const failures = await Promise.all(reviewers.map(async ({ id, reader }) => {
          const errors = (await reader.review(path, snapshot))?.review.errors ?? []
          return errors.length ? `${cross ? `Destination ${id}. ` : ""}${errors.join(" ")}` : ""
        }))
        return failures.filter(Boolean).join(" ") || undefined
      } : undefined,
    })
    return NextResponse.json(report)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The backup validation failed." }, { status: 500 })
  }
}
