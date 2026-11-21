import { FetchPreconditionError } from "../api/network-error"
import { hasWriteApproval, withWriteApproval } from "../write-approvals/service"
import { sameObservation, withWriteCheckpoint } from "../write-approvals/dispatch"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { AppRestoreProgress, AppRestoreResult, CapturedAppSource } from "../../shared/app-sources/types"
import type { AppSourceStore } from "../app-sources/store"
import type { ContentEncryption } from "./content-stream"
import { encryptRestoreContent, newRestoreSecrets, type RestoreSecrets } from "./restore-encryption"
import { putRestoreBlock, type RestoreGraph } from "./restore-graph"
import { assertRestoredSettings, restoreBody, snapshotHash, type AppRestoreSnapshot } from "./restore-snapshot"

const BASE = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps"
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const identifier = (v: unknown) => { if (typeof v !== "string" || !GUID.test(v)) throw new Error("Intune returned an invalid app or file identifier."); return v }
const versionId = (v: unknown) => { if (typeof v !== "string" || !/^\d{1,12}$/.test(v)) throw new Error("Intune returned an invalid content version."); return v }
interface RestoreRecord {
  schema: 1; id: string; sourceId: string; target: string; name: string; settingsHash: string
  secrets: RestoreSecrets; creationStarted: boolean; appId?: string; version?: string; fileId?: string; completed?: boolean
}
export interface RestoreOptions {
  graph: RestoreGraph; fetch: typeof fetch; signal: AbortSignal
  progress: (value: AppRestoreProgress) => void
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}
const pause = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal })
async function all(graph: RestoreGraph, initial: string): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = []; let next: string | null = initial, count = 0, bytes = 0
  while (next) {
    if (++count > 500) throw new Error("The destination list is too large to reconcile safely.")
    const page = await graph("GET", next)
    if (!Array.isArray(page.value) || page.value.some(v => !v || typeof v !== "object" || Array.isArray(v))) throw new Error("Intune returned an invalid destination list.")
    bytes += Buffer.byteLength(JSON.stringify(page.value))
    if (bytes > 32 * 1024 ** 2 || values.length + page.value.length > 10000) throw new Error("The destination list exceeds the reconciliation limit.")
    values.push(...page.value)
    next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : null
    if (next && !next.startsWith(initial.split("?")[0]!)) throw new Error("Invalid destination list continuation.")
  }
  return values
}

/** One durable restore per captured version and destination. Retries never silently create another app. */
export async function restoreCapturedApp(store: AppSourceStore, source: CapturedAppSource, snapshot: AppRestoreSnapshot, target: string, name: string, options: RestoreOptions): Promise<AppRestoreResult> {
  return store.withRestoreLock(source.tenantId, source.id, target, options.signal, () => restoreOwnedApp(store, source, snapshot, target, name, options))
}

