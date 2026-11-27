import { backupBlobName, backupContainer, LARGE_BACKUP_CONTAINER, logicalBackupName } from "../../shared/backup-storage"
import { indexPath, largeIndexes } from "../../shared/large-backup"
import { execFile } from "node:child_process"
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { link, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { basename, dirname, join, resolve, win32 } from "node:path"
import { promisify } from "node:util"
import { BACKUP_CONTAINER, BACKUP_OWNER_FILE, BACKUP_RUN_RECORD_FILE } from "../../shared/constants"
import { DAMAGE_KINDS, type DamageKind, type DamagedFileKinds } from "../../shared/damaged-files"
import { mapLimit } from "../../shared/map-limit"

/**
 * Encrypted on-disk blob storage for backups kept on this device.
 *
 * Layout: <root>/<account>/<container>/<id>.tvb, one file per blob. Every file is
 * encrypted with AES-256-GCM. File names are an HMAC of the blob name, so the disk
 * shows neither policy names nor content. File format:
 *
 *   magic | u16 header length | header iv (12) | header tag (16) | header ciphertext
 *         | body iv (12) | body tag (16) | body ciphertext
 *
 * The header holds { name, contentType, created } as JSON. Keys are derived from a
 * master key; older master keys (after importing a recovery key) stay readable.
 *
 * Version 1 ("TVB1") binds only the container and blob name. Version 2 ("TVB2") binds
 * every file to its account (tenant): the account is part of the file-name HMAC and of
 * both AES-GCM AADs, and the header AAD also holds the file name, so a header cannot be
 * moved to another file, container or account. Both versions are read, each with its
 * own rules; new files and overwrites use WRITE_FORMAT.
 *
 * Damaged files. In the backup container, a file that cannot be read (damaged, truncated, or
 * encrypted with a key this device does not have) or a second file for the same blob does not
 * block the healthy backups. Damage that can be traced to a backup (its folder's manifest or
 * ownership marker, a manifest item, or a duplicate's name) makes only that backup unavailable:
 * its listing and reads fail with IncompleteInventoryError. Damage that cannot be traced makes
 * every backup without a manifest unavailable, since none of them can be checked. While any
 * damage is present nothing in the container is deleted, so retention never removes a copy that
 * may be needed. Damaged files are left in place for recovery. Other containers still fail
 * closed: one unreadable file stops every listing and read.
 */

/**
 * The format new files and overwrites are written in. Version 2 since 0.3.0. Every released
 * app version (0.2.0 and later) reads both versions, so a folder shared with or opened by an
 * earlier release stays readable, and files written before the switch are never rewritten
 * unless they are overwritten. Keep reading version 1 until at least 0.5.0 (two minor
 * versions after the switch) and record the removal in RELEASING.md when it happens.
 */
export const WRITE_FORMAT: Version = 2

const MAGIC_V1 = Buffer.from("TVB1")
const MAGIC_V2 = Buffer.from("TVB2")
const MAGIC_LENGTH = 4
const IV = 12
const TAG = 16
const EXT = ".tvb"
const RETIRED_PREFIX = ".retired-"
const RETIRED_STAMP = ".quarantined"
const RETENTION_LOCK_FILE = ".tenuvault-retention.lock"
// Another app instance can be between the rename and delete. Let that operation settle first.
const RETIRED_GRACE_MS = 60_000

/** Detects encrypted local backup files. Returns null if an incomplete scan cannot rule them out. */
export async function localBackupsExist(
  root: string,
  readDirectory = (path: string) => readdir(path, { withFileTypes: true }),
): Promise<boolean | null> {
  try {
    const accounts = await readDirectory(root)
    let incomplete = false
    for (const account of accounts) {
      if (!account.isDirectory()) continue
      for (const container of [BACKUP_CONTAINER, LARGE_BACKUP_CONTAINER]) {
        const folder = join(root, account.name, container)
        try {
          const files = await readDirectory(folder)
          if (files.some((file) => file.isFile() && file.name.endsWith(EXT))) return true
          for (const file of files) {
            if (file.isDirectory() && file.name.startsWith(RETIRED_PREFIX)
              && (await readDirectory(join(folder, file.name))).length) return true
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
            incomplete = true
            console.warn(`[backups] Could not scan local backup folder ${folder}:`, error)
          }
        }
      }
    }
    return incomplete ? null : false
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false
    console.warn(`[backups] Could not scan local backup folder ${root}:`, error)
    return null
  }
}

/** File headers read at once while reading a container's inventory. */
const HEADER_CONCURRENCY = 16

export interface StoredBlob {
  name: string
  size: number
  contentType: string
  created: Date
  lastModified: Date
  metadata?: Record<string, string>
  etag?: string
}

export type Version = 1 | 2

interface Entry extends StoredBlob {
  file: string
  version: Version
  stamp: string
}

interface Keys {
  encryption: Buffer
  naming: Buffer
}

function deriveKeys(master: Buffer): Keys {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32))
  return { encryption: derive("tenuvault-backup-encryption-v1"), naming: derive("tenuvault-backup-naming-v1") }
}

function seal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

function unseal(key: Buffer, sealed: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(sealed.subarray(IV, IV + TAG))
  return Buffer.concat([decipher.update(sealed.subarray(IV + TAG)), decipher.final()])
}

/** Associated data for a file's header. Version 1 bound only the container. */
function headerAad(version: Version, account: string, container: string, file: string): string {
  return version === 1 ? `header:${container}` : JSON.stringify(["tvb2-header", account.toLowerCase(), container, file])
}

/** Associated data for a file's body. Version 1 bound only the container and blob name. */
function bodyAad(version: Version, account: string, container: string, name: string): string {
  return version === 1 ? `${container}/${name}` : JSON.stringify(["tvb2-body", account.toLowerCase(), container, name])
}

function fileName(version: Version, naming: Buffer, account: string, container: string, name: string): string {
  const input = version === 1 ? `${container}/${name}` : JSON.stringify(["tvb2-name", account.toLowerCase(), container, name])
  const id = createHmac("sha256", naming).update(input).digest("hex").slice(0, 40)
  return `${id}${EXT}`
}

function versionOf(magic: Buffer): Version | null {
  return magic.equals(MAGIC_V2) ? 2 : magic.equals(MAGIC_V1) ? 1 : null
}

export class BlobNotFoundError extends Error {}
export class BlobAlreadyExistsError extends Error {}
/** An If-Match ETag no longer matches the stored blob. */
export class BlobConditionNotMetError extends Error {}
export class BlobQuarantinedError extends BlobConditionNotMetError {}
export class BlobDeleteInterruptedError extends Error {}
export interface RetentionLockConflictDetails {
  code?: "LeaseAlreadyPresent" | "RetentionLockManualIntervention"
  lockPath?: string
  holderId?: string
}

export class BlobLeaseConflictError extends Error {
  readonly code?: "LeaseAlreadyPresent" | "RetentionLockManualIntervention"
  readonly lockPath?: string
  readonly holderId?: string
  constructor(message: string, options?: ErrorOptions & RetentionLockConflictDetails) {
    super(message, options)
    this.code = options?.code
    this.lockPath = options?.lockPath
    this.holderId = options?.holderId
  }
}
export class BlobLeaseUnsupportedError extends Error {}
export class BlobProtectedError extends Error {}
export interface ExpectedReplacement {
  prefix: string
  blobs: Record<string, string>
}
export class BlobReplacementChangedError extends Error {
  constructor(readonly prefix: string, message?: string, readonly restoredEtag?: string) {
    super(message ?? `Replacement backup ${prefix} changed before cleanup completed`)
    this.name = "BlobReplacementChangedError"
  }
}

class QuarantineRestoreConflictError extends Error {
  constructor(readonly held: string, readonly live: string) {
    super(`Could not restore ${held} to ${live} because the live path already exists.`)
    this.name = "QuarantineRestoreConflictError"
  }
}

export interface RetentionLockRecord {
  id: string
  host: string
  pid: number
  processStart: string | number
  app: "TenuVault"
}

interface LegacyRetentionLockRecord {
  id: string
  expiresAt: number
  pid?: number
  durationMs?: number
}

export interface ProcessInfoReader {
  isPidAlive(pid: number): boolean
  readProcessStart(pid: number): Promise<string | "gone" | null>
}

export type ExecFileRunner = (
  file: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv; windowsHide?: boolean },
) => Promise<{ stdout: string }>

const execFileAsync = promisify(execFile)
const PROCESS_START_TIMEOUT_MS = 5_000
const UNPARSEABLE_LOCK_REREAD_MS = 50
const FALLBACK_PROCESS_START = Math.round(Date.now() - process.uptime() * 1000)
const COMPARABLE_START_KINDS = new Set(["proc", "wmi", "ps"])
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}
let cachedBootId: string | null | undefined
let cachedCurrentProcessStart: Promise<string | null> | undefined

/** Extracts the comparable start-token kind ("proc", "wmi", or "ps"), or null for unknown/uncomparable tokens. */
export function processStartKind(token: string | number): string | null {
  if (typeof token !== "string") return null
  const sep = token.indexOf(":")
  if (sep <= 0 || sep === token.length - 1) return null
  const kind = token.slice(0, sep)
  return COMPARABLE_START_KINDS.has(kind) ? kind : null
}

function parseLinuxStartToken(token: string): { bootId: string | null; ticks: string } | null {
  if (!token.startsWith("proc:")) return null
  const rest = token.slice("proc:".length)
  const sep = rest.lastIndexOf(":")
  if (sep < 0) return /^\d+$/.test(rest) ? { bootId: null, ticks: rest } : null
  const bootId = rest.slice(0, sep)
  const ticks = rest.slice(sep + 1)
  if (!bootId || !/^\d+$/.test(ticks)) return null
  return { bootId, ticks }
}

/**
 * Compares a recorded lock process-start token against an observed token for a live PID.
 * Linux `proc:` tokens require boot-id evidence on both sides so `proc:<boot>:<ticks>` vs
 * `proc:<ticks>` (when boot_id was unreadable) is treated as inconclusive rather than stale.
 */
export function compareProcessStart(recorded: string | number, observed: string): "same" | "different" | "incomparable" {
  const observedKind = processStartKind(observed)
  const recordedKind = processStartKind(recorded)
  if (!observedKind || !recordedKind || observedKind !== recordedKind) return "incomparable"
  const recordedText = recorded as string
  if (recordedKind === "proc") {
    const rec = parseLinuxStartToken(recordedText)
    const obs = parseLinuxStartToken(observed)
    if (!rec || !obs || !rec.bootId || !obs.bootId) return "incomparable"
    return rec.bootId === obs.bootId && rec.ticks === obs.ticks ? "same" : "different"
  }
  return observed === recordedText ? "same" : "different"
}

/** Parses Linux `/proc/<pid>/stat` text into a `proc:` token, `"gone"` for dead/zombie processes, or null. */
export function parseLinuxProcStat(statText: string, bootId: string | null): string | "gone" | null {
  const closeParen = statText.lastIndexOf(")")
  if (closeParen < 0) return null
  const fields = statText.slice(closeParen + 1).trim().split(/\s+/)
  const state = fields[0]
  const startTicks = fields[19]
  if (state === "Z" || state === "X") return "gone"
  if (startTicks && /^\d+$/.test(startTicks)) {
    return bootId ? `proc:${bootId}:${startTicks}` : `proc:${startTicks}`
  }
  return null
}

/** Parses `ps -o lstart=` output (with LC_ALL=C, TZ=UTC) into a `ps:<epoch-seconds>` token, or null. */
export function parseDarwinPsStart(stdout: string): string | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(trimmed)
  if (!match) return null
  const month = MONTHS[match[1]!]
  if (month === undefined) return null
  const day = Number(match[2])
  const hour = Number(match[3])
  const minute = Number(match[4])
  const second = Number(match[5])
  const year = Number(match[6])
  const ms = Date.UTC(year, month, day, hour, minute, second)
  if (!Number.isFinite(ms)) return null
  return `ps:${Math.floor(ms / 1000)}`
}

/** Parses PowerShell Win32_Process CreationDate UTC ISO output into a `wmi:<iso>` token, or null. */
export function parseWindowsCreationDate(stdout: string): string | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const ms = Date.parse(trimmed)
  if (!Number.isFinite(ms)) return null
  return `wmi:${new Date(ms).toISOString()}`
}

