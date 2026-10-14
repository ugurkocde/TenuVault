import { useCallback, useEffect, useRef, useState } from "react"
import type { Tenant } from "~/contexts/TenantContext"
import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import type { BackupSettings } from "../../shared/ipc"
import { bridge } from "./bridge"

export interface LocalInventoryProblems {
  /** The given tenants whose backups in the local folder this device cannot read, from the last finished check. */
  affected: string[]
  /** The check for the current folder, key and tenants has not finished yet. */
  checking: boolean
}

/** Tenants connected on this device that keep their backups in the local folder. */
export function localTenantIds(tenants: readonly Pick<Tenant, "resources">[]): string[] {
  return tenants.flatMap((tenant) => {
    const account = tenant.resources?.storageAccountName
    return account?.startsWith(LOCAL_STORAGE_PREFIX) ? [account.slice(LOCAL_STORAGE_PREFIX.length)] : []
  })
}

const SETTINGS_EVENT = "tenuvault:backup-settings"

/** Tells every open view that the backup folder or keys changed, with the settings the main process returned. */
export function announceBackupSettings(settings: BackupSettings): void {
  window.dispatchEvent(new CustomEvent<BackupSettings>(SETTINGS_EVENT, { detail: settings }))
}

/**
 * A view's backup settings: read once when the view opens, then kept current by the view's own
 * updates and by announcements from other views, such as the Change storage dialog. The first read
 * can finish after a newer update; it is older then and is dropped.
 */
export function useBackupSettings(onError?: (error: unknown) => void): [BackupSettings | null, (settings: BackupSettings) => void] {
  const [settings, setSettings] = useState<BackupSettings | null>(null)
  const updated = useRef(false)
  const update = useCallback((next: BackupSettings) => {
    updated.current = true
    setSettings(next)
  }, [])
  const reportError = useRef(onError)
  reportError.current = onError

  useEffect(() => {
    let active = true
    bridge.backups.settings().then(
      (read) => { if (active && !updated.current) setSettings(read) },
      (error: unknown) => { if (active) reportError.current?.(error) },
    )
    return () => { active = false }
  }, [])
  useEffect(() => {
    const listener = (event: Event) => update((event as CustomEvent<BackupSettings>).detail)
    window.addEventListener(SETTINGS_EVENT, listener)
    return () => window.removeEventListener(SETTINGS_EVENT, listener)
  }, [update])
  return [settings, update]
}

/** A check that takes longer, for example on an unresponsive network share, counts as no problem. */
const CHECK_TIMEOUT_MS = 15_000

// Each settings object is a fresh read from the main process. A recovery key import can add keys
// without changing the fingerprint, so every new read is checked again, not only a new folder or key.
const settingsReads = new WeakMap<BackupSettings, number>()
let reads = 0
function settingsRead(settings: BackupSettings): number {
  let read = settingsReads.get(settings)
  if (read === undefined) settingsReads.set(settings, (read = ++reads))
  return read
}

/**
 * Checks whether a backup of each tenant to the local folder would fail, by reading the tenant's
 * backup inventory there as a backup does. Checks again when the tenants or the settings change,
 * as after Choose another folder or Import recovery key. Until a new check finishes, the last
 * result stays. A check that fails or times out counts as no problem, so it never blocks; the backup still
 * reports what is wrong.
 */
function withTimeout(check: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS) })
  return Promise.race([check, timeout]).finally(() => clearTimeout(timer))
}

export function useLocalInventoryProblems(settings: BackupSettings | null, tenantIds: readonly string[]): LocalInventoryProblems {
  const tenants = [...new Set(tenantIds.map((id) => id.toLowerCase()))].sort().join(",")
  const key = settings && tenants ? `${settingsRead(settings)}:${tenants}` : null
  const [result, setResult] = useState<{ key: string; affected: string[] } | null>(null)

  useEffect(() => {
    if (!key) return
    let current = true
    const ids = tenants.split(",")
    void Promise.all(ids.map((id) => withTimeout(bridge.backups.inventoryProblem(id).then((problem) => problem !== null, () => false))))
      .then((problems) => {
        // A response for earlier settings or another tenant list is stale.
        if (current) setResult({ key, affected: ids.filter((_, index) => problems[index]) })
      })
    return () => { current = false }
  }, [key, tenants])

  const ids = tenants.split(",")
  return {
    affected: (result?.affected ?? []).filter((id) => ids.includes(id)),
    checking: key !== null && result?.key !== key,
  }
}