async function restoreOwnedApp(store: AppSourceStore, source: CapturedAppSource, snapshot: AppRestoreSnapshot, target: string, name: string, options: RestoreOptions): Promise<AppRestoreResult> {
  const { graph, fetch: fetchImpl, signal, progress } = options, wait = options.wait ?? pause
  const body = restoreBody(snapshot, name), settingsHash = snapshotHash(snapshot)
  const totalBytes = 48 + (Math.floor(source.bytes / 16) + 1) * 16
  const report = (phase: AppRestoreProgress["phase"], uploadedBytes = 0) => progress({ phase, uploadedBytes, totalBytes })
  signal.throwIfAborted()
  report("verifying")
  // Prove destination access before allocating a journal or writing to Microsoft.
  await graph("GET", `${BASE}?$select=id&$top=1`)
  let record = await store.readRestoreRecord<RestoreRecord>(source.tenantId, source.id, target)
  if (record) {
    if (record.schema !== 1 || !GUID.test(record.id) || record.sourceId !== source.id || record.target !== target || record.settingsHash !== settingsHash || record.name !== name.trim()) throw new Error("An earlier restore exists for this backup and destination with different settings. Use its original app name to reconcile it.")
    if (record.appId) identifier(record.appId)
    if (record.version) versionId(record.version)
    if (record.fileId) identifier(record.fileId)
  } else {
    record = { schema: 1, id: randomUUID(), sourceId: source.id, target, name: name.trim(), settingsHash, secrets: newRestoreSecrets(), creationStarted: false }
  }
  const save = () => store.writeRestoreRecord(source.tenantId, source.id, target, record)
  const marker = `[TenuVault restore ${record.id}]`
  body.notes = [typeof body.notes === "string" ? body.notes : "", marker].filter(Boolean).join("\n")
  const result = (): AppRestoreResult => ({ appId: record!.appId!, tenantId: target, name: record!.name, contentVersion: record!.version!, sourceId: source.id })
  // Validate the complete source before creating anything. No plaintext reaches disk.
  const encryption: { profile?: ContentEncryption } = {}
  for await (const _part of encryptRestoreContent(store.content(source.tenantId, source.id, signal), record.secrets, source, encryption)) { signal.throwIfAborted() }
  const observe = async () => {
    const apps = (await all(graph, `${BASE}?$select=id,displayName,notes,lastModifiedDateTime&$top=100`))
      .filter(app => (typeof app.displayName === "string" && app.displayName.toLowerCase() === name.trim().toLowerCase())
        || (typeof app.notes === "string" && app.notes.split("\n").includes(marker)))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const appUrl = record.appId ? `${BASE}/${record.appId}` : null
    const contentUrl = appUrl ? `${appUrl}/microsoft.graph.win32LobApp/contentVersions` : null
    return [apps, appUrl ? await graph("GET", appUrl) : null, appUrl ? await all(graph, `${appUrl}/assignments`) : null,
      contentUrl ? await all(graph, contentUrl) : null,
      contentUrl && record.version ? (await all(graph, `${contentUrl}/${record.version}/files`)).map(({ azureStorageUri: _sas, ...file }) => file) : null]
  }
  let expected: unknown
  // Persist the draft identity before it is named in a shared request.
  await save()
  const work = async (): Promise<AppRestoreResult> => {
    if (hasWriteApproval(target)) await sameObservation(expected, observe)()
    if (!record.appId && record.creationStarted) {
      const found = (await all(graph, `${BASE}?$select=id,notes&$top=100`)).filter(app => typeof app.notes === "string" && app.notes.split("\n").includes(marker))
      if (found.length !== 1) throw new Error("The earlier app creation could not be confirmed. Check Intune before retrying. TenuVault will not create a duplicate automatically.")
      record.appId = identifier(found[0]!.id); await save()
    }
    if (!record.appId) {
      report("creating"); record.creationStarted = true; await save()
      if (signal.aborted) {
        // No request has been dispatched. Persist that fact so a deliberate retry
        // can create the app; unknown POST outcomes still require reconciliation.
        record.creationStarted = false; await save(); signal.throwIfAborted()
      }
      const send = () => graph("POST", BASE, body)
      try {
        record.appId = identifier((await (hasWriteApproval(target) ? withWriteCheckpoint(sameObservation(expected, observe), send) : send())).id)
      } catch (error) {
        if (error instanceof FetchPreconditionError) { record.creationStarted = false; await save() }
        throw error
      }
      await save()
    }
    const appUrl = `${BASE}/${record.appId}`, contentUrl = `${appUrl}/microsoft.graph.win32LobApp/contentVersions`
    const verifyDraft = async () => {
      const live = await graph("GET", appUrl)
      if (live["@odata.type"] !== "#microsoft.graph.win32LobApp" || typeof live.notes !== "string" || !live.notes.split("\n").includes(marker)) throw new Error("The destination app no longer belongs to this restore.")
      assertRestoredSettings(body, live)
      if ((await all(graph, `${appUrl}/assignments`)).length) throw new Error("The destination app has assignments. Review it before continuing.")
    }
    const send = (method: "POST" | "PATCH", path: string, payload?: Record<string, unknown>) => hasWriteApproval(target)
      ? withWriteCheckpoint(verifyDraft, () => graph(method, path, payload))
      : graph(method, path, payload)
    const existing = await graph("GET", appUrl)
    if (existing["@odata.type"] !== "#microsoft.graph.win32LobApp" || typeof existing.notes !== "string" || !existing.notes.split("\n").includes(marker)) throw new Error("The destination app no longer belongs to this restore. No changes were made to it.")
    assertRestoredSettings(body, existing)
    if (record.completed) {
      if (existing.committedContentVersion !== record.version || existing.publishingState !== "published") throw new Error("The previously restored destination app has changed. Review it in Intune.")
      report("completed", totalBytes); return result()
    }
    if ((await all(graph, `${appUrl}/assignments`)).length) throw new Error("This destination app was assigned while the restore was incomplete. Remove its assignments in Intune before continuing.")
    if (!record.version) {
      const versions = await all(graph, contentUrl)
      if (versions.length > 1) throw new Error("The destination has unexpected content versions. Review it in Intune.")
      record.version = versionId(versions[0]?.id ?? (await send("POST", contentUrl, {})).id); await save()
    }
    const filesUrl = `${contentUrl}/${record.version}/files`
    if (!record.fileId) {
      const files = await all(graph, filesUrl)
      if (files.length > 1) throw new Error("The destination has unexpected content files. Review it in Intune.")
      record.fileId = identifier(files[0]?.id ?? (await send("POST", filesUrl, { "@odata.type": "#microsoft.graph.mobileAppContentFile", name: `${record.id}.intunewin`, size: source.bytes, sizeEncrypted: totalBytes, manifest: null, isDependency: false })).id); await save()
    }
    const fileUrl = `${filesUrl}/${record.fileId}`
    const poll = async (states: string[]) => {
      for (let attempt = 0; attempt < 180; attempt++) {
        signal.throwIfAborted()
        const file = await graph("GET", fileUrl)
        if (states.includes(String(file.uploadState))) return file
        if (/Failed|TimedOut/i.test(String(file.uploadState))) throw new Error("Intune could not process the installer. Retry this restore and check its destination app.")
        await wait(2000, signal)
      }
      throw new Error("Intune is still processing the installer. Retry this restore to check the same destination app.")
    }
    let file = await graph("GET", fileUrl)
    if (/^azureStorageUri(?:Request|Renewal)(?:Failed|TimedOut)$/.test(String(file.uploadState))) {
      // Intune refuses renewal after a terminal storage failure and its Win32 file
      // DELETE route is unavailable. Keep the journal and draft; never duplicate it.
      throw new Error("Intune cannot resume this failed upload. The unassigned draft has been retained for review in Intune. No replacement app was created.")
    }
    if (file.uploadState === "commitFilePending") file = await poll(["commitFileSuccess"])
    if (file.uploadState !== "commitFileSuccess") {
      const ready = ["azureStorageUriRequestSuccess", "azureStorageUriRenewalSuccess"]
      // Fresh files can briefly report "success" before allocation starts. Renewal
      // is not valid until Intune has actually issued an upload URI.
      if (!ready.includes(String(file.uploadState))) file = await poll(ready)
      const expiry = Date.parse(String(file.azureStorageUriExpirationDateTime))
      if (Number.isFinite(expiry) && expiry <= Date.now() + 60000) {
        await send("POST", `${fileUrl}/renewUpload`)
        file = await poll(["azureStorageUriRenewalSuccess"])
      }
      let sas = String(file.azureStorageUri ?? ""), renewed = Date.now()
      const ids: string[] = [], block = Buffer.alloc(4 * 1024 ** 2)
      let used = 0, uploaded = 0
      const upload = async () => {
        signal.throwIfAborted()
        if (Date.now() - renewed > 6 * 60_000) {
          await send("POST", `${fileUrl}/renewUpload`); const renewedFile = await poll(["azureStorageUriRenewalSuccess"])
          sas = String(renewedFile.azureStorageUri ?? ""); renewed = Date.now()
        }
        const id = Buffer.from(String(ids.length).padStart(6, "0")).toString("base64")
        await putRestoreBlock(sas, { comp: "block", blockid: id }, block.subarray(0, used), fetchImpl, signal, target)
        ids.push(id); uploaded += used; used = 0; report("uploading", uploaded)
      }
      report("uploading")
      const second: { profile?: ContentEncryption } = {}
      for await (const bytes of encryptRestoreContent(store.content(source.tenantId, source.id, signal), record.secrets, source, second, encryption.profile)) {
        for (let offset = 0; offset < bytes.length;) {
          const n = Math.min(block.length - used, bytes.length - offset)
          bytes.copy(block, used, offset, offset + n); used += n; offset += n
          if (used === block.length) await upload()
        }
      }
      if (used) await upload()
      if (uploaded !== totalBytes || !second.profile) throw new Error("The uploaded installer length is invalid.")
      signal.throwIfAborted()
      if (hasWriteApproval(target)) await verifyDraft()
      await putRestoreBlock(sas, { comp: "blocklist" }, `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map(id => `<Latest>${id}</Latest>`).join("")}</BlockList>`, fetchImpl, signal, target)
      report("committing", totalBytes)
      await send("POST", `${fileUrl}/commit`, { fileEncryptionInfo: second.profile })
      file = await poll(["commitFileSuccess"])
    }
    if (file.isCommitted !== true || Number(file.size) !== source.bytes || Number(file.sizeEncrypted) !== totalBytes) throw new Error("Intune did not confirm the complete installer content.")
    report("publishing", totalBytes)
    await send("PATCH", appUrl, { "@odata.type": "#microsoft.graph.win32LobApp", committedContentVersion: record.version })
    for (let attempt = 0; attempt < 90; attempt++) {
      const app = await graph("GET", appUrl)
      if (app.committedContentVersion === record.version && app.publishingState === "published") {
        assertRestoredSettings(body, app)
        if ((await all(graph, `${appUrl}/assignments`)).length) throw new Error("The app was published, but assignments were added outside this restore. Review them in Intune.")
        record.completed = true; await save(); report("completed", totalBytes); return result()
      }
      await wait(2000, signal)
    }
    throw new Error("Intune has not finished publishing the app. Retry to verify this same restore.")
  }
  if (record.completed) {
    if (!record.appId || !record.version) throw new Error("The completed restore record is missing its destination app or content version.")
    return work()
  }
  return withWriteApproval([{
    tenant: target, reference: ["app-backup-restore", source.tenantId, source.id],
    summary: { kind: "Restore an unassigned Win32 app", count: 1, targets: [name.trim()], assignments: false, reference: source.id, fields: Object.keys(body).sort() },
    observe: async () => {
      expected = await observe()
      return { content: [source.id, source.sha256, source.receipt, settingsHash, body, record.id, record.appId, record.version, record.fileId], target: expected }
    },
  }], work)
}
