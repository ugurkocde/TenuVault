import { AUDIT_ARCHIVE_FILE, AUDIT_ARCHIVE_HISTORY_MS, AUDIT_ARCHIVE_OVERLAP_MS, auditArchive, auditArchiveWindow, type AuditArchiveWindow } from "../../shared/intune/audit-archive"
import { BACKUP_OWNER_FILE, MAX_BACKUP_ARCHIVE_BYTES } from "../../shared/constants"
import { parseBackupName } from "../../shared/intune/backup-names"
import { isLegacySealedError, isLegacyOtherTenantError } from "../../shared/legacy-sealed"
import type { BlobWriter } from "./blob-writer"
import type { GraphSession } from "./graph-session"
import { GRAPH } from "./request"

/** Write a window only when the entire read and storage write succeeded. Its checkpoint is in the manifest. */
export async function archiveIntuneAudit(
  storage: Pick<BlobWriter, "list" | "readJson" | "put">,
  graph: Pick<GraphSession, "listPages">,
  tenantId: string,
  folder: string,
  started: Date,
): Promise<AuditArchiveWindow> {
  const end = started.getTime()
  const historyStart = end - AUDIT_ARCHIVE_HISTORY_MS
  let start = historyStart
  let hasPrevious = false
  const seen = new Set<string>()
  const { prefixes } = await storage.list("backup-", "/")
  const candidates = [...new Set(prefixes)].sort().reverse()
  for (const prefix of candidates) {
    const name = prefix.replace(/\/$/, "")
    if (name === folder) continue
    const time = Date.parse(parseBackupName(name)?.timestamp ?? "")
    if (!Number.isFinite(time)) continue
    if (time + 999 < start) break

    let metadata: Record<string, unknown> | null
    try {
      metadata = await storage.readJson(`${prefix}metadata.json`)
    } catch (error) {
      if (isLegacySealedError(error) || isLegacyOtherTenantError(error)) continue
      throw error
    }
    if (!metadata) {
      // Folder claims precede both archive reads. If another writer is still active, defer the
      // archive so neither writer advances a checkpoint based on an uncommitted window.
      if (time < end - 6 * 60 * 60_000) continue
      const owner = await storage.readJson(`${prefix}${BACKUP_OWNER_FILE}`)
      if (String(owner?.TenantId).toLowerCase() === tenantId.toLowerCase()) throw new Error("Another backup is still running.")
      continue
    }
    if (String(metadata.TenantId).toLowerCase() !== tenantId.toLowerCase() || metadata.AuditArchive === undefined) continue
    const previous = auditArchiveWindow(metadata.AuditArchive)
    if (!previous) throw new Error("Invalid Intune audit archive window.")
    const checkpoint = Date.parse(previous.to)
    if (checkpoint >= end) throw new Error("A newer backup already archived the Intune audit log.")
    if (!hasPrevious) {
      start = Math.max(historyStart, checkpoint - AUDIT_ARCHIVE_OVERLAP_MS)
      hasPrevious = true
    }
    if (checkpoint < start || previous.count === 0) continue
    const archive = auditArchive(await storage.readJson(`${prefix}${AUDIT_ARCHIVE_FILE}`), previous)
    for (const event of archive.value) {
      if (Date.parse(String(event.activityDateTime)) >= start) seen.add(String(event.id))
    }
  }

  const from = new Date(start).toISOString()
  const to = started.toISOString()
  const filter = encodeURIComponent(`activityDateTime ge ${from} and activityDateTime le ${to}`)
  const events: string[] = []
  let bytes = 256 // Reserve space for the JSON envelope and its window.
  for await (const page of graph.listPages(`${GRAPH}/beta/deviceManagement/auditEvents?$filter=${filter}&$top=200`)) {
    for (const event of page) {
      const time = Date.parse(String(event?.activityDateTime))
      if (typeof event?.id !== "string" || !event.id || !Number.isFinite(time)) throw new Error("Invalid Intune audit event.")
      if (time < start || time > end || seen.has(event.id)) continue
      seen.add(event.id)
      const json = JSON.stringify(event)
      bytes += Buffer.byteLength(json) + 1
      if (bytes > MAX_BACKUP_ARCHIVE_BYTES) throw new Error("The Intune audit archive exceeds the backup file size limit.")
      events.push(json)
    }
  }

  const window = { from, to, count: events.length }
  await storage.put(`${folder}/${AUDIT_ARCHIVE_FILE}`, `{"window":${JSON.stringify(window)},"value":[${events.join(",")}]}`)
  return window
}
