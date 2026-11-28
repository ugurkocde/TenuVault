import { backupOnlyRestoreMessage } from "../../../../shared/intune/restore-availability"
import { PlanRequired } from "../../../../shared/plans"
import { NextResponse, type NextRequest } from "next/server"
import { backupStoragePath } from "../../../../shared/backup-storage"
import { typeForFolder, restoreCapability, type Item } from "../../../../shared/intune/registry"
import { readOwnedBackup } from "~/lib/policies/backup-owner"
import { validPolicyPath } from "~/lib/policies/restore"
import { graphCaller } from "~/lib/policies/graph-restore"
import { previewIdentityRestore, confirmIdentityRestore } from "../../../../main/restore/dispatch"

async function token(tenantId: string, appId: string, clientSecret: string, scope: string) {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: appId, client_secret: clientSecret, scope, grant_type: "client_credentials" }) })
  if (!response.ok) throw new Error("Sign in again before restoring.")
  return (await response.json()).access_token as string
}
/** One owned backup policy, one immutable preview and one confirmation. No bulk caller. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const { tenantId, appId, clientSecret, storageAccountName, backupId, path, action, operation } = body
  if (![tenantId, appId, clientSecret, storageAccountName, backupId, path].every(value => typeof value === "string" && value) || !/^[a-zA-Z0-9_-]+$/.test(backupId) || !validPolicyPath(path, backupId) || !["preview", "restore"].includes(action) || !["create", "update"].includes(operation)) return NextResponse.json({ error: "Choose one configuration policy from this backup." }, { status: 400 })
  const folder = path.split("/")[1] ?? ""
  const backupOnly = backupOnlyRestoreMessage(folder)
  if (backupOnly) return NextResponse.json({ error: backupOnly }, { status: 422 })
  const type = typeForFolder(folder)
  if (!type || type.restoreSafety !== "identity" || ["none", "metadata"].includes(restoreCapability(type))) return NextResponse.json({ error: "This type remains backup-only." }, { status: 409 })
  try {
    const [storageToken, graphToken] = await Promise.all([token(tenantId, appId, clientSecret, "https://storage.azure.com/.default"), token(tenantId, appId, clientSecret, "https://graph.microsoft.com/.default")])
    const read = (name: string) => fetch(`https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(name)}`, { headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${storageToken}` } })
    const owned = await readOwnedBackup(read, backupId, tenantId, storageAccountName)
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
    if (!owned.owned) throw new Error("This backup must identify the connected tenant.")
    const response = await read(path)
    if (!response.ok) throw new Error("The backup policy could not be read.")
    const snapshot = await response.json() as Item
    const graph = graphCaller(graphToken, fetch, { tenant: tenantId })
    const restore = { path, snapshot, origin: "restore" as const, runId: typeof body.runId === "string" ? body.runId : undefined }
    if (action === "preview") return NextResponse.json(await previewIdentityRestore(graph, restore, operation, body.allowRemoval === true))
    if (typeof body.fingerprint !== "string") throw new Error("Review the exact difference first.")
    const outcome = await confirmIdentityRestore(graph, restore, body.fingerprint)
    return NextResponse.json({ ...outcome, details: { restoredCount: outcome.success ? 1 : 0, failedCount: !outcome.success && !outcome.partial ? 1 : 0, partialCount: outcome.partial ? 1 : 0, duration: 0, results: [outcome] } })
  } catch (error) {
    // A plan that lapsed after the preview is refused at execution with the same prompt as the route gate.
    if (error instanceof PlanRequired) return NextResponse.json({ error: error.message, upgrade: error.feature }, { status: 402 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "This configuration restore could not finish." }, { status: 409 })
  }
}
