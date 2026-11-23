import { AUDIT_ARCHIVE_FILE, AUDIT_ARCHIVE_HISTORY_MS, AUDIT_ARCHIVE_OVERLAP_MS, auditArchive, auditArchiveWindow, type AuditArchiveWindow } from "../../shared/intune/audit-archive"
import { BACKUP_OWNER_FILE, MAX_BACKUP_ARCHIVE_BYTES } from "../../shared/constants"
import { parseBackupName } from "../../shared/intune/backup-names"
import type { BlobWriter } from "./blob-writer"
import type { GraphSession } from "./graph-session"
import { GRAPH, GraphError, RequestTimeoutError, StorageError, TokenError } from "./request"

const DAY_MS = 24 * 60 * 60_000
const MIN_SLICE_MS = 1_000
const timestamp = (time: number) => new Date(time).toISOString()

class ArchiveError extends Error {}
class ArchiveSizeError extends ArchiveError {
  constructor() { super("The Intune audit archive reached the backup file size limit.") }
}

export function auditArchiveFailure(error: unknown): string {
  if (error instanceof GraphError) {
    if (error.status === 403) return "Microsoft Graph returned 403 for the Intune audit log. The app needs DeviceManagementApps.Read.All and your account an Intune role that can read it."
    return `Microsoft Graph returned HTTP ${error.status} for the Intune audit log.`
  }
  if (error instanceof RequestTimeoutError || (error instanceof Error && error.name === "TimeoutError")) return "The Intune audit archive timed out."
  if (error instanceof ArchiveError) return error.message
  if (error instanceof StorageError) return "The audit archive could not access backup storage."
  if (error instanceof TokenError) return "The audit archive could not sign in."
  return "The Intune audit archive could not be read or saved."
}

export async function archiveIntuneAudit(
  storage: Pick<BlobWriter, "list" | "readJson" | "put">,
  graph: Pick<GraphSession, "listPages">,
  tenantId: string,
  folder: string,
  started: Date,
  options: { signal?: AbortSignal; maxBytes?: number; note?: (message: string) => void } = {},
): Promise<AuditArchiveWindow> {
  const { signal, maxBytes = MAX_BACKUP_ARCHIVE_BYTES, note = () => {} } = options
  const end = started.getTime()
  const historyStart = end - AUDIT_ARCHIVE_HISTORY_MS
  let start = historyStart
  let checkpoint: number | undefined
  const seen = new Set<string>()
  const { prefixes } = await storage.list("backup-", "/")
  const candidates = [...new Set(prefixes)].sort().reverse()
  for (const prefix of candidates) {
    const name = prefix.replace(/\/$/, "")
    if (name === folder) continue
    const time = Date.parse(parseBackupName(name)?.timestamp ?? "")
    if (!Number.isFinite(time)) continue
    if (time + 999 < start) break
    signal?.throwIfAborted()

    let metadata: Record<string, unknown> | null
    try {
      metadata = await storage.readJson(`${prefix}metadata.json`)
    } catch {
      note(`Skipped ${name} for the Intune audit checkpoint: its backup metadata could not be read.`)
      continue
    }
    if (!metadata) {
      // A recent claim from this tenant can still commit a competing checkpoint.
      if (time >= end - 6 * 60 * 60_000) {
        const owner = await storage.readJson(`${prefix}${BACKUP_OWNER_FILE}`).catch(() => null)
        if (String(owner?.TenantId).toLowerCase() === tenantId.toLowerCase()) throw new ArchiveError("Another backup is still running.")
      }
      note(`Skipped ${name} for the Intune audit checkpoint: its backup metadata is missing.`)
      continue
    }
    if (String(metadata.TenantId).toLowerCase() !== tenantId.toLowerCase() || metadata.AuditArchive === undefined) continue
    const previous = auditArchiveWindow(metadata.AuditArchive)
    if (!previous) {
      note(`Skipped ${name} for the Intune audit checkpoint: its archive window is invalid.`)
      continue
    }
    const to = Date.parse(previous.to)
    if (to < start) continue
    const overlapStart = checkpoint === undefined ? Math.max(historyStart, to - AUDIT_ARCHIVE_OVERLAP_MS) : start
    try {
      const archive = auditArchive(await storage.readJson(`${prefix}${AUDIT_ARCHIVE_FILE}`), previous)
      const ids = []
      for (const event of archive.value) {
        const at = Date.parse(String(event.activityDateTime))
        if (!Number.isFinite(at)) throw new ArchiveError("Invalid saved Intune audit event.")
        if (at >= overlapStart && at <= to) ids.push(String(event.id))
      }
      for (const id of ids) seen.add(id)
    } catch {
      note(`Skipped ${name} for the Intune audit checkpoint: its archive is missing or unreadable.`)
      continue
    }
    if (to >= end) throw new ArchiveError("A newer backup already archived the Intune audit log.")
    if (checkpoint === undefined) {
      checkpoint = to
      start = overlapStart
    }
  }

  const events: string[] = []
  let bytes = 256 // Reserve space for the JSON envelope and its window.
  let cursor = start
  let sliceMs = DAY_MS
  while (cursor < end) {
    const sliceEnd = Math.min(cursor + sliceMs, end)
    const upper = sliceEnd === end ? "le" : "lt"
    const filter = encodeURIComponent(`activityDateTime ge ${timestamp(cursor)} and activityDateTime ${upper} ${timestamp(sliceEnd)}`)
    const slice = new Map<string, string>()
    let sliceBytes = 0
    try {
      signal?.throwIfAborted()
      for await (const page of graph.listPages(`${GRAPH}/beta/deviceManagement/auditEvents?$filter=${filter}&$top=200`)) {
        signal?.throwIfAborted()
        for (const event of page) {
          const at = Date.parse(String(event?.activityDateTime))
          if (typeof event?.id !== "string" || !event.id || !Number.isFinite(at)) throw new ArchiveError("Invalid Intune audit event.")
          if (at < cursor || (upper === "lt" ? at >= sliceEnd : at > sliceEnd) || seen.has(event.id) || slice.has(event.id)) continue
          const json = JSON.stringify(event)
          sliceBytes += Buffer.byteLength(json) + 1
          if (bytes + sliceBytes > maxBytes) throw new ArchiveSizeError()
          slice.set(event.id, json)
        }
      }
      signal?.throwIfAborted()
    } catch (error) {
      const size = error instanceof ArchiveSizeError
      const timedOut = signal?.aborted || error instanceof RequestTimeoutError || (error instanceof Error && error.name === "TimeoutError")
      if (!size && !timedOut) throw error
      if (cursor > Math.max(start, checkpoint ?? start)) break
      if (!size || sliceEnd - cursor <= MIN_SLICE_MS) throw error
      // An unusually dense first day can still advance the checkpoint in a smaller interval.
      sliceMs = Math.max(MIN_SLICE_MS, Math.floor((sliceEnd - cursor) / 2))
      continue
    }
    for (const [id, json] of slice) {
      seen.add(id)
      events.push(json)
    }
    bytes += sliceBytes
    cursor = sliceEnd
  }

  const window = { from: timestamp(start), to: timestamp(cursor), count: events.length }
  await storage.put(`${folder}/${AUDIT_ARCHIVE_FILE}`, `{"window":${JSON.stringify(window)},"value":[${events.join(",")}]}`)
  return window
}
