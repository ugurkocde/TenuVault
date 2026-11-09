import { useEffect, useState } from "react"
import { Loader2, Upload } from "lucide-react"
import { Button } from "~/components/ui/button"
import { announceBackupSettings } from "../lib/local-inventory"
import { RecoveryKeyImport } from "./RecoveryKeyImport"

interface LegacySealedBackupsNoticeProps {
  /** Backups in the Azure storage account that an earlier version encrypted and no key on this device opens (the backup list's `sealed`). */
  count: number
  /** Lists the backups again after a key import; resolves when the new list arrived. */
  onImported: () => Promise<void>
}

/**
 * Advisory only: new Azure backups are plain JSON and every other backup stays usable. Shown when
 * the tenant's Azure storage holds backups an earlier TenuVault version encrypted with a device key
 * this device does not have. Importing that device's recovery key opens them.
 */
export function LegacySealedBackupsNotice({ count, onImported }: LegacySealedBackupsNoticeProps) {
  const [importing, setImporting] = useState(false)
  // An import is running, or the list is read again after one.
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")
  // Set when the list after an import still has such backups; cleared once none are left.
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (count <= 0) setChecked(false)
  }, [count])

  if (count <= 0) return null
  const plural = count !== 1

  return (
    <div role="status" className="mb-4 space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div>
        <p className="font-medium">{plural ? `${count} older Azure backups need a recovery key` : "An older Azure backup needs a recovery key"}</p>
        <p className="mt-1">
          {plural ? "These backups were" : "This backup was"} encrypted by an earlier TenuVault version, and no recovery key on
          this device opens {plural ? "them" : "it"}. Import the recovery key of the device that made {plural ? "them" : "it"} to
          see {plural ? "them" : "it"} here. If another tenant shares this storage account, {plural ? "they may be" : "it may be"} that
          tenant's. New backups and your other backups are not affected, and a backup that cannot be read is never deleted.
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" className="bg-white" disabled={pending || refreshing} onClick={() => setImporting((value) => !value)}>
        <Upload className="mr-2 h-4 w-4" /> Import recovery key
      </Button>
      {importing && (
        <RecoveryKeyImport
          onImported={(next) => {
            setImporting(false)
            setError("")
            announceBackupSettings(next)
            setRefreshing(true)
            void onImported().finally(() => {
              setRefreshing(false)
              setChecked(true)
            })
          }}
          onError={setError}
          onBusyChange={setPending}
        />
      )}
      {refreshing && (
        <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Checking the backups again...</p>
      )}
      {checked && !refreshing && <p className="text-red-700">This device still cannot open {plural ? `${count} of these backups` : "this backup"}. Import the recovery key of the device that made {plural ? "them" : "it"}.</p>}
      {error && <p className="text-red-700">{error}</p>}
    </div>
  )
}
