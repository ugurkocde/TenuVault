import { useEffect, useSyncExternalStore } from "react"
import type { Tenant } from "~/contexts/TenantContext"
import type { BackupSummary } from "~/components/backup/types"

/**
 * Each tenant's backup list, kept for every page while the app runs. Listing backups reads every
 * backup's metadata and files and can take a while, so a page that opens again shows the list it
 * had at once and refreshes it in the background instead of showing "Loading backups..." each time.
 * Lists are kept per tenant and storage account: a tenant that moves its backups gets a new one.
 */
export interface BackupList {
  /** Null until the first list arrived. */
  backups: BackupSummary[] | null
  /** Why the last refresh failed; `backups` are then from an earlier one, if any. */
  error: string
  /** A refresh is running. */
  loading: boolean
}

const EMPTY: BackupList = { backups: null, error: "", loading: false }

let lists: Record<string, BackupList> = {}
const listeners = new Set<() => void>()
const running = new Map<string, Promise<void>>()
// The newest refresh per list; answers to older ones are stale and dropped.
const latest = new Map<string, number>()
// The credentials the newest refresh per list was sent with; see credentialsOf.
const sentWith = new Map<string, string>()
let requests = 0

function emit() {
  for (const listener of listeners) listener()
}

function update(key: string, change: Partial<BackupList>) {
  lists = { ...lists, [key]: { ...(lists[key] ?? EMPTY), ...change } }
  emit()
}

/** The list's key, or null when the tenant cannot list backups (not connected, or no storage chosen). */
export function backupListKey(tenant: Tenant | null | undefined): string | null {
  const tenantId = tenant?.credentials?.tenantId
  const storageAccountName = tenant?.resources?.storageAccountName
  return tenantId && storageAccountName ? `${tenantId.toLowerCase()}/${storageAccountName.toLowerCase()}` : null
}

/** What a list request sends besides the key; a change means a running refresh used stale credentials. */
function credentialsOf(tenant: Tenant | null | undefined): string {
  const { credentials, resources } = tenant ?? {}
  return JSON.stringify([credentials?.appId, credentials?.clientSecret, resources?.subscriptionId, resources?.resourceGroupName])
}

export function backupListOf(key: string | null): BackupList {
  return (key && lists[key]) || EMPTY
}

/**
 * Lists the tenant's backups again. A refresh already running is joined unless `force` (for example
 * after a backup finished, when a list read before it would miss the new backup) or it was sent
 * with other credentials. The kept list stays shown until the new one arrives.
 */
export function refreshBackupList(tenant: Tenant, options: { force?: boolean } = {}): Promise<void> {
  const key = backupListKey(tenant)
  if (!key || !tenant.credentials || !tenant.resources) return Promise.resolve()
  const pending = running.get(key)
  const credentials = credentialsOf(tenant)
  if (pending && !options.force && sentWith.get(key) === credentials) return pending
  const id = ++requests
  latest.set(key, id)
  sentWith.set(key, credentials)
  update(key, { loading: true })
  const request = (async () => {
    try {
      const response = await fetch("/api/list-backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...tenant.credentials,
          subscriptionId: tenant.resources!.subscriptionId || "local",
          resourceGroupName: tenant.resources!.resourceGroupName || "local",
          storageAccountName: tenant.resources!.storageAccountName,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.details || data.error || "Backups are unavailable. Check this tenant's sign-in, license, and storage access.")
      if (latest.get(key) === id) update(key, { backups: data.backups ?? [], error: "", loading: false })
    } catch (failure) {
      if (latest.get(key) === id) update(key, { error: failure instanceof Error ? failure.message : "Backups are unavailable.", loading: false })
    }
  })().finally(() => {
    if (running.get(key) === request) running.delete(key)
  })
  running.set(key, request)
  return request
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** The tenant's backup list; refreshed in the background whenever a page using it opens or its credentials change. */
export function useBackupList(tenant: Tenant | null | undefined): BackupList & { refresh: (options?: { force?: boolean }) => Promise<void> } {
  const key = backupListKey(tenant)
  const credentials = credentialsOf(tenant)
  const list = useSyncExternalStore(subscribe, () => backupListOf(key))
  useEffect(() => {
    if (tenant && key) void refreshBackupList(tenant)
  }, [key, credentials])
  return { ...list, refresh: (options) => (tenant ? refreshBackupList(tenant, options) : Promise.resolve()) }
}

/** Forgets every list; for tests. */
export function resetBackupLists(): void {
  lists = {}
  running.clear()
  latest.clear()
  sentWith.clear()
  emit()
}
