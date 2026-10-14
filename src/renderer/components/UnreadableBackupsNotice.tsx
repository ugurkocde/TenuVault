import { useEffect, useState } from "react"
import { FolderOpen, Loader2, Upload } from "lucide-react"
import { Button } from "~/components/ui/button"
import type { BackupSettings } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { announceBackupSettings } from "../lib/local-inventory"
import { RecoveryKeyImport } from "./RecoveryKeyImport"

interface UnreadableBackupsNoticeProps {
  settings: BackupSettings | null
  /** A tenant the parent cares about has backups in the folder this device cannot read; see useLocalInventoryProblems. */
  affected: boolean
  /** The folder is being checked again, for example after one of the notice's actions. */
  checking: boolean
  onChange: (settings: BackupSettings) => void
}

/**
 * Shown when the local folder holds backups this device cannot read, such as a folder written by
 * another installation with a different recovery key, or damaged files. Backups to it fail until
 * the admin imports that recovery key or keeps this device's backups in another folder; the
 * notice offers both.
 */
export function UnreadableBackupsNotice({ settings, affected, checking, onChange }: UnreadableBackupsNoticeProps) {
  const [importing, setImporting] = useState(false)
  // One folder change or key import at a time: a slower answer must not replace a newer one.
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  // Shown when the check after an action still finds unreadable backups.
  const [stillUnreadable, setStillUnreadable] = useState("")

  useEffect(() => {
    if (affected) return
    setStillUnreadable("")
    setError("")
  }, [affected])

  if (!settings || !affected) return null

  const update = (next: BackupSettings, message: string) => {
    setError("")
    setStillUnreadable(message)
    onChange(next)
    announceBackupSettings(next)
  }
  const chooseFolder = async () => {
    setPending(true)
    try {
      const next = await bridge.backups.chooseFolder()
      // A cancelled picker keeps the folder; there is nothing new to report.
      if (next.localFolder === settings.localFolder) return onChange(next)
      update(next, "The folder you chose also has backups this device cannot read. Import their recovery key or choose an empty folder.")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <div role="alert" className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div>
        <p className="font-medium">This folder has backups this device cannot read</p>
        <p className="mt-1">
          Some backups in <span className="break-all font-mono text-xs">{settings.localFolder}</span> were made with a
          different recovery key, for example by another device or an earlier installation, or are damaged. Backups to
          this folder fail until you import that recovery key or choose another folder.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className="bg-white" disabled={checking || pending} onClick={() => setImporting((value) => !value)}>
          <Upload className="mr-2 h-4 w-4" /> Import recovery key
        </Button>
        <Button type="button" variant="outline" size="sm" className="bg-white" disabled={checking || pending} onClick={() => void chooseFolder()}>
          <FolderOpen className="mr-2 h-4 w-4" /> Choose another folder
        </Button>
      </div>
      {importing && (
        <RecoveryKeyImport
          onImported={(next) => {
            setImporting(false)
            update(next, "This device still cannot read some of these backups. Import the recovery key that made them, or choose another folder.")
          }}
          onError={setError}
          onBusyChange={setPending}
        />
      )}
      {checking && (
        <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Checking the backups in the folder...</p>
      )}
      {!checking && stillUnreadable && <p className="text-red-700">{stillUnreadable}</p>}
      {error && <p className="text-red-700">{error}</p>}
    </div>
  )
}
