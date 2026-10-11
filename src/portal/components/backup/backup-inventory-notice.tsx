import { AlertTriangle } from "lucide-react"
import type { BackupDamagedFile } from "./types"

export function BackupInventoryNotice({ damagedFiles, completenessUnknown, retentionPaused }: { damagedFiles: BackupDamagedFile[]; completenessUnknown: boolean; retentionPaused: boolean }) {
  if (!damagedFiles.length && !completenessUnknown && !retentionPaused) return null
  return (
    <div role="status" className="flex gap-3 rounded-3xl bg-amber-50 p-5">
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700" />
      <div className="min-w-0 text-sm text-amber-800">
        <h3 className="font-medium text-amber-900">Local backup files need attention</h3>
        <p className="mt-1">{completenessUnknown ? "Some damaged files cannot be assigned to a backup. Downloads, drift detection, backup changes and restore previews are paused for this backup folder." : "Only affected backups are unavailable for downloads, comparisons and restore previews."} Healthy files stay readable and new backups can still be saved.</p>
        {retentionPaused && <p className="mt-1">Retention is paused for the whole backup folder. Recover or remove the reported damage, then refresh.</p>}
        {damagedFiles.length > 0 && (
          <ul className="mt-2 space-y-1">
            {damagedFiles.map((file) => <li key={file.file} className="break-all"><span className="font-medium">{file.file}</span>: {file.reason}. {file.ownershipUnknown ? "Ownership unknown." : "Ownership recorded in backup metadata."}</li>)}
          </ul>
        )}
      </div>
    </div>
  )
}
