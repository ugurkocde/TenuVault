import { Link } from "react-router-dom"
import { useTenants } from "~/contexts/TenantContext"
import type { BackupSettings } from "../../shared/ipc"
import { needsRecoveryKeyExport } from "../lib/recovery-key"
import { settingsHref } from "../lib/settings-section"

export function RecoveryKeyNotice({ settings }: { settings: BackupSettings | null }) {
  const tenants = useTenants()
  if (!needsRecoveryKeyExport(settings, tenants.map((tenant) => tenant.resources?.storageAccountName))) return null
  return (
    <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">Save your backup recovery key</p>
      <p className="mt-1">Your current recovery key has not been saved. Starting over deletes the backup encryption key. Existing local and Azure backups become unreadable unless you exported their recovery key. Save it somewhere safe before you need to recover your backups.</p>
      <Link to={settingsHref("storage", "recovery-key")} className="mt-2 inline-block font-medium underline" onClick={() => document.getElementById("save-recovery-key")?.focus()}>Go to Save recovery key</Link>
    </div>
  )
}
