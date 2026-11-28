import { NoticeCard, noticeActionClass } from "./NoticeCard"
import { Link } from "react-router-dom"
import { useTenants } from "~/contexts/TenantContext"
import type { BackupSettings } from "../../shared/ipc"
import { needsRecoveryKeyExport } from "../lib/recovery-key"
import { settingsHref } from "../lib/settings-section"

export function RecoveryKeyNotice({ settings }: { settings: BackupSettings | null }) {
  const tenants = useTenants()
  if (!needsRecoveryKeyExport(settings, tenants.map((tenant) => tenant.resources?.storageAccountName))) return null
  return <NoticeCard tone="warning" summary="Save your backup recovery key."
    details="Starting over deletes the encryption key. Backups on this device become unreadable unless you exported their recovery key."
    action={<Link to={settingsHref("storage", "recovery-key")} className={noticeActionClass} onClick={() => document.getElementById("save-recovery-key")?.focus()}>Go to Save recovery key</Link>} />
}
