import { APPLICATION_REVIEW_FOLDERS, DIRECTORY_REVIEW_FOLDERS, PRIVILEGED_REVIEW_FOLDERS } from "../../../../shared/intune/directory-review-folders"
import { NextResponse, type NextRequest } from "next/server"
import { backupStoragePath } from "../../../../shared/backup-storage"
import { typeForFolder, restoreCapability, type Item } from "../../../../shared/intune/registry"
import { readOwnedBackup } from "~/lib/policies/backup-owner"
import { validPolicyPath } from "~/lib/policies/restore"
import { directoryRestoreOperation, directoryRestoreRequest, directoryRestoreVerifyOwner } from "../../../../main/restore/directory-dispatch"

async function token(tenantId: string, appId: string, clientSecret: string, scope: string) {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope, grant_type: "client_credentials" }) })
  if (!response.ok) throw new Error("Sign in again before restoring.")
  return (await response.json()).access_token as string
}
function outcomeResponse(result: Awaited<ReturnType<typeof directoryRestoreRequest>>) {
  if (!("status" in result)) return NextResponse.json(result)
  const restoredCount = result.outcomes.filter(row => row.state === "applied").length
  const partialCount = result.outcomes.filter(row => ["pending", "captured", "deferred", "uncertain"].includes(row.state)).length
  return NextResponse.json({ ...result, success: result.status === "complete", partial: result.status === "partial", details: { restoredCount, partialCount, failedCount: result.failed, duration: 0, results: [] } })
}
/** One owned directory object with bounded, individually approved relationship pages. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const { tenantId, appId, clientSecret, storageAccountName, backupId, path, action } = body
  if (["reconcile", "discard", "cancel"].includes(action)) {
    if (![tenantId, appId, clientSecret, body.runId].every(value => typeof value === "string" && value)) return NextResponse.json({ error: "Enter the saved directory page ID." }, { status: 400 })
    try {
      const result = await directoryRestoreRequest(tenantId, { path: "", snapshot: {}, origin: "restore", runId: body.runId }, { action, options: { stage: "object", exactMembers: false, exactOwners: false } }, async () => { throw new Error("Saved-page actions do not read backups.") })
      return action === "reconcile" ? outcomeResponse(result) : NextResponse.json(result)
    } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "The saved directory page could not be read." }, { status: 409 }) }
  }
  if (![tenantId, appId, clientSecret, storageAccountName, backupId, path].every(value => typeof value === "string" && value) || !/^[a-zA-Z0-9_-]+$/.test(backupId) || !validPolicyPath(path, backupId) || !["preview", "restore", "cancel", "resume", "reconcile", "discard"].includes(action) || !["object", "relationships"].includes(body.stage)) return NextResponse.json({ error: "Choose one directory object from this backup." }, { status: 400 })
  const type = typeForFolder(path.split("/")[1] ?? "")
  if (!type || !DIRECTORY_REVIEW_FOLDERS.includes(type.folder) || (!APPLICATION_REVIEW_FOLDERS.includes(type.folder) && !PRIVILEGED_REVIEW_FOLDERS.includes(type.folder) && ["none", "metadata"].includes(restoreCapability(type)))) return NextResponse.json({ error: "This type remains backup-only." }, { status: 409 })
  const perform = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const storageToken = await token(tenantId, appId, clientSecret, "https://storage.azure.com/.default")
    signal?.throwIfAborted()
    const read = (name: string) => fetch(`https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(name)}`, { headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${storageToken}` }, signal })
    const owned = await readOwnedBackup(read, backupId, tenantId, storageAccountName)
    signal?.throwIfAborted()
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
    if (!owned.owned) throw new Error("This backup must identify the connected tenant.")
    if (!owned.metadata) throw new Error("The backup provenance could not be read. Directory restore requires its backup metadata.")
    // Ownership markers also place imports in this tenant's store. Only the manifest
    // records that provenance; renderer inputs and local ownership cannot replace it.
    const origin = Object.hasOwn(owned.metadata, "Import") ? "import" : "restore"
    const response = await read(path)
    if (!response.ok) throw new Error("The backup policy could not be read.")
    const snapshot = await response.json() as Item
    signal?.throwIfAborted()
    if (action === "preview" && typeof body.previousRunId === "string") await directoryRestoreVerifyOwner(tenantId, body.previousRunId)
    const restore = { path, snapshot, origin, runId: typeof body.runId === "string" ? body.runId : undefined } as const
    const result = await directoryRestoreRequest(tenantId, restore, { action, options: { stage: body.stage, exactMembers: body.exactMembers === true, exactOwners: body.exactOwners === true, ...(typeof body.previousRunId === "string" ? { previousRunId: body.previousRunId } : {}) }, fingerprint: body.fingerprint, approvals: body.approvals }, async name => {
      const response = await read(name)
      if (!response.ok) throw new Error("A backup relationship shard could not be read.")
      signal?.throwIfAborted()
      return response.json()
    }, signal)
    return action === "restore" ? outcomeResponse(result) : NextResponse.json(result)
  }
  try {
    if (action === "restore" || action === "resume") {
      if (typeof body.runId !== "string") throw new Error("Review this directory object first.")
      const result = await directoryRestoreOperation(tenantId, body.runId, perform)
      return result instanceof Response ? result : NextResponse.json(result)
    }
    if (action === "preview" && typeof body.previousRunId === "string") await directoryRestoreVerifyOwner(tenantId, body.previousRunId)
    return await perform()
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "This directory restore could not finish." }, { status: 409 }) }
}