async function linuxBootId(): Promise<string | null> {
  if (cachedBootId !== undefined) return cachedBootId
  try {
    cachedBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || null
  } catch {
    cachedBootId = null
  }
  return cachedBootId
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

const defaultExecFile: ExecFileRunner = async (file, args, options) => {
  const result = await execFileAsync(file, args, { ...options, encoding: "utf8" })
  return { stdout: String(result.stdout ?? "") }
}

/**
 * Builds a platform process-info reader that observes stable start tokens with explicit kinds:
 * - linux: `proc:<bootId>:<ticks>` (or `proc:<ticks>`) from `/proc/<pid>/stat`
 * - darwin: `ps:<epoch-seconds>` from `ps -o lstart= -p <pid>` with `LC_ALL=C` and `TZ=UTC`
 * - win32: `wmi:<iso>` from PowerShell `Get-CimInstance Win32_Process` without a shell
 */
export function createProcessInfoReader(options: {
  platform?: NodeJS.Platform
  execFile?: ExecFileRunner
  isPidAlive?: (pid: number) => boolean
  readProcStat?: (pid: number) => Promise<string>
  readBootId?: () => Promise<string | null>
} = {}): ProcessInfoReader {
  const platform = options.platform ?? process.platform
  const runExec = options.execFile ?? defaultExecFile
  const alive = options.isPidAlive ?? defaultIsPidAlive
  const readStat = options.readProcStat ?? ((pid: number) => readFile(`/proc/${pid}/stat`, "utf8"))
  const readBoot = options.readBootId ?? linuxBootId

  return {
    isPidAlive: alive,
    async readProcessStart(pid: number): Promise<string | "gone" | null> {
      if (!Number.isInteger(pid) || pid <= 0) return null
      if (platform === "linux") {
        try {
          const statText = await readStat(pid)
          const parsed = parseLinuxProcStat(statText, await readBoot())
          return parsed
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === "ENOENT" || code === "ESRCH") return "gone"
          return null
        }
      }
      if (platform === "darwin") {
        try {
          const { stdout } = await runExec("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
            env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
            timeout: PROCESS_START_TIMEOUT_MS,
            windowsHide: true,
          })
          const parsed = parseDarwinPsStart(stdout)
          if (parsed) return parsed
          return alive(pid) ? null : "gone"
        } catch (error) {
          const killed = Boolean((error as { killed?: unknown; signal?: unknown } | null)?.killed || (error as { signal?: unknown } | null)?.signal)
          if (killed) return null
          return alive(pid) ? null : "gone"
        }
      }
      if (platform === "win32") {
        try {
          const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('O') }`
          const { stdout } = await runExec(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
            timeout: PROCESS_START_TIMEOUT_MS,
            windowsHide: true,
          })
          const parsed = parseWindowsCreationDate(stdout)
          if (parsed) return parsed
          return alive(pid) ? null : "gone"
        } catch (error) {
          const killed = Boolean((error as { killed?: unknown; signal?: unknown } | null)?.killed || (error as { signal?: unknown } | null)?.signal)
          if (killed) return null
          return alive(pid) ? null : "gone"
        }
      }
      return null
    },
  }
}

const defaultProcessInfoReader = createProcessInfoReader()

async function defaultCurrentProcessStart(): Promise<string> {
  if (!cachedCurrentProcessStart) {
    cachedCurrentProcessStart = defaultProcessInfoReader.readProcessStart(process.pid).then(start =>
      start && start !== "gone" ? start : null,
    )
  }
  const observed = await cachedCurrentProcessStart
  if (observed) return observed
  cachedCurrentProcessStart = undefined
  return `unknown:${FALLBACK_PROCESS_START}`
}

function parseRetentionLock(raw: string): RetentionLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RetentionLockRecord> | null
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    if (typeof parsed.id !== "string" || !parsed.id) return null
    if (typeof parsed.host !== "string" || !parsed.host) return null
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null
    const validStart = (typeof parsed.processStart === "string" && parsed.processStart.length > 0)
      || (typeof parsed.processStart === "number" && Number.isFinite(parsed.processStart))
    if (!validStart) return null
    if (parsed.app !== "TenuVault") return null
    return {
      id: parsed.id,
      host: parsed.host,
      pid: parsed.pid,
      processStart: parsed.processStart!,
      app: "TenuVault",
    }
  } catch {
    return null
  }
}

function parseLegacyRetentionLock(raw: string): LegacyRetentionLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LegacyRetentionLockRecord & { app?: unknown; host?: unknown; processStart?: unknown }> | null
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    if (parsed.app !== undefined || parsed.host !== undefined || parsed.processStart !== undefined) return null
    if (typeof parsed.id !== "string" || !parsed.id) return null
    if (typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) return null
    if (parsed.pid !== undefined && (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0)) return null
    if (parsed.durationMs !== undefined && (typeof parsed.durationMs !== "number" || !Number.isFinite(parsed.durationMs) || parsed.durationMs <= 0)) return null
    return { id: parsed.id, expiresAt: parsed.expiresAt, pid: parsed.pid, durationMs: parsed.durationMs }
  } catch {
    return null
  }
}

function manualLockWarning(lockPath: string, reason: string): string {
  return `Retention lock file ${lockPath} (${reason}) was not reclaimed automatically. Stop any TenuVault process on this computer that uses this backup folder. Delete it only if no other computer is running TenuVault on this backup folder.`
}

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * In-process write guard for replacement prefixes during local retention cleanup.
 * Keyed by resolved container directory path -> Map<normalizedPrefix, refCount>, so every
 * LocalBlobStore instance in this process observes the same protection.
 *
 * Cross-process residual assumption: TenuVault never writes into an existing backup folder
 * (new backups use create-only new folders), and other TenuVault instances are excluded from
 * concurrent retention by the per-container retention lock file.
 */
const protectedPrefixesByDir = new Map<string, Map<string, number>>()
const lockProtectedEntries = new Map<string, Array<{ dir: string; prefix: string }>>()
/** Reclaim gate ids this process created but could not release, so the next acquire can reclaim them safely. */
const leakedReclaimGates = new Set<string>()
const guardRegisteredListeners = new Set<(dir: string, id: string) => void>()

/** Test hook: resolves once a retention lock registers its protected-prefix guard for `dir`. */
export function waitForLocalRetentionGuardRegistration(dir: string): Promise<string> {
  const key = resolve(dir)
  return new Promise(resolvePromise => {
    const listener = (registeredDir: string, id: string) => {
      if (registeredDir !== key) return
      guardRegisteredListeners.delete(listener)
      resolvePromise(id)
    }
    guardRegisteredListeners.add(listener)
  })
}

interface InFlightPut {
  name: string
  done: Promise<void>
}
const inFlightPutsByDir = new Map<string, Set<InFlightPut>>()

function trackInFlightPut(dir: string, name: string): () => void {
  const key = resolve(dir)
  let resolveDone!: () => void
  const done = new Promise<void>(resolvePromise => { resolveDone = resolvePromise })
  const entry: InFlightPut = { name, done }
  let set = inFlightPutsByDir.get(key)
  if (!set) {
    set = new Set()
    inFlightPutsByDir.set(key, set)
  }
  set.add(entry)
  let finished = false
  return () => {
    if (finished) return
    finished = true
    set?.delete(entry)
    if (set && set.size === 0) inFlightPutsByDir.delete(key)
    resolveDone()
  }
}

async function waitForInFlightPuts(dir: string, prefixes: string[] | undefined, signal?: AbortSignal): Promise<void> {
  if (!prefixes?.length) return
  const key = resolve(dir)
  const normalized = prefixes.map(normalizePrefix)
  const matches = (name: string) => {
    const logical = logicalBackupName(name)
    return normalized.some(prefix => name.startsWith(prefix) || logical.startsWith(prefix))
  }
  while (true) {
    signal?.throwIfAborted()
    const set = inFlightPutsByDir.get(key)
    if (!set) return
    const pending = [...set].filter(entry => matches(entry.name)).map(entry => entry.done)
    if (pending.length === 0) return
    const all = Promise.all(pending)
    if (!signal) {
      await all
    } else {
      let onAbort: () => void = () => undefined
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
      })
      try {
        await Promise.race([all, aborted])
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    }
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.endsWith("/") ? prefix : `${prefix}/`
}

function addProtectedPrefix(dir: string, prefix: string): { dir: string; prefix: string } {
  const key = resolve(dir)
  const normalized = normalizePrefix(prefix)
  let prefixes = protectedPrefixesByDir.get(key)
  if (!prefixes) {
    prefixes = new Map()
    protectedPrefixesByDir.set(key, prefixes)
  }
  prefixes.set(normalized, (prefixes.get(normalized) ?? 0) + 1)
  return { dir: key, prefix: normalized }
}

function removeProtectedPrefix(entry: { dir: string; prefix: string }): void {
  const prefixes = protectedPrefixesByDir.get(entry.dir)
  if (!prefixes) return
  const next = (prefixes.get(entry.prefix) ?? 0) - 1
  if (next > 0) prefixes.set(entry.prefix, next)
  else prefixes.delete(entry.prefix)
  if (prefixes.size === 0) protectedPrefixesByDir.delete(entry.dir)
}

/**
 * Releases any in-process write-guard entries registered for the given local retention lock id.
 * Idempotent and infallible so callers can always clear guards in a finally block even when
 * the storage release request fails, aborts, or times out.
 */
export function releaseLocalRetentionGuard(lockId: string): void {
  const suffix = `\0${lockId}`
  for (const [key, entries] of lockProtectedEntries) {
    if (!key.endsWith(suffix)) continue
    lockProtectedEntries.delete(key)
    for (const entry of entries) removeProtectedPrefix(entry)
  }
}

function isPrefixProtected(dir: string, name: string): boolean {
  const prefixes = protectedPrefixesByDir.get(resolve(dir))
  if (!prefixes || prefixes.size === 0) return false
  const logical = logicalBackupName(name)
  for (const prefix of prefixes.keys()) {
    if (name.startsWith(prefix) || logical.startsWith(prefix)) return true
  }
  return false
}

function assertPrefixNotProtected(dir: string, name: string): void {
  const prefixes = protectedPrefixesByDir.get(resolve(dir))
  if (!prefixes || prefixes.size === 0) return
  const logical = logicalBackupName(name)
  for (const prefix of prefixes.keys()) {
    if (name.startsWith(prefix) || logical.startsWith(prefix)) {
      throw new BlobProtectedError(`Backup ${prefix} is protected by an active retention cleanup and cannot be modified.`)
    }
  }
}

export class IncompleteInventoryError extends Error {
  /** The backup folder that is unavailable, when the error is about one backup. */
  backup?: string
  constructor(readonly unreadableFiles: number, message?: string) {
    super(message ?? `Backup inventory is incomplete: ${unreadableFiles} encrypted file(s) could not be read. Import the correct recovery keys or recover damaged files before continuing.`)
  }
}

/** A file in the backup container that could not be used. */
export interface DamagedFile {
  /** The encrypted file name on disk. */
  file: string
  reason: string
  /** Why it cannot be used, for the backup list's notice; see DamageKind. */
  kind: DamageKind
  /** The OS error code, for the os kind. */
  code?: string
  /** The backup folder the file belongs to, or null when it cannot be traced. */
  backup: string | null
}

/** Damage found while reading the backup container's inventory. */
export interface InventoryDamage {
  files: DamagedFile[]
  /** Backup folders (without the trailing slash) that cannot be used, with the reason. */
  unavailable: Map<string, string>
  /** Damaged files that could not be traced to a backup. */
  unattributed: number
}

const RECOVERY = "Import the recovery key it was made with, or restore the damaged files from a copy. Files that cannot be recovered can be removed from the backup folder."

/** Thrown by decrypt when no key in the keyring opens the data, damaged data included. */
const WRONG_KEY = "This backup was encrypted with a key this device does not have. Import its recovery key."

const KEY_REASON = "it is damaged, or was encrypted with a key this device does not have"
const DAMAGED_REASON = "it is damaged or incomplete"
const DUPLICATE_REASON = "another file holds the same backup item"
const OS_CODE = /^E[A-Z]+$/

/** Why a file could not be read: the reason for messages, and its kind and OS error code for the backup list. */
class Unreadable {
  constructor(readonly reason: string, readonly kind: DamageKind, readonly code?: string) {}
}

function unreadable(error: unknown): Unreadable {
  if (error instanceof Error && error.message === WRONG_KEY) return new Unreadable(KEY_REASON, "key")
  const code = (error as NodeJS.ErrnoException)?.code
  if (typeof code === "string" && OS_CODE.test(code)) return new Unreadable(`it could not be read (${code})`, "os", code)
  return new Unreadable(DAMAGED_REASON, "damaged")
}

/** A damaged file's record from the reason and kind of why it could not be read. */
const damagedFile = (file: string, why: Unreadable, backup: string | null): DamagedFile =>
  ({ file, reason: why.reason, kind: why.kind, ...(why.code ? { code: why.code } : {}), backup })

/**
 * The kind of a body damage record. Records written before kinds were kept have only the reason,
 * which then is one of the reasons unreadable gives.
 */
function rememberedUnreadable(record: { reason: string; kind?: DamageKind; code?: string }): Unreadable {
  if (record.kind) return new Unreadable(record.reason, record.kind, record.code)
  if (record.reason === KEY_REASON) return new Unreadable(record.reason, "key")
  const code = /^it could not be read \((E[A-Z]+)\)$/.exec(record.reason)?.[1]
  return code ? new Unreadable(record.reason, "os", code) : new Unreadable(record.reason, "damaged")
}

/**
 * Kept in the backup folder: the encrypted file names (no content) whose body could not be read,
 * with their stamp and the reason. Inventories read only .tvb files, so it is never a blob.
 */
const BODY_DAMAGE_FILE = ".tenuvault-damaged.json"

/** How long a delete trusts the last check of every file in its folder. */
const DELETE_RECHECK_MS = 5_000

/** Damaged files named in a message at most. */
export const MAX_NAMED_FILES = 10

const backupFolderOf = (name: string) => /^(backup-[^/]+)\//.exec(logicalBackupName(name))?.[1] ?? null

/** One sentence on the damage in a container, for messages. */
function describeDamage(damage: InventoryDamage): string {
  const files = damage.files.length
  const backups = damage.unavailable.size
  const parts = [
    ...(files ? [`${files} file${files === 1 ? "" : "s"} in the backup folder could not be read`] : []),
    ...(backups ? [`${backups} backup${backups === 1 ? " is" : "s are"} unavailable`] : []),
  ]
  return `${parts.join(" and ")}.`
}

/**
 * The damaged files by kind, for the backup list. The named files are shared out between the kinds
 * in turn, so each kind present has some of its files named.
 */
export function damageKinds(damage: InventoryDamage, limit = MAX_NAMED_FILES): DamagedFileKinds {
  const result: DamagedFileKinds = { counts: { key: 0, os: 0, duplicate: 0, damaged: 0 }, codes: [], names: { key: [], os: [], duplicate: [], damaged: [] } }
  const byKind = new Map<DamageKind, string[]>(DAMAGE_KINDS.map((kind) => [kind, []]))
  for (const file of damage.files) {
    result.counts[file.kind]++
    byKind.get(file.kind)!.push(file.file)
    if (file.code && !result.codes.includes(file.code)) result.codes.push(file.code)
  }
  for (let named = 0, round = 0; named < Math.min(limit, damage.files.length); round++) {
    for (const kind of DAMAGE_KINDS) {
      const file = byKind.get(kind)![round]
      if (file === undefined || named >= limit) continue
      result.names[kind].push(file)
      named++
    }
  }
  return result
}

/** The damage in a container in a few sentences, or null when there is none. */
export function damageSummary(damage: InventoryDamage): string | null {
  if (damage.files.length === 0 && damage.unavailable.size === 0) return null
  const reasons = [...new Set(damage.files.map((file) => file.reason))]
  const backups = [...damage.unavailable].slice(0, 3).map(([folder, reason]) => `${folder}: ${reason}`)
  return [
    describeDamage(damage),
    ...(reasons.length ? [`${reasons.length === 1 ? "Reason" : "Reasons"}: ${reasons.join("; ")}.`] : []),
    ...backups,
    ...(damage.unavailable.size > 3 ? [`And ${damage.unavailable.size - 3} more.`] : []),
  ].join(" ")
}

/** Syncs a directory so its entries survive a crash; a failure is logged, since the data itself is already written. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const directory = await open(dir, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    console.warn(`Failed to sync directory ${dir}: ${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}`)
  }
}

/** Creates a directory and syncs the parent of every directory it had to create, so the new entries survive a crash. */
async function mkdirDurable(path: string): Promise<void> {
  const created: string[] = []
  for (let probe = path; ; probe = dirname(probe)) {
    try {
      await stat(probe)
      break
    } catch {
      created.unshift(probe)
      if (dirname(probe) === probe) break
    }
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform === "win32") return
  for (const dir of created) await syncDirectory(dirname(dir))
}

export class LocalBlobStore {
  private readonly keyring: Keys[]
  private readonly index = new Map<string, Promise<Map<string, Entry>>>()
  private readonly directoryStamps = new Map<string, string>()
  private readonly dirty = new Set<string>()
  private readonly generations = new Map<string, number>()
  private readonly writes = new Map<string, number>()
  private readonly rebuilding = new Map<string, Promise<Map<string, Entry>>>()
  private readonly checks = new Map<string, { generation: number; started: boolean; entries: Promise<Map<string, Entry>> }>()
  /** Cleared once the folder's file system refuses a hard link. */
  private hardLinks = true
  private readonly blobWrites = new Map<string, Promise<void>>()
  /** Damage found by the read that built each inventory. */
  private readonly damageOf = new WeakMap<Map<string, Entry>, InventoryDamage>()
  /** When every file of each folder was last checked; see delete. */
  private readonly checkedAt = new Map<string, number>()
  /** File names derived for traced blob names; see fileNames. */
  private readonly fileNameCache = new Map<string, string[]>()
  /** Stamps of the damaged files of each inventory, so a repaired or removed file is noticed. */
  private readonly damagedStamps = new WeakMap<Map<string, Entry>, Map<string, string>>()

  /**
   * @param root   Folder that holds the encrypted backups.
   * @param masterKeys Current master key first, then older keys that must stay readable.
   * @param writeFormat Format for new files and overwrites; see WRITE_FORMAT.
   */
  constructor(
    private readonly root: string,
    masterKeys: Buffer[],
    private readonly writeFormat: Version = WRITE_FORMAT,
    private readonly guardWrites?: (path: string) => void,
    private readonly processInfo?: ProcessInfoReader,
  ) {
    if (masterKeys.length === 0) throw new Error("A backup encryption key is required.")
    this.keyring = masterKeys.map(deriveKeys)
  }

  async containerExists(account: string, container: string): Promise<boolean> {
    try {
      return (await stat(this.dir(account, container))).isDirectory()
    } catch {
      return false
    }
  }

  /** Returns false when the container already existed. */
  async createContainer(account: string, container: string): Promise<boolean> {
    const existed = await this.containerExists(account, container)
    const dir = this.dir(account, container)
    this.guardWrites?.(dir)
    await mkdirDurable(dir)
    if (!existed && !this.index.has(dir)) {
      // A container we just created starts with a known empty inventory.
      this.directoryStamps.set(dir, await this.directoryStamp(dir))
      this.index.set(dir, Promise.resolve(new Map()))
      this.changed(dir)
    }
    return !existed
  }

  async listContainers(account: string): Promise<string[]> {
    try {
      const entries = await readdir(join(this.root, safeSegment(account)), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    } catch {
      return []
    }
  }

  async list(account: string, container: string, prefix = ""): Promise<StoredBlob[]> {
    const entries = await this.checkedEntries(account, container)
    const folder = backupFolderOf(prefix)
    if (folder) this.assertAvailable(entries, folder)
    return [...entries.values()].filter((entry) => entry.name.startsWith(prefix))
      .map(({ file: _file, version: _version, stamp: _stamp, ...blob }) => blob).sort((a, b) => (a.name < b.name ? -1 : 1))
  }

  /** Damage in the container's current inventory; empty when there is none. */
  async damage(account: string, container: string): Promise<InventoryDamage> {
    const entries = await this.checkedEntries(account, container)
    return this.damageOf.get(entries) ?? { files: [], unavailable: new Map(), unattributed: 0 }
  }

  /** Every file name a blob can have, for each key and format. Remembered, since each takes an HMAC per key. */
  private fileNames(account: string, container: string, name: string): string[] {
    const key = JSON.stringify([account, container, name])
    let names = this.fileNameCache.get(key)
    if (!names) {
      names = this.keyring.flatMap((keys) => ([1, 2] as const).map((version) => fileName(version, keys.naming, account, container, name)))
      if (this.fileNameCache.size >= FILE_NAME_CACHE_LIMIT) this.fileNameCache.clear()
      this.fileNameCache.set(key, names)
    }
    return names
  }

  private assertAvailable(entries: Map<string, Entry>, folder: string): void {
    const damage = this.damageOf.get(entries)
    const reason = damage?.unavailable.get(folder)
    if (!damage || !reason) return
    const files = damage.files.filter((file) => file.backup === folder).map((file) => file.file)
    const named = files.length ? ` Affected file${files.length === 1 ? "" : "s"} in the backup folder: ${files.slice(0, MAX_NAMED_FILES).join(", ")}${files.length > MAX_NAMED_FILES ? `, and ${files.length - MAX_NAMED_FILES} more` : ""}.` : ""
    throw Object.assign(new IncompleteInventoryError(damage.files.length, `Backup ${folder} is unavailable: ${reason}${named} ${RECOVERY}`), { backup: folder })
  }

  /** A blob that is not in the inventory may be in a file that could not be traced, so it is not reported as missing then. */
  private missing(entries: Map<string, Entry>, name: string): Error {
    const damage = this.damageOf.get(entries)
    if (!damage?.unattributed) return new BlobNotFoundError(name)
    return new IncompleteInventoryError(damage.files.length, `${name} could not be found, and ${damage.unattributed} file${damage.unattributed === 1 ? "" : "s"} in the backup folder could not be read, so it may be in one of them. ${RECOVERY}`)
  }

  async get(account: string, container: string, name: string): Promise<{ blob: StoredBlob; data: Buffer }> {
    const dir = this.dir(account, container)
    let entries = this.dirty.has(dir) ? await this.checkedEntries(account, container) : await this.entries(account, container)
    let entry = entries.get(name)
    const folder = backupFolderOf(name)
    if (folder) this.assertAvailable(entries, folder)
    if (!entry) throw this.missing(entries, name)
    // A selective read checks its own file. Listings still verify every cached header,
    // and directory changes or our own writes still validate the complete manifest.
    let unchanged = false
    try { unchanged = fileStamp(await stat(join(dir, entry.file), { bigint: true })) === entry.stamp } catch { /* Rebuild missing or replaced files. */ }
    if (!unchanged) {
      this.changed(dir)
      this.index.delete(dir)
      entries = await this.checkedEntries(account, container)
      if (folder) this.assertAvailable(entries, folder)
      entry = entries.get(name)
      if (!entry) throw this.missing(entries, name)
    }
    return this.readBody(account, container, entry, entries)
  }

  private async readBody(account: string, container: string, entry: Entry, entries: Map<string, Entry>): Promise<{ blob: StoredBlob; data: Buffer }> {
    const { name } = entry
    const folder = backupFolderOf(name)
    const raw = await readFile(join(this.dir(account, container), entry.file))
    const version = versionOf(raw.subarray(0, MAGIC_LENGTH))
    if (!version) throw new Error("Invalid backup header")
    const headerLength = raw.readUInt16BE(MAGIC_LENGTH)
    const body = raw.subarray(MAGIC_LENGTH + 2 + headerLength)
    const { file: _file, version: _version, stamp: _stamp, ...blob } = entry
    try {
      return { blob, data: this.decrypt(body, bodyAad(version, account, container, name)) }
    } catch (error) {
      // Inventories check headers only, so a damaged body is found when it is read. Retrying cannot
      // repair it. It is recorded like other damage: its backup becomes unavailable and nothing is
      // deleted, until the file changes and the next listing reads the folder again.
      const why = unreadable(error)
      const { reason } = why
      const damage = this.damageOf.get(entries)
      if (damage && [BACKUP_CONTAINER, LARGE_BACKUP_CONTAINER].includes(container) && !damage.files.some((file) => file.file === entry.file)) {
        damage.files.push(damagedFile(entry.file, why, folder))
        if (folder && !damage.unavailable.has(folder)) damage.unavailable.set(folder, `one of its files could not be read: ${reason}.`)
        this.damagedStamps.get(entries)?.set(entry.file, entry.stamp)
        // Remembered on disk too, so a rebuilt inventory or a restart still knows until the file changes.
        const dir = this.dir(account, container)
        const remembered = await this.readBodyDamage(dir)
        remembered[entry.file] = { stamp: entry.stamp, reason, kind: why.kind, ...(why.code ? { code: why.code } : {}) }
        await this.writeBodyDamage(dir, remembered).catch(() => undefined)
      }
      throw Object.assign(new IncompleteInventoryError(1, `${name} could not be read: ${reason}. ${RECOVERY}`), folder ? { backup: folder } : {})
    }
  }

  /**
   * Writes one blob. Conditional writes (`ifMatch` with an ETag, or `*` for any
   * existing blob) to the same blob run one at a time, so the check holds until the
   * write is published. Unconditional writes are not ordered against them.
   */
  put(account: string, container: string, name: string, data: Uint8Array, contentType: string, createOnly = false, metadata?: Record<string, string>, ifMatch?: string): Promise<StoredBlob> {
    if (ifMatch === undefined) return this.putNow(account, container, name, data, contentType, createOnly, metadata, undefined)
    const key = `${this.dir(account, container)}\0${name}`
    const run = (this.blobWrites.get(key) ?? Promise.resolve()).then(() => this.putNow(account, container, name, data, contentType, createOnly, metadata, ifMatch))
    const tail = run.then(() => undefined, () => undefined)
    this.blobWrites.set(key, tail)
    void tail.then(() => { if (this.blobWrites.get(key) === tail) this.blobWrites.delete(key) })
    return run
  }

  private async putNow(account: string, container: string, name: string, data: Uint8Array, contentType: string, createOnly: boolean, metadata: Record<string, string> | undefined, ifMatch: string | undefined): Promise<StoredBlob> {
    const dir = this.dir(account, container)
    assertPrefixNotProtected(dir, name)
    if (!(await this.containerExists(account, container))) throw new BlobNotFoundError(container)
    const entries = await this.entries(account, container)
    const current = this.keyring[0]!
    const existing = entries.get(name)
    if (createOnly && existing) throw new BlobAlreadyExistsError(name)
    if (ifMatch !== undefined) {
      // Compare with the file on disk, which is what a GET returns as the ETag.
      let tag: string | null = null
      if (existing) {
        try { tag = `"${fileStamp(await stat(join(dir, existing.file), { bigint: true }))}"` } catch { /* Removed since listed. */ }
      }
      if (!tag || (ifMatch !== "*" && ifMatch !== tag)) throw new BlobConditionNotMetError(name)
    }
    // A version 1 file keeps its name when overwritten, so the blob never has two files.
    const version = this.writeFormat
    const file = existing?.file ?? fileName(version, current.naming, account, container, name)
    // A damaged file under the name this blob would get is kept for recovery, never written over.
    if (!existing && this.damageOf.get(entries)?.files.some((damaged) => damaged.file === file)) {
      throw new IncompleteInventoryError(1, `${name} was not written: the file it would replace (${file}) could not be read, and is kept for recovery. ${RECOVERY}`)
    }
    const created = existing?.created ?? new Date()

    const header = seal(current.encryption, Buffer.from(JSON.stringify({ name, contentType, created, ...(metadata ? { metadata } : {}) })), headerAad(version, account, container, file))
    const body = seal(current.encryption, Buffer.from(data), bodyAad(version, account, container, name))
    const length = Buffer.alloc(2)
    length.writeUInt16BE(header.length)

    return this.write(dir, async () => {
      assertPrefixNotProtected(dir, name)
      const path = join(dir, file)
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`
      let written: BigIntStats
      let donePut: (() => void) | undefined
      try {
        try {
          const handle = await open(tmp, "wx", 0o600)
          try {
            await handle.writeFile(Buffer.concat([version === 1 ? MAGIC_V1 : MAGIC_V2, length, header, body]))
            await handle.sync()
            written = await handle.stat({ bigint: true })
          } finally {
            await handle.close()
          }
          donePut = trackInFlightPut(dir, name)
          assertPrefixNotProtected(dir, name)
          if (createOnly) await this.publishNew(tmp, path)
          else await rename(tmp, path)
          this.changed(dir)
          if (process.platform !== "win32") await syncDirectory(dir)
        } catch (error) {
          if (createOnly && (error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new BlobAlreadyExistsError(name)
          }
          throw error
        } finally {
          await rm(tmp, { force: true })
        }

        const published = await stat(path, { bigint: true })
        const sameFile = published.dev === written.dev && published.ino === written.ino && published.size === written.size && published.mtimeNs === written.mtimeNs
        // Rename can change ctime. Use its final stamp only after verifying the written file's identity.
        const info = sameFile ? published : written
        const stamp = fileStamp(info)
        const blob: StoredBlob = { name, size: data.byteLength, contentType, created, lastModified: info.mtime, etag: `"${stamp}"`, ...(metadata ? { metadata } : {}) }
        if (sameFile) this.updateEntry(dir, entries, name, { ...blob, file, version, stamp })
        else {
          // Keep the replacement's authenticated filename and metadata for the next mutation.
          const replacement = await this.readEntry(dir, account, container, file)
          if (replacement !== VANISHED && !(replacement instanceof Unreadable) && replacement.name === name) this.updateEntry(dir, entries, name, replacement)
          else this.index.delete(dir)
          this.changed(dir)
        }
        return blob
      } finally {
        donePut?.()
      }
    })
  }

  /**
   * Deletes one blob. Nothing in the backup container is deleted while it holds damaged files or
   * an unavailable backup: a damaged file may be the only copy of what an older backup holds.
   * The check uses an inventory whose every file was checked within the last DELETE_RECHECK_MS
   * (a new or removed file always refreshes it), so a file damaged in place is found within a run
   * of deletes. despiteDamage is for removing files the caller has just written itself, such as
   * an archive import that is rolled back.
   */
  async delete(account: string, container: string, name: string, options: { despiteDamage?: boolean; ifMatch?: string; retentionLockId?: string; expectedReplacements?: readonly ExpectedReplacement[] } = {}): Promise<void> {
    const dir = this.dir(account, container)
    assertPrefixNotProtected(dir, name)
    // Every file is checked again at most every few seconds, so a file damaged in place is found
    // within a run of deletes without checking every file before each one.
    const fresh = Date.now() - (this.checkedAt.get(dir) ?? 0) > DELETE_RECHECK_MS
    const entries = fresh ? await this.checkedEntries(account, container) : await this.entries(account, container)
    const damage = this.damageOf.get(entries)
    if (!options.despiteDamage && damage && (damage.files.length > 0 || damage.unavailable.size > 0)) {
      throw new IncompleteInventoryError(damage.files.length, `${damageSummary(damage)} Nothing in the backup folder is deleted until this is resolved, so older backups are kept. ${RECOVERY}`)
    }
    const entry = entries.get(name)
    if (!entry) throw new BlobNotFoundError(name)
    if (!options.despiteDamage) {
      // Retention verifies the full candidate over the storage bridge and binds each delete to that
      // read. Direct deletes must also authenticate every body in the candidate before removing one.
      const folder = backupFolderOf(name)
      const candidate = !options.ifMatch && folder ? [...entries.values()].filter(blob => backupFolderOf(blob.name) === folder) : [entry]
      for (const blob of candidate) await this.readBody(account, container, blob, entries)
    }
    let renamed = false
    try {
      await this.write(dir, async () => {
        assertPrefixNotProtected(dir, name)
        if (options.retentionLockId !== undefined) {
          await this.assertRetentionLockHeld(dir, options.retentionLockId)
        }
        const path = join(dir, entry.file)
        const info = await lstat(path, { bigint: true })
        if (!info.isFile() || info.ino === 0n || `"${fileStamp(info)}"` !== (options.ifMatch ?? `"${entry.stamp}"`)) throw new BlobConditionNotMetError(name)
        const quarantine = await mkdtemp(join(dir, RETIRED_PREFIX))
        const held = join(quarantine, entry.file)
        const stamp = join(quarantine, RETIRED_STAMP)
        let needsRecovery = false
        try {
          await writeFile(stamp, "", { flag: "wx" })
          assertPrefixNotProtected(dir, name)
          if (options.retentionLockId !== undefined) {
            await this.assertRetentionLockHeld(dir, options.retentionLockId)
          }
          await rename(path, held)
          renamed = true
          needsRecovery = true
          this.changed(dir)
          const moved = await lstat(held, { bigint: true })
          // The rename can change ctime. Compare the attributes that survive it.
          if (!moved.isFile() || moved.ino === 0n || moved.dev !== info.dev || moved.ino !== info.ino
            || moved.size !== info.size || moved.mtimeNs !== info.mtimeNs) {
            this.index.delete(dir)
            try {
              await this.restoreQuarantinedFile(held, path, dir)
              needsRecovery = false
              renamed = false
            } catch (error) {
              throw new BlobQuarantinedError(`A different file was kept in ${held} (live path ${path}). Move it back only after checking the live file.`, { cause: error })
            }
            throw new BlobConditionNotMetError(name)
          }
          if (options.expectedReplacements?.length) {
            const changed = await this.findChangedReplacement(account, container, options.expectedReplacements, quarantine, dir, entries)
            if (changed) {
              this.index.delete(dir)
              let restoredEtag: string | undefined
              try {
                restoredEtag = await this.restoreQuarantinedFile(held, path, dir)
                needsRecovery = false
                renamed = false
              } catch (error) {
                throw new BlobQuarantinedError(`Replacement backup ${changed} changed during deletion and ${name} was kept in ${held} (live path ${path}). Move it back only after checking the live file.`, { cause: error })
              }
              throw new BlobReplacementChangedError(changed, undefined, restoredEtag)
            }
          }
          await rm(held)
          needsRecovery = false
          this.updateEntry(dir, entries, name)
        } finally {
          if (!needsRecovery) {
            await rm(stamp, { force: true }).catch(() => undefined)
            await rmdir(quarantine).catch(() => undefined)
          }
        }
      })
    } catch (error) {
      if (renamed && !(error instanceof BlobQuarantinedError)) {
        throw new BlobDeleteInterruptedError(error instanceof Error ? error.message : String(error), { cause: error })
      }
      throw error
    }
  }

  /**
   * Re-checks replacement expectations directly on disk after `rename(path, held)` and before
   * `rm(held)`, ignoring our own active quarantine folder. Groups replacements by their resolved
   * container (including `LARGE_BACKUP_CONTAINER` companions). Returns the first changed prefix,
   * or null when every expected replacement file matches and no extra/unreadable file appeared.
   */
  private async findChangedReplacement(
    account: string,
    container: string,
    expectedReplacements: readonly ExpectedReplacement[],
    currentQuarantine: string,
    currentDir: string,
    currentEntries: Map<string, Entry>,
  ): Promise<string | null> {
    const byContainer = new Map<string, ExpectedReplacement[]>()
    for (const rep of expectedReplacements) {
      const targetContainer = (container === BACKUP_CONTAINER || container === LARGE_BACKUP_CONTAINER)
        ? backupContainer(rep.prefix)
        : container
      const list = byContainer.get(targetContainer)
      if (list) list.push(rep)
      else byContainer.set(targetContainer, [rep])
    }
    for (const [targetContainer, reps] of byContainer) {
      const repDir = this.dir(account, targetContainer)
      const names = await this.names(repDir)
      if (names.length === 0) return reps[0]!.prefix
      const quarantineName = repDir === currentDir ? basename(currentQuarantine) : null
      if (names.some(file => file.startsWith(RETIRED_PREFIX) && file !== quarantineName)) {
        return reps[0]!.prefix
      }
      const filesOnDisk = new Set(names.filter(file => file.endsWith(EXT)))
      const knownEntries = repDir === currentDir ? currentEntries : await this.entries(account, targetContainer)
      const knownByFile = new Map<string, Entry>([...knownEntries.values()].map(entry => [entry.file, entry]))
      const matchedFiles = new Set<string>()
      for (const rep of reps) {
        const pairs = Object.entries(rep.blobs)
        if (pairs.length === 0) return rep.prefix
        for (const [logicalName, expectedEtag] of pairs) {
          const physicalName = backupBlobName(logicalName)
          const candidates = new Set<string>()
          const knownFile = knownEntries.get(physicalName)?.file ?? knownEntries.get(logicalName)?.file
          if (knownFile && filesOnDisk.has(knownFile)) candidates.add(knownFile)
          for (const candidate of this.fileNames(account, targetContainer, physicalName)) {
            if (filesOnDisk.has(candidate)) candidates.add(candidate)
          }
          let matched: string | null = null
          for (const candidate of candidates) {
            if (matchedFiles.has(candidate)) continue
            const info = await lstat(join(repDir, candidate), { bigint: true }).catch(() => null)
            if (info && info.isFile() && info.ino !== 0n && `"${fileStamp(info)}"` === expectedEtag) {
              matched = candidate
              break
            }
          }
          if (!matched) return rep.prefix
          matchedFiles.add(matched)
        }
      }
      const prefixes = reps.map(rep => rep.prefix)
      const otherFiles = [...filesOnDisk].filter(file => !matchedFiles.has(file))
      let extraChanged: string | null = null
      await mapLimit(otherFiles, HEADER_CONCURRENCY, async file => {
        if (extraChanged) return
        const info = await lstat(join(repDir, file), { bigint: true }).catch(() => null)
        if (!info) return
        if (!info.isFile()) {
          extraChanged ??= prefixes[0]!
          return
        }
        const known = knownByFile.get(file)
        if (known && fileStamp(info) === known.stamp) {
          const logical = logicalBackupName(known.name)
          const hit = prefixes.find(prefix => known.name.startsWith(prefix) || logical.startsWith(prefix))
          if (hit) extraChanged ??= hit
          return
        }
        const read = await this.readEntry(repDir, account, targetContainer, file)
        if (read === VANISHED) return
        if (read instanceof Unreadable) {
          extraChanged ??= prefixes[0]!
          return
        }
        const logical = logicalBackupName(read.name)
        const hit = prefixes.find(prefix => read.name.startsWith(prefix) || logical.startsWith(prefix))
        if (hit) extraChanged ??= hit
      })
      if (extraChanged) return extraChanged
    }
    return null
  }

  /**
   * Registers in-process write protection for the given prefixes in a container.
   * Returns a release function that must be called in a finally block.
   */
  protectPrefixes(account: string, container: string, prefixes: string[]): () => void {
    const dir = this.dir(account, container)
    const entries = prefixes.map(prefix => addProtectedPrefix(dir, prefix))
    let released = false
    return () => {
      if (released) return
      released = true
      for (const entry of entries) removeProtectedPrefix(entry)
    }
  }

  private registerLockProtectedPrefixes(account: string, container: string, dir: string, id: string, prefixes: string[] | undefined): Array<{ dir: string; prefix: string }> {
    if (!prefixes?.length) return []
    const resolvedDir = resolve(dir)
    const key = `${resolvedDir}\0${id}`
    const entries: Array<{ dir: string; prefix: string }> = []
    for (const prefix of prefixes) {
      const targetContainer = (container === BACKUP_CONTAINER || container === LARGE_BACKUP_CONTAINER)
        ? backupContainer(prefix)
        : container
      entries.push(addProtectedPrefix(this.dir(account, targetContainer), prefix))
    }
    lockProtectedEntries.set(key, entries)
    for (const listener of guardRegisteredListeners) listener(resolvedDir, id)
    return entries
  }

  private releaseLockProtectedPrefixes(dir: string, id: string): void {
    const key = `${resolve(dir)}\0${id}`
    const entries = lockProtectedEntries.get(key)
    if (!entries) return
    lockProtectedEntries.delete(key)
    for (const entry of entries) removeProtectedPrefix(entry)
  }

  private async assertRetentionLockHeld(dir: string, id: string): Promise<void> {
    const lockPath = join(dir, RETENTION_LOCK_FILE)
    let raw: string
    try {
      raw = await readFile(lockPath, "utf8")
    } catch (error) {
      throw new BlobLeaseConflictError(`The local retention lock ${lockPath} is no longer held.`, { cause: error })
    }
    const lock = parseRetentionLock(raw)
    if (!lock || lock.id !== id) {
      throw new BlobLeaseConflictError(`The local retention lock ${lockPath} is no longer held.`)
    }
  }

  private async ownProcessStart(): Promise<string> {
    if (!this.processInfo) return defaultCurrentProcessStart()
    const observed = await this.processInfo.readProcessStart(process.pid)
    return observed && observed !== "gone" ? observed : `unknown:${FALLBACK_PROCESS_START}`
  }

  private isPidAlive(pid: number): boolean {
    return (this.processInfo ?? defaultProcessInfoReader).isPidAlive(pid)
  }

  private readProcessStart(pid: number): Promise<string | "gone" | null> {
    return (this.processInfo ?? defaultProcessInfoReader).readProcessStart(pid)
  }

  private async publishLockFile(tmpPath: string, lockPath: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.hardLinks) {
      try {
        await link(tmpPath, lockPath)
        return
      } catch (error) {
        if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? "")) throw error
        this.hardLinks = false
      }
    }
    // Without hard links (for example exFAT drives), create the lock exclusively and write the record into the
    // same handle. A crash in the short gap between create and write leaves an empty lock, which retention reports
    // with the named manual warning; backups and restores are never blocked by it.
    const record = await readFile(tmpPath)
    signal?.throwIfAborted()
    const handle = await open(lockPath, "wx", 0o600)
    try {
      await handle.writeFile(record)
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(lockPath, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.close()
  }

  /**
   * Acquires an owner-and-process cross-process retention lock file scoped to one container directory.
   * Never expires while its holding process is alive; no time-based expiry or renewal.
   */
  async acquireRetentionLock(account: string, container: string, proposedId?: string, protectedPrefixes?: string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const dir = this.dir(account, container)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    signal?.throwIfAborted()
    const lockPath = join(dir, RETENTION_LOCK_FILE)
    const id = proposedId || randomBytes(16).toString("hex")
    const record: RetentionLockRecord = {
      id,
      host: hostname(),
      pid: process.pid,
      processStart: await this.ownProcessStart(),
      app: "TenuVault",
    }
    signal?.throwIfAborted()
    const tmpPath = join(dir, `${RETENTION_LOCK_FILE}.${randomBytes(8).toString("hex")}.tmp`)
    try {
      const handle = await open(tmpPath, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify(record))
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined)
      const code = (error as NodeJS.ErrnoException).code
      if (code && UNSUPPORTED_LOCK_ERRORS.has(code)) {
        throw new BlobLeaseUnsupportedError(`The backup folder does not support the local retention lock (${code}).`, { cause: error })
      }
      throw error
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted()
        let published = false
        try {
          await this.publishLockFile(tmpPath, lockPath, signal)
          published = true
          await rm(tmpPath, { force: true }).catch(() => undefined)
          if (process.platform !== "win32") await syncDirectory(dir)
          signal?.throwIfAborted()
          const registered = this.registerLockProtectedPrefixes(account, container, dir, id, protectedPrefixes)
          const prefixesByDir = new Map<string, string[]>()
          for (const entry of registered) {
            const list = prefixesByDir.get(entry.dir)
            if (list) list.push(entry.prefix)
            else prefixesByDir.set(entry.dir, [entry.prefix])
          }
          for (const [targetDir, targetPrefixes] of prefixesByDir) {
            await waitForInFlightPuts(targetDir, targetPrefixes, signal)
          }
          signal?.throwIfAborted()
          return id
        } catch (error) {
          if (published) {
            await this.releaseRetentionLock(account, container, id).catch(() => undefined)
            this.releaseLockProtectedPrefixes(dir, id)
            throw error
          }
          if (signal?.aborted) throw error
          const code = (error as NodeJS.ErrnoException).code
          if (code !== "EEXIST") {
            if (code && UNSUPPORTED_LOCK_ERRORS.has(code)) {
              throw new BlobLeaseUnsupportedError(`The backup folder does not support the local retention lock (${code}).`, { cause: error })
            }
            throw error
          }
          if (attempt > 0 || !(await this.reclaimStaleRetentionLock(lockPath, signal))) {
            throw new BlobLeaseConflictError("Another TenuVault instance is currently running retention on this backup folder.", {
              code: "LeaseAlreadyPresent",
              lockPath,
            })
          }
        }
      }
      throw new BlobLeaseConflictError("Another TenuVault instance is currently running retention on this backup folder.", {
        code: "LeaseAlreadyPresent",
        lockPath,
      })
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined)
    }
  }

  private async readRetentionLockState(lockPath: string): Promise<
    | { kind: "missing" }
    | { kind: "current"; lock: RetentionLockRecord }
    | { kind: "legacy"; lock: LegacyRetentionLockRecord }
    | { kind: "unparseable" }
  > {
    let raw: string
    try {
      const info = await lstat(lockPath, { bigint: true })
      if (!info.isFile()) {
        throw new BlobLeaseConflictError(manualLockWarning(lockPath, "the lock path is not a regular file"), {
          code: "RetentionLockManualIntervention",
          lockPath,
        })
      }
      raw = await readFile(lockPath, "utf8")
    } catch (error) {
      if (isMissing(error)) return { kind: "missing" }
      if (error instanceof BlobLeaseConflictError) throw error
      throw new BlobLeaseConflictError(manualLockWarning(lockPath, "the lock file could not be read"), {
        cause: error,
        code: "RetentionLockManualIntervention",
        lockPath,
      })
    }
    const current = parseRetentionLock(raw)
    if (current) return { kind: "current", lock: current }
    const legacy = parseLegacyRetentionLock(raw)
    if (legacy) return { kind: "legacy", lock: legacy }
    return { kind: "unparseable" }
  }

  private async reclaimLockAside(lockPath: string, matches: (movedRaw: string) => boolean): Promise<boolean> {
    const aside = `${lockPath}.${randomBytes(8).toString("hex")}.stale`
    try {
      await rename(lockPath, aside)
    } catch (error) {
      if (isMissing(error)) return true
      throw error
    }
    const movedRaw = await readFile(aside, "utf8").catch(() => null)
    if (movedRaw !== null && matches(movedRaw)) {
      await rm(aside, { force: true })
      return true
    }
    // The moved file did not match the stale lock we observed. Restore it by hard-link only if
    // lockPath is still free; otherwise keep the aside file and never unlink an unverified lock.
    try {
      await link(aside, lockPath)
      await rm(aside, { force: true }).catch(() => undefined)
    } catch {
      throw new BlobLeaseConflictError(
        `A live retention lock changed while reclaiming ${lockPath}. The moved lock file was kept at ${aside} and was not deleted; retention stopped for this run.`,
        { code: "RetentionLockManualIntervention", lockPath },
      )
    }
    const movedLock = movedRaw === null ? null : parseRetentionLock(movedRaw)
    throw new BlobLeaseConflictError("Another TenuVault instance is currently running retention on this backup folder.", {
      code: "LeaseAlreadyPresent",
      lockPath,
      ...(movedLock ? { holderId: movedLock.id } : {}),
    })
  }

  /**
   * Judges whether the recorded holder of a lock-shaped file is provably gone. Returns "live" only
   * for a same-host process whose comparable start token matches. Anything unobservable throws the
   * manual-intervention warning naming `path`, so the file is preserved.
   */
  private async assessLockHolder(path: string, lock: RetentionLockRecord): Promise<"stale" | "live"> {
    if (lock.host !== hostname()) {
      throw new BlobLeaseConflictError(manualLockWarning(path, `held by another computer (${lock.host})`), {
        code: "RetentionLockManualIntervention",
        lockPath: path,
      })
    }
    if (!this.isPidAlive(lock.pid)) return "stale"
    const observedStart = await this.readProcessStart(lock.pid)
    if (observedStart === "gone") return "stale"
    if (observedStart === null) {
      throw new BlobLeaseConflictError(
        manualLockWarning(path, `could not verify whether process ${lock.pid} is still the original holder`),
        { code: "RetentionLockManualIntervention", lockPath: path },
      )
    }
    const comparison = compareProcessStart(lock.processStart, observedStart)
    if (comparison === "incomparable") {
      throw new BlobLeaseConflictError(
        manualLockWarning(path, `could not compare process start token for process ${lock.pid}`),
        { code: "RetentionLockManualIntervention", lockPath: path },
      )
    }
    return comparison === "different" ? "stale" : "live"
  }

  /**
   * Creates the reclaim gate file `<lock>.reclaim` exclusively, serializing stale-lock reclaimers
   * across processes. Never auto-reclaims a gate created by another process (whether live or dead):
   * a live gate throws LeaseAlreadyPresent with its holderId/gatePath, and a dead, foreign, or
   * unreadable gate throws the named manual warning so no live gate can ever be moved. Only a gate
   * leaked by this exact process (recorded in `leakedReclaimGates`) may be removed here.
   */
  private async acquireReclaimGate(lockPath: string, signal?: AbortSignal): Promise<{ gatePath: string; id: string } | null> {
    const gatePath = `${lockPath}.reclaim`
    const id = randomBytes(16).toString("hex")
    const record: RetentionLockRecord = {
      id,
      host: hostname(),
      pid: process.pid,
      processStart: await this.ownProcessStart(),
      app: "TenuVault",
    }
    signal?.throwIfAborted()
    const tmpPath = `${gatePath}.${randomBytes(8).toString("hex")}.tmp`
    try {
      const handle = await open(tmpPath, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify(record))
        await handle.sync()
      } finally {
        await handle.close()
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted()
        try {
          await this.publishLockFile(tmpPath, gatePath, signal)
          return { gatePath, id }
        } catch (error) {
          if (signal?.aborted) throw error
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
        let gateState = await this.readRetentionLockState(gatePath)
        if (gateState.kind === "unparseable") {
          await waitMs(UNPARSEABLE_LOCK_REREAD_MS, signal)
          gateState = await this.readRetentionLockState(gatePath)
        }
        if (gateState.kind === "missing") continue
        if (gateState.kind !== "current") {
          throw new BlobLeaseConflictError(manualLockWarning(gatePath, "the reclaim gate file could not be parsed"), {
            code: "RetentionLockManualIntervention",
            lockPath: gatePath,
          })
        }
        const gateId = gateState.lock.id
        const leakedKey = `${resolve(gatePath)}\0${gateId}`
        const isOwnLeakedGate = gateState.lock.host === hostname()
          && gateState.lock.pid === process.pid
          && leakedReclaimGates.has(leakedKey)
        if (isOwnLeakedGate) {
          // Claim removal synchronously so no second caller in this process can also touch this gate.
          leakedReclaimGates.delete(leakedKey)
          signal?.throwIfAborted()
          try {
            await this.reclaimLockAside(gatePath, movedRaw => parseRetentionLock(movedRaw)?.id === gateId)
          } catch (error) {
            leakedReclaimGates.add(leakedKey)
            throw error
          }
          continue
        }
        if ((await this.assessLockHolder(gatePath, gateState.lock)) === "live") {
          throw new BlobLeaseConflictError("Another TenuVault instance is currently reclaiming the retention lock on this backup folder.", {
            code: "LeaseAlreadyPresent",
            lockPath: gatePath,
            holderId: gateId,
          })
        }
        throw new BlobLeaseConflictError(manualLockWarning(gatePath, "a leftover reclaim gate is present"), {
          code: "RetentionLockManualIntervention",
          lockPath: gatePath,
        })
      }
      return null
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined)
    }
  }

  /** Best-effort gate release: retries once, warns and records the leaked gate if release fails. */
  private async releaseReclaimGate(gatePath: string, id: string): Promise<void> {
    const leakedKey = `${resolve(gatePath)}\0${id}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const aside = `${gatePath}.${randomBytes(8).toString("hex")}.release`
      try {
        await rename(gatePath, aside)
      } catch (error) {
        if (isMissing(error)) {
          leakedReclaimGates.delete(leakedKey)
          return
        }
        if (attempt === 0) continue
        leakedReclaimGates.add(leakedKey)
        console.warn(`[backups] Could not release retention reclaim gate ${gatePath}; left in place.`, error)
        return
      }
      const movedRaw = await readFile(aside, "utf8").catch(() => null)
      if (movedRaw !== null && parseRetentionLock(movedRaw)?.id === id) {
        leakedReclaimGates.delete(leakedKey)
        await rm(aside, { force: true }).catch(() => undefined)
        return
      }
      try {
        await link(aside, gatePath)
        await rm(aside, { force: true }).catch(() => undefined)
      } catch {
        console.warn(`[backups] Retention reclaim gate ${gatePath} changed during release; the moved gate file was kept at ${aside}.`)
      }
      return
    }
  }

  /**
   * Removes a lock already judged stale, serialized by an unstealable reclaim gate.
   * Invariant: the reclaim gate is never auto-reclaimed by another process or caller, so only
   * the current gate holder can enter this section. A stale lock S has a dead owner (or expired
   * legacy timestamp), so S can only be removed by the gate holder. Re-reading lockPath while
   * holding the gate and observing exactly S therefore guarantees S cannot be replaced before
   * reclaimLockAside renames it; no live lock can ever be moved.
   */
  private async reclaimUnderGate(
    lockPath: string,
    isJudgedStale: (state: Awaited<ReturnType<LocalBlobStore["readRetentionLockState"]>>) => boolean,
    matchesMoved: (movedRaw: string) => boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const gate = await this.acquireReclaimGate(lockPath, signal)
    if (!gate) return false
    try {
      signal?.throwIfAborted()
      const state = await this.readRetentionLockState(lockPath)
      if (state.kind === "missing") return true
      if (!isJudgedStale(state)) return false
      const gateState = await this.readRetentionLockState(gate.gatePath)
      if (gateState.kind !== "current" || gateState.lock.id !== gate.id) return false
      return await this.reclaimLockAside(lockPath, matchesMoved)
    } finally {
      await this.releaseReclaimGate(gate.gatePath, gate.id)
    }
  }

  private async reclaimStaleRetentionLock(lockPath: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    let state = await this.readRetentionLockState(lockPath)
    if (state.kind === "unparseable") {
      await waitMs(UNPARSEABLE_LOCK_REREAD_MS, signal)
      state = await this.readRetentionLockState(lockPath)
    }
    signal?.throwIfAborted()
    if (state.kind === "missing") return true
    if (state.kind === "unparseable") {
      throw new BlobLeaseConflictError(manualLockWarning(lockPath, "the lock file could not be parsed"), {
        code: "RetentionLockManualIntervention",
        lockPath,
      })
    }
    if (state.kind === "legacy") {
      const legacy = state.lock
      if (legacy.expiresAt > Date.now()) {
        throw new BlobLeaseConflictError(
          manualLockWarning(lockPath, "a legacy retention lock from an earlier version has not expired"),
          { code: "RetentionLockManualIntervention", lockPath },
        )
      }
      signal?.throwIfAborted()
      return this.reclaimUnderGate(
        lockPath,
        current => current.kind === "legacy" && current.lock.id === legacy.id && current.lock.expiresAt === legacy.expiresAt,
        movedRaw => {
          const moved = parseLegacyRetentionLock(movedRaw)
          return moved?.id === legacy.id && moved.expiresAt === legacy.expiresAt
        },
        signal,
      )
    }
    const { lock } = state
    const assessment = await this.assessLockHolder(lockPath, lock)
    signal?.throwIfAborted()
    if (assessment === "live") {
      throw new BlobLeaseConflictError("Another TenuVault instance is currently running retention on this backup folder.", {
        code: "LeaseAlreadyPresent",
        lockPath,
        holderId: lock.id,
      })
    }
    return this.reclaimUnderGate(
      lockPath,
      current => current.kind === "current" && current.lock.id === lock.id,
      movedRaw => parseRetentionLock(movedRaw)?.id === lock.id,
      signal,
    )
  }

  async releaseRetentionLock(account: string, container: string, id: string): Promise<{ warning?: string }> {
    const dir = this.dir(account, container)
    const lockPath = join(dir, RETENTION_LOCK_FILE)
    try {
      let raw: string
      try {
        raw = await readFile(lockPath, "utf8")
      } catch (error) {
        if (isMissing(error)) return {}
        const warning = `Could not read local retention lock ${lockPath} during release; left in place.`
        console.warn(`[backups] ${warning}`, error)
        return { warning }
      }
      const parsed = parseRetentionLock(raw)
      if (!parsed || parsed.id !== id) {
        const warning = `Local retention lock ${lockPath} no longer belongs to this instance; left untouched.`
        console.warn(`[backups] ${warning}`)
        return { warning }
      }
      const aside = `${lockPath}.${randomBytes(8).toString("hex")}.release`
      try {
        await rename(lockPath, aside)
      } catch (error) {
        if (isMissing(error)) return {}
        throw error
      }
      const movedRaw = await readFile(aside, "utf8").catch(() => null)
      const moved = movedRaw === null ? null : parseRetentionLock(movedRaw)
      if (moved?.id === id) {
        await rm(aside, { force: true })
        return {}
      }
      try {
        await link(aside, lockPath)
        await rm(aside, { force: true }).catch(() => undefined)
        const warning = `Local retention lock ${lockPath} changed during release and was restored.`
        console.warn(`[backups] ${warning}`)
        return { warning }
      } catch {
        const warning = `Local retention lock ${lockPath} changed during release; the unverified lock file was kept at ${aside} and was not deleted.`
        console.warn(`[backups] ${warning}`)
        return { warning }
      }
    } finally {
      this.releaseLockProtectedPrefixes(dir, id)
    }
  }

  /**
   * Publishes a complete temporary file under a name that must not exist yet. A hard link does
   * both atomically across store and process instances. File systems without hard links (exFAT,
   * FAT32, some network shares) claim the name with an exclusive create instead, so a second
   * writer still fails with EEXIST, then rename the complete file over the empty claim. Readers
   * skip an empty file, so the claim is never reported as unreadable. A claim left behind by a
   * crash is taken over once it is older than STALE_CLAIM_MS.
   */
  private async publishNew(tmp: string, path: string): Promise<void> {
    try {
      await this.createNew(tmp, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await this.removeStaleClaim(path))) throw error
      await this.createNew(tmp, path)
    }
  }

  private async createNew(tmp: string, path: string): Promise<void> {
    if (this.hardLinks) {
      try {
        await link(tmp, path)
        return
      } catch (error) {
        if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? "")) throw error
        this.hardLinks = false
      }
    }
    await (await open(path, "wx", 0o600)).close()
    try {
      await rename(tmp, path)
    } catch (error) {
      await rm(path, { force: true })
      throw error
    }
  }

  /**
   * Removes an empty claim that no writer finished, and returns whether it did. The claim is moved
   * aside first, so of several writers taking over the same claim only one moves it; a file that
   * turns out not to be that claim is put back.
   */
  private async removeStaleClaim(path: string): Promise<boolean> {
    try {
      const claim = await stat(path, { bigint: true })
      if (claim.size !== 0n || Date.now() - Number(claim.mtimeMs) < STALE_CLAIM_MS) return false
      const aside = `${path}.${randomBytes(4).toString("hex")}.stale`
      await rename(path, aside)
      const moved = await stat(aside, { bigint: true })
      if (moved.ino !== claim.ino || moved.size !== 0n) {
        await rename(aside, path)
        return false
      }
      await rm(aside, { force: true })
      return true
    } catch {
      return false
    }
  }

  /** Own directory mutations update the cache without making the next put rebuild it. */
  private async write<T>(dir: string, run: () => Promise<T>): Promise<T> {
    this.guardWrites?.(dir)
    this.writes.set(dir, (this.writes.get(dir) ?? 0) + 1)
    this.changed(dir)
    try {
      const result = await run()
      let generation: number, stamp: string
      do {
        generation = this.generations.get(dir) ?? 0
        stamp = await this.directoryStamp(dir)
      } while ((this.generations.get(dir) ?? 0) !== generation)
      this.directoryStamps.set(dir, stamp)
      // Keep the inventory dirty: this stamp may include an external mutation, so
      // the next read/list must still reconcile membership and validate manifests.
      this.changed(dir)
      return result
    } catch (error) {
      this.changed(dir)
      this.index.delete(dir)
      throw error
    } finally {
      const remaining = this.writes.get(dir)! - 1
      if (remaining) this.writes.set(dir, remaining)
      else this.writes.delete(dir)
    }
  }

  private updateEntry(dir: string, entries: Map<string, Entry>, name: string, entry?: Entry): void {
    const update = (current: Map<string, Entry>) => { if (entry) current.set(name, entry); else current.delete(name) }
    update(entries)
    // A listing may have started another index while the write was publishing.
    // Update it when ready without making publication wait for that listing.
    void this.index.get(dir)?.then(update).catch(() => undefined)
  }

  private dir(account: string, container: string): string {
    return join(this.root, safeSegment(account), safeSegment(container))
  }

  private async directoryStamp(dir: string): Promise<string> {
    try {
      const info = await stat(dir, { bigint: true })
      return fileStamp(info)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
      throw error
    }
  }

  /** Coalesces checks requested together; later listings wait for a fresh membership and file check. */
  private checkedEntries(account: string, container: string): Promise<Map<string, Entry>> {
    const dir = this.dir(account, container)
    const generation = this.generations.get(dir) ?? 0
    const pending = this.checks.get(dir)
    if (pending?.generation === generation && !pending.started) return pending.entries
    // An invalidated check must not delay or supply a read from the new generation.
    const running = pending?.generation === generation ? pending.entries.catch(() => undefined) : undefined
    const check = { generation, started: false, entries: Promise.resolve(new Map<string, Entry>()) }
    check.entries = (async () => {
      await running
      if ((this.generations.get(dir) ?? 0) !== generation) return this.checkedEntries(account, container)
      check.started = true
      try {
        let entries = await this.entries(account, container)
        const names = await this.names(dir)
        const files = new Set(names.filter(file => file.endsWith(EXT)))
        // Directory stamps can be coarse on a shared folder, so always reconcile names.
        // Damaged files count too, so a file that is repaired, replaced or removed is read again.
        const damaged = this.damagedStamps.get(entries) ?? new Map<string, string>()
        const known = new Map<string, string>([...damaged, ...[...entries.values()].map((entry): [string, string] => [entry.file, entry.stamp])])
        const sameFiles = files.size === known.size && [...known.keys()].every(file => files.has(file))
        const unchanged = !names.some(file => file.startsWith(RETIRED_PREFIX)) && !this.dirty.has(dir) && sameFiles && (await mapLimit([...known], HEADER_CONCURRENCY, async ([file, stamp]) => {
          try { return fileStamp(await stat(join(dir, file), { bigint: true })) === stamp } catch { return false }
        })).every(Boolean)
        if ((this.generations.get(dir) ?? 0) !== generation) return this.checkedEntries(account, container)
        if (!unchanged) {
          this.index.delete(dir)
          entries = await this.entries(account, container, entries)
        }
        if ((this.generations.get(dir) ?? 0) !== generation) return this.checkedEntries(account, container)
        this.checkedAt.set(dir, Date.now())
        return entries
      } catch (error) {
        if ((this.generations.get(dir) ?? 0) !== generation) return this.checkedEntries(account, container)
        throw error
      }
    })()
    this.checks.set(dir, check)
    void check.entries.finally(() => { if (this.checks.get(dir) === check) this.checks.delete(dir) }).catch(() => undefined)
    return check.entries
  }

  /** Reuses headers across own writes; external directory changes still rebuild the inventory. */
  private async entries(account: string, container: string, reuse?: Map<string, Entry>): Promise<Map<string, Entry>> {
    const dir = this.dir(account, container)
    const generation = this.generations.get(dir) ?? 0
    const stamp = await this.directoryStamp(dir)
    if ((this.generations.get(dir) ?? 0) !== generation) return this.entries(account, container, reuse)
    const previous = reuse ?? this.index.get(dir)
    if (!this.writes.has(dir) && !this.rebuilding.has(dir) && this.directoryStamps.get(dir) !== stamp) this.index.delete(dir)
    let cached = this.index.get(dir)
    if (!cached) {
      cached = this.readIndex(dir, account, container, previous).then(entries => {
        if (this.index.get(dir) === cached) {
          if ((this.generations.get(dir) ?? 0) === generation) {
            this.directoryStamps.set(dir, stamp)
            this.dirty.delete(dir)
          } else this.dirty.add(dir)
        }
        return entries
      }).finally(() => { if (this.rebuilding.get(dir) === cached) this.rebuilding.delete(dir) })
      this.rebuilding.set(dir, cached)
      this.index.set(dir, cached)
      const current = cached
      void cached.catch(() => { if (this.index.get(dir) === current) this.index.delete(dir) })
    }
    return cached
  }

  private changed(dir: string): void {
    this.generations.set(dir, (this.generations.get(dir) ?? 0) + 1)
    this.dirty.add(dir)
  }

  private async names(dir: string): Promise<string[]> {
    try {
      return await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }

  /**
   * Restores a quarantined file to its live path without ever overwriting an occupied live name.
   * Uses a hard link where supported, resuming cleanly if a prior crash left both names linked to
   * the same file. On volumes without hard links (for example exFAT), creates the live file
   * exclusively ("wx"), writes and fsyncs the full bytes, syncs the directory, and removes the
   * held copy. If the live path already exists with identical encrypted bytes, removes the held
   * copy; for any other occupied live path (including 0-byte or partial files), never overwrites
   * live because .tvb names are path-addressed and cross-process writers can target the same path.
   * Returns the restored file's ETag only when bound to the exact file just restored.
   */
  private async restoreQuarantinedFile(held: string, live: string, dir: string): Promise<string | undefined> {
    const heldInfo = await lstat(held, { bigint: true })
    if (this.hardLinks) {
      try {
        await link(held, live)
        if (process.platform !== "win32") await syncDirectory(dir)
        await rm(held)
        return await boundRestoredEtag(live, heldInfo)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ""
        if (code === "EEXIST") {
          if (await isSameFile(held, live)) {
            await rm(held)
            return await boundRestoredEtag(live, heldInfo)
          }
          throw new QuarantineRestoreConflictError(held, live)
        }
        if (!NO_HARD_LINKS.has(code)) throw error
        this.hardLinks = false
      }
    }
    const data = await readFile(held)
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(live, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (await isSameFile(held, live)) {
          await rm(held)
          return await boundRestoredEtag(live, heldInfo)
        }
        const identicalInfo = await identicalLiveCopyInfo(live, data)
        if (identicalInfo) {
          await rm(held)
          return await boundRestoredEtag(live, identicalInfo)
        }
        throw new QuarantineRestoreConflictError(held, live)
      }
      throw error
    }
    let writtenInfo: BigIntStats
    try {
      await handle.writeFile(data)
      await handle.sync()
      writtenInfo = await handle.stat({ bigint: true })
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
    await handle.close()
    if (process.platform !== "win32") await syncDirectory(dir)
    await rm(held)
    if (writtenInfo.size !== BigInt(data.length)) return undefined
    return await boundRestoredEtag(live, writtenInfo)
  }

  private async recoverRetired(dir: string, account: string, container: string, names: string[]): Promise<DamagedFile[]> {
    const held: Array<{ folder: string; file: string; since: number }> = []
    const damage: DamagedFile[] = []
    const report = (file: string, reason: string, backup: string | null = null) => {
      // Inventory details also travel in HTTP headers. Only expose names the store would create.
      const safeName = /^\.retired-[a-z0-9]+(?:\/[0-9a-f]{1,64}\.tvb)?$/i.test(file) ? file : RETIRED_PREFIX
      damage.push({ file: safeName, reason, kind: "damaged", backup })
    }
    for (const folder of names.filter(name => name.startsWith(RETIRED_PREFIX))) {
      try {
        const path = join(dir, folder)
        if (!(await lstat(path)).isDirectory()) {
          report(folder, "the interrupted cleanup folder could not be opened")
          continue
        }
        const files = await readdir(path)
        // Directory mtime also covers older quarantines and a delayed rename after a stamp write.
        const stamp = await lstat(join(path, RETIRED_STAMP)).catch(error => {
          if (!isMissing(error)) throw error
        })
        const directoryTime = (await lstat(path)).mtimeMs
        const since = Math.max(directoryTime, stamp ? (stamp.isFile() ? stamp.mtimeMs : Infinity) : 0)
        for (const file of files) if (file !== RETIRED_STAMP) held.push({ folder, file, since })
      } catch (error) {
        if (!isMissing(error)) report(folder, "the interrupted cleanup folder could not be read")
      }
    }
    const counts = new Map<string, number>()
    for (const { file } of held) counts.set(file, (counts.get(file) ?? 0) + 1)
    for (const { folder, file, since } of held) {
      const path = join(dir, folder, file)
      let backup: string | null = null
      let conflictReason: string | undefined
      try {
        const info = await lstat(path)
        if (info.isFile() && /^[a-f0-9]+\.tvb$/i.test(file)) {
          const entry = await this.readEntry(join(dir, folder), account, container, file)
          if (entry !== VANISHED && !(entry instanceof Unreadable)) {
            backup = backupFolderOf(entry.name)
            if (counts.get(file) === 1 && Date.now() - since > RETIRED_GRACE_MS && !isPrefixProtected(dir, entry.name)) {
              await this.restoreQuarantinedFile(path, join(dir, file), dir)
              await rm(join(dir, folder, RETIRED_STAMP), { force: true }).catch(() => undefined)
              await rmdir(join(dir, folder)).catch(() => undefined)
              continue
            }
          }
        }
      } catch (error) {
        if (isMissing(error)) continue
        if (error instanceof QuarantineRestoreConflictError) {
          conflictReason = `a file was kept at ${error.held} after interrupted cleanup because ${error.live} already exists. Close TenuVault and follow the backup storage recovery instructions`
        }
      }
      report(`${folder}/${file}`, conflictReason ?? "a file was kept after interrupted cleanup. Close TenuVault and follow the backup storage recovery instructions", backup)
    }
    return damage
  }

  /**
   * Returns Unreadable for a file that cannot be read, and VANISHED for one removed since it was listed
   * or an empty file. Every blob file has a header, so an empty one is a create-only claim that a
   * writer is about to fill or never finished (see publishNew), not a damaged blob.
   */
  private async readEntry(dir: string, account: string, container: string, file: string): Promise<Entry | Unreadable | typeof VANISHED> {
    const path = join(dir, file)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, "r")
      const prefix = Buffer.alloc(MAGIC_LENGTH + 2)
      const prefixRead = await handle.read(prefix, 0, prefix.length, 0)
      if (prefixRead.bytesRead === 0 && (await handle.stat()).size === 0) return VANISHED
      const version = prefixRead.bytesRead === prefix.length ? versionOf(prefix.subarray(0, MAGIC_LENGTH)) : null
      if (!version) throw new Error("Invalid backup header")
      const headerLength = prefix.readUInt16BE(MAGIC_LENGTH)
      const sealed = Buffer.alloc(headerLength)
      const headerRead = await handle.read(sealed, 0, headerLength, prefix.length)
      if (headerLength < IV + TAG || headerRead.bytesRead !== headerLength) throw new Error("Truncated backup header")
      const header = JSON.parse(this.decrypt(sealed, headerAad(version, account, container, file)).toString()) as {
        name: string
        contentType: string
        created: string
        metadata?: Record<string, string>
      }
      if (!header || typeof header.name !== "string" || !header.name || typeof header.contentType !== "string" || !Number.isFinite(Date.parse(header.created))) {
        throw new Error("Invalid backup header")
      }
      const info = await handle.stat({ bigint: true })
      if (Number(info.size) < prefix.length + headerLength + IV + TAG) throw new Error("Truncated backup body")
      return {
        file,
        version,
        name: header.name,
        contentType: header.contentType,
        created: new Date(header.created),
        lastModified: info.mtime,
        size: Number(info.size) - prefix.length - headerLength - IV - TAG,
        stamp: fileStamp(info),
        etag: `"${fileStamp(info)}"`,
        ...(header.metadata ? { metadata: header.metadata } : {}),
      }
    } catch (error) {
      return isMissing(error) ? VANISHED : unreadable(error)
    } finally {
      await handle?.close()
    }
  }

  private async readIndex(dir: string, account: string, container: string, previous?: Map<string, Entry> | Promise<Map<string, Entry>>): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>()
    const names = await this.names(dir)
    const retired = await this.recoverRetired(dir, account, container, names)
    const files = (names.some(name => name.startsWith(RETIRED_PREFIX)) ? await this.names(dir) : names).filter(file => file.endsWith(EXT))
    const cached = await Promise.resolve(previous).catch(() => undefined)
    const byFile = new Map([...(cached?.values() ?? [])].map(entry => [entry.file, entry]))
    // Headers are read a few at a time and added in directory order, so duplicates are found as before.
    // The stamp of each file before its header is read: a damaged file is remembered by it, so a
    // file still being written when it was read is read again once it changes.
    const before = new Map<string, string>()
    const read = await mapLimit(files, HEADER_CONCURRENCY, async (file): Promise<Entry | Unreadable | typeof VANISHED> => {
      try {
        const stamp = fileStamp(await stat(join(dir, file), { bigint: true }))
        before.set(file, stamp)
        const cached = byFile.get(file)
        if (cached && stamp === cached.stamp) return cached
        return this.readEntry(dir, account, container, file)
      } catch (error) {
        return isMissing(error) ? VANISHED : unreadable(error)
      }
    })
    const unreadableFiles: Array<{ file: string; why: Unreadable }> = []
    // Every file that claims a blob another file also claims: none of them can be trusted.
    const claims = new Map<string, string[]>()
    for (const [index, entry] of read.entries()) {
      // A file removed since the listing (retention, another device) is simply gone, and an empty claim holds no blob yet.
      if (entry === VANISHED) continue
      if (entry instanceof Unreadable) {
        unreadableFiles.push({ file: files[index]!, why: entry })
        continue
      }
      const first = entries.get(entry.name)
      if (first || claims.has(entry.name)) {
        claims.set(entry.name, [...(claims.get(entry.name) ?? [first!.file]), entry.file])
        entries.delete(entry.name)
        continue
      }
      entries.set(entry.name, entry)
    }
    // Other containers fail closed, as the backup container did before damage could be traced.
    if (![BACKUP_CONTAINER, LARGE_BACKUP_CONTAINER].includes(container)) {
      const count = retired.length + unreadableFiles.length + [...claims.values()].reduce((sum, list) => sum + list.length, 0)
      if (count) throw new IncompleteInventoryError(count)
      return entries
    }

    const damage: InventoryDamage = { files: retired, unavailable: new Map(), unattributed: retired.filter(file => file.backup === null).length }
    const unavailable = (folder: string, reason: string) => { if (!damage.unavailable.has(folder)) damage.unavailable.set(folder, reason) }
    for (const file of retired) {
      if (file.backup) unavailable(file.backup, file.reason + ".")
    }
    for (const [name, claimed] of claims) {
      const folder = backupFolderOf(name)
      for (const file of claimed) damage.files.push({ file, reason: DUPLICATE_REASON, kind: "duplicate", backup: folder })
      if (folder) unavailable(folder, "two files hold the same backup item.")
      else damage.unattributed += claimed.length
    }

    // Blob names whose files can be traced to a backup folder, by the encrypted file name they would have.
    const folders = new Set([...entries.keys(), ...claims.keys()].map(backupFolderOf).filter((folder) => folder !== null))
    const traced = new Map<string, string>()
    for (const folder of folders) traced.set(`${folder}/metadata.json`, folder).set(`${folder}/${BACKUP_OWNER_FILE}`, folder).set(`${folder}/${BACKUP_RUN_RECORD_FILE}`, folder)
    const withManifest = new Set<string>()
    // Folders whose metadata.json has no item list (backups from versions before the manifest).
    const legacy = new Set<string>()

    // Desktop metadata already contains a per-item manifest. Check it before
    // exposing any inventory to downloads or restores, including selective reads.
    for (const entry of entries.values()) {
      if (!/^backup-[^/]+\/metadata\.json$/.test(entry.name)) continue
      const folder = backupFolderOf(entry.name)!
      let metadata: { Items?: unknown; LargeItems?: unknown }
      try {
        const raw = await readFile(join(dir, entry.file))
        const body = raw.subarray(MAGIC_LENGTH + 2 + raw.readUInt16BE(MAGIC_LENGTH))
        metadata = JSON.parse(this.decrypt(body, bodyAad(entry.version, account, container, entry.name)).toString())
      } catch (error) {
        // A manifest removed since the listing no longer describes a backup.
        if (isMissing(error)) { entries.delete(entry.name); continue }
        damage.files.push(damagedFile(entry.file, unreadable(error), folder))
        unavailable(folder, "its manifest (metadata.json) could not be read.")
        continue
      }
      if (metadata?.Items === undefined) { legacy.add(folder); continue } // Legacy backups have no inventory manifest.
      if (!metadata.Items || typeof metadata.Items !== "object" || Array.isArray(metadata.Items)) {
        unavailable(folder, "its manifest (metadata.json) is not valid.")
        continue
      }
      const prefix = backupBlobName(`${folder}/`)
      let missing = 0
      let valid = true
      for (const [key, item] of Object.entries(metadata.Items)) {
        const type = key.split("/")[0]
        const file = (item as { file?: unknown } | null)?.file
        if (!type || typeof file !== "string" || !file || file.includes("/") || file.includes("\\")) { valid = false; break }
        const name = `${prefix}${type}/${file}`
        traced.set(name, folder)
        if (!entries.has(name)) missing++
      }
      if (metadata.LargeItems) {
        try {
          for (const [type, index] of Object.entries(largeIndexes(metadata))) {
            for (let shard = 0; shard < index.shards; shard++) {
              const name = `${prefix}${indexPath(type, shard)}`
              traced.set(name, folder)
              if (!entries.has(name)) missing++
            }
          }
          // Unknown damaged headers may belong to a large snapshot outside the inline inventory.
          // Its index will be checked lazily, so do not exempt it from unattributed damage.
          legacy.add(folder)
        } catch { valid = false }
      }
      if (!valid) unavailable(folder, "its manifest (metadata.json) is not valid.")
      else if (missing) unavailable(folder, `${missing} file${missing === 1 ? "" : "s"} listed in its manifest ${missing === 1 ? "is" : "are"} missing or damaged.`)
      else withManifest.add(folder)
    }

    if (unreadableFiles.length) {
      const byFileName = new Map<string, string>()
      for (const [name, folder] of traced) {
        for (const file of this.fileNames(account, container, name)) byFileName.set(file, folder)
      }
      for (const { file, why } of unreadableFiles) {
        const folder = byFileName.get(file) ?? null
        damage.files.push(damagedFile(file, why, folder))
        if (folder) unavailable(folder, `one of its files could not be read: ${why.reason}.`)
        else damage.unattributed++
      }
    }
    // A file that cannot be traced may belong to any finished backup whose files cannot be checked
    // against a manifest. A folder without metadata.json is still being written or stopped early,
    // and is already shown as running or incomplete; a backup writing to it must be able to read
    // back what it wrote.
    if (damage.unattributed > 0) {
      for (const folder of legacy) unavailable(folder, "files in the backup folder could not be read, and this backup has no manifest to show that none of them are its own.")
    }
    // Bodies found damaged when read earlier stay damaged until their file changes.
    const remembered = await this.readBodyDamage(dir)
    const entryOfFile = new Map([...entries.values()].map((entry) => [entry.file, entry]))
    let forgotten = false
    for (const [file, record] of Object.entries(remembered)) {
      const { stamp, reason } = record
      const entry = entryOfFile.get(file)
      if (!entry || entry.stamp !== stamp) {
        delete remembered[file]
        forgotten = true
        continue
      }
      const folder = backupFolderOf(entry.name)
      if (!damage.files.some((damaged) => damaged.file === file)) damage.files.push(damagedFile(file, rememberedUnreadable(record), folder))
      if (folder) unavailable(folder, `one of its files could not be read: ${reason}.`)
    }
    if (forgotten) await this.writeBodyDamage(dir, remembered).catch(() => undefined)
    this.damageOf.set(entries, damage)
    this.damagedStamps.set(entries, new Map(damage.files.map(({ file }) => [file, before.get(file) ?? "missing"])))
    return entries
  }

  /** Files whose body could not be read, by the stamp they had then; see BODY_DAMAGE_FILE. */
  private async readBodyDamage(dir: string): Promise<Record<string, BodyDamage>> {
    try {
      const value = JSON.parse(await readFile(join(dir, BODY_DAMAGE_FILE), "utf8")) as unknown
      if (!value || typeof value !== "object" || Array.isArray(value)) return {}
      return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, BodyDamage] => {
        const [file, record] = pair as [string, { stamp?: unknown; reason?: unknown; kind?: unknown; code?: unknown } | null]
        return file.endsWith(EXT) && !!record && typeof record.stamp === "string" && typeof record.reason === "string"
          && (record.kind === undefined || DAMAGE_KINDS.includes(record.kind as DamageKind))
          && (record.code === undefined || (typeof record.code === "string" && OS_CODE.test(record.code)))
      }))
    } catch {
      return {}
    }
  }

  private async writeBodyDamage(dir: string, value: Record<string, BodyDamage>): Promise<void> {
    this.guardWrites?.(dir)
    const path = join(dir, BODY_DAMAGE_FILE)
    if (Object.keys(value).length === 0) {
      await rm(path, { force: true })
      return
    }
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await rename(tmp, path)
  }

  private decrypt(sealed: Buffer, aad: string): Buffer {
    for (const keys of this.keyring) {
      try {
        return unseal(keys.encryption, sealed, aad)
      } catch {
        // Try the next (older) key.
      }
    }
    throw new Error(WRONG_KEY)
  }
}

/** A body damage record; see BODY_DAMAGE_FILE. Records written before kinds were kept have no kind. */
interface BodyDamage {
  stamp: string
  reason: string
  kind?: DamageKind
  code?: string
}

/** Errors of a file system that has no hard links. */
/** Absolute path to Windows PowerShell, so the process-start reader never resolves powershell.exe through PATH. */
function windowsPowerShellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows"
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])

/** Errors of a file system or folder that does not support exclusive lock files. */
const UNSUPPORTED_LOCK_ERRORS = new Set(["EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EPERM", "EACCES", "EROFS", "EINVAL"])

/** Derived file names remembered at most, so a very large folder does not grow the cache without bound. */
const FILE_NAME_CACHE_LIMIT = 200_000

/** Age after which an empty create-only claim counts as left behind by a writer that stopped. */
const STALE_CLAIM_MS = 60_000

/** Marks a listed file that was removed before it could be read, or an empty claim. */
const VANISHED = Symbol("vanished")

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

/** Keeps account and container names inside the root folder. */
function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9-]/g, "_")
  if (!safe || safe === "." || safe === "..") throw new Error(`Invalid storage name: ${value}`)
  return safe
}

async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [infoA, infoB] = await Promise.all([lstat(a, { bigint: true }), lstat(b, { bigint: true })])
    return infoA.isFile() && infoB.isFile() && infoA.ino !== 0n && infoA.dev === infoB.dev && infoA.ino === infoB.ino
  } catch {
    return false
  }
}

/** Returns the live path's current ETag only if it still refers to the exact restored file identity. */
async function boundRestoredEtag(live: string, expected: BigIntStats): Promise<string | undefined> {
  try {
    const info = await lstat(live, { bigint: true })
    if (!info.isFile() || info.ino === 0n) return undefined
    if (info.dev !== expected.dev || info.ino !== expected.ino || info.size !== expected.size || info.mtimeNs !== expected.mtimeNs) {
      return undefined
    }
    return `"${fileStamp(info)}"`
  } catch {
    return undefined
  }
}

/** Verifies `live` is a regular file with exact byte-for-byte identical contents to `expectedData`, bound to one open handle. */
async function identicalLiveCopyInfo(live: string, expectedData: Buffer): Promise<BigIntStats | null> {
  if (expectedData.length === 0) return null
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const linkInfo = await lstat(live, { bigint: true })
    if (!linkInfo.isFile() || linkInfo.size !== BigInt(expectedData.length)) return null
    handle = await open(live, "r")
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.ino === 0n || before.dev !== linkInfo.dev || before.ino !== linkInfo.ino || before.size !== BigInt(expectedData.length)) {
      return null
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (fileStamp(before) !== fileStamp(after)) return null
    return bytes.equals(expectedData) ? after : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** BigInt stats keep the full inode and nanosecond times, so a replaced file never shares a stamp with the old one. */
function fileStamp(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}
