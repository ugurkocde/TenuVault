import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "~/components/ui/button"
import type { BackupSettings } from "../../shared/ipc"
import { bridge } from "../lib/bridge"

interface RecoveryKeyImportProps {
  /** Called with the new settings after an import; not called when the admin cancels the confirmation. */
  onImported: (settings: BackupSettings) => void
  onError: (message: string) => void
  /** Told when an import starts and ends, so other actions can wait for it. */
  onBusyChange?: (busy: boolean) => void
}

/** Text field and button that import a recovery key into this device's keyring. */
export function RecoveryKeyImport({ onImported, onError, onBusyChange }: RecoveryKeyImportProps) {
  const [recoveryKey, setRecoveryKey] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    onBusyChange?.(true)
    try {
      const imported = await bridge.backups.importRecoveryKey(recoveryKey)
      if (!imported) return
      setRecoveryKey("")
      onImported(imported)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  return (
    <div className="space-y-2">
      <textarea aria-label="Recovery key"
        className="min-h-16 w-full rounded-2xl border border-gray-300 bg-white px-4 py-3 font-mono text-xs"
        placeholder="TVK2.... (or a legacy TVK1 key)"
        value={recoveryKey}
        onChange={(e) => setRecoveryKey(e.target.value)}
        spellCheck={false}
      />
      <p className="text-xs text-gray-500">
        The imported key encrypts new backups. Backups made with the previous key stay readable.
      </p>
      <Button type="button" size="sm" disabled={!recoveryKey.trim() || busy} onClick={() => void submit()}>
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Import
      </Button>
    </div>
  )
}
