import { NextResponse, type NextRequest } from "next/server"
import { backupStoragePath } from "../../../../shared/backup-storage"
import { typeForFolder, restoreCapability, type Item } from "../../../../shared/intune/registry"
import { readOwnedBackup } from "~/lib/policies/backup-owner"
import { validPolicyPath } from "~/lib/policies/restore"
import { directoryRestoreRequest } from "../../../../main/restore/directory-dispatch"

async function token(tenantId: string, appId: string, clientSecret: string, scope: string) {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope, grant_type: "client_credentials" }) })
  if (!response.ok) throw new Error("Sign in again before restoring.")
  return (await response.json()).access_token as string
}
/** One owned directory object with bounded, individually approved relationship pages. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const { tenantId, appId, clientSecret, storageAccountName, backupId, path, action } = body
  if (![tenantId, appId, clientSecret, storageAccountName, backupId, path].every(value => typeof value === "string" && value) || !/^[a-zA-Z0-9_-]+$/.test(backupId) || !validPolicyPath(path, backupId) || !["preview", "restore", "cancel", "resume"].includes(action) || !["object", "relationships"].includes(body.stage)) return NextResponse.json({ error: "Choose one directory object from this backup." }, { status: 400 })
  const type = typeForFolder(path.split("/")[1] ?? "")
  if (!type || !["Users", "Groups"].includes(type.folder) || ["none", "metadata"].includes(restoreCapability(type))) return NextResponse.json({ error: "This type remains backup-only." }, { status: 409 })
  try {
    const storageToken = await token(tenantId, appId, clientSecret, "https://storage.azure.com/.default")
    const read = (name: string) => fetch(`https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(name)}`, { headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${storageToken}` } })
    const owned = await readOwnedBackup(read, backupId, tenantId, storageAccountName)
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
    if (!owned.owned) throw new Error("This backup must identify the connected tenant.")
    const response = await read(path)
    if (!response.ok) throw new Error("The backup policy could not be read.")
    const snapshot = await response.json() as Item
    const restore = { path, snapshot, origin: "restore" as const, runId: typeof body.runId === "string" ? body.runId : undefined }
    const result = await directoryRestoreRequest(tenantId, restore, { action, options: { stage: body.stage, exactMembers: body.exactMembers === true, exactOwners: body.exactOwners === true, ...(typeof body.previousRunId === "string" ? { previousRunId: body.previousRunId } : {}) }, fingerprint: body.fingerprint, approvals: body.approvals }, async name => {
      const response = await read(name)
      if (!response.ok) throw new Error("A backup relationship shard could not be read.")
      return response.json()
    })
    if (action === "restore" && "outcomes" in result) {
      const restoredCount = result.outcomes.filter(row => row.state === "applied").length
      const partialCount = result.outcomes.filter(row => ["pending", "captured", "uncertain"].includes(row.state)).length
      return NextResponse.json({ ...result, success: result.status === "complete", partial: result.status === "partial", details: { restoredCount, partialCount, failedCount: result.failed, duration: 0, results: [] } })
    }
    return NextResponse.json(result)
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "This directory restore could not finish." }, { status: 409 }) }
}
