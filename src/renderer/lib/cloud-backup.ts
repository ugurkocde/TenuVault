import { useCallback, useEffect, useState } from "react"
import type { Tenant } from "~/contexts/TenantContext"
import { parseCloudSetup, type CloudBackupConfig, type CloudBackupStatus } from "../../shared/cloud-backup"
import { bridge } from "./bridge"

/**
 * The tenant's cloud backup setup as pasted back from the setup script or template outputs,
 * kept in the app's encrypted store. It is a record of what an Azure administrator created,
 * not a control channel: the app never creates or edits the Azure resources.
 */
const keyOf = (tenantId: string) => `tenuvault_cloud_backup_${tenantId.toLowerCase()}`

export function readCloudConfig(tenantId: string): CloudBackupConfig | null {
  try {
    const raw = bridge.storage.getItemSync(keyOf(tenantId))
    if (!raw) return null
    const parsed = parseCloudSetup(
      Object.entries(JSON.parse(raw) as Record<string, unknown>)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join("\n"),
    )
    return parsed && parsed.tenantId === tenantId.toLowerCase() ? parsed : null
  } catch {
    return null
  }
}

export async function saveCloudConfig(config: CloudBackupConfig): Promise<void> {
  await bridge.storage.setItem(keyOf(config.tenantId), JSON.stringify(config))
}

export async function clearCloudConfig(tenantId: string): Promise<void> {
  await bridge.storage.removeItem(keyOf(tenantId))
}

export interface CloudBackupState {
  config: CloudBackupConfig | null
  status: CloudBackupStatus | null
  /** The last status read failure. While set, `status` may be stale, never "no cloud backups". */
  statusError: string | null
  refresh: () => void
  save: (config: CloudBackupConfig) => Promise<void>
  clear: () => Promise<void>
}

/** The pasted cloud setup plus the runbook's last reported run, read from backup storage. */
export function useCloudBackup(tenant: Tenant | null | undefined, explicitTenantId?: string): CloudBackupState {
  const tenantId = tenant?.credentials?.tenantId ?? explicitTenantId ?? ""
  const [config, setConfig] = useState<CloudBackupConfig | null>(null)
  const [status, setStatus] = useState<CloudBackupStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [refreshes, setRefreshes] = useState(0)

  useEffect(() => {
    setConfig(tenantId ? readCloudConfig(tenantId) : null)
    setStatus(null)
    setStatusError(null)
  }, [tenantId])

  useEffect(() => {
    if (!tenant?.credentials || !tenant.resources?.storageAccountName || !config) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch("/api/cloud-backup-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...tenant.credentials, ...tenant.resources }),
        })
        const data = (await response.json()) as { cloudStatus?: CloudBackupStatus | null; error?: string }
        if (cancelled) return
        if (!response.ok) throw new Error(data.error ?? "Cloud backup status could not be read.")
        setStatus(data.cloudStatus ?? null)
        setStatusError(null)
      } catch (error) {
        if (!cancelled) setStatusError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { cancelled = true }
  }, [tenant, config, refreshes])

  const save = useCallback(async (next: CloudBackupConfig) => {
    await saveCloudConfig(next)
    setConfig(next)
  }, [])
  const clear = useCallback(async () => {
    if (!tenantId) return
    await clearCloudConfig(tenantId)
    setConfig(null)
    setStatus(null)
  }, [tenantId])

  return { config, status, statusError, refresh: () => setRefreshes((count) => count + 1), save, clear }
}
