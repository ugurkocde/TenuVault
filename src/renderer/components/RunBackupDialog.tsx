import { useEffect, useState } from "react"
import { Loader2, Play } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { includedTypes, normalizeScope, type BackupScope } from "../../shared/intune/scope"
import { bridge } from "../lib/bridge"
import { BackupScopePicker } from "./BackupScopePicker"

export interface BackupTarget {
  name: string
  credentials: { tenantId: string; appId: string; clientSecret?: string }
  storageAccountName: string
}

interface RunBackupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tenant: BackupTarget | null
  /** Items per type in the tenant's latest backup, when known. */
  counts?: Record<string, number>
  /** Types the latest backup left out. */
  uncounted?: string[]
  onStarted: (jobId: string, status?: string) => void
}

const same = (a: BackupScope, b: BackupScope) => normalizeScope(a).excluded.join() === normalizeScope(b).excluded.join()

/** Asks what to back up, starting from the tenant's saved choice, then starts the backup. */
export function RunBackupDialog({ open, onOpenChange, tenant, counts, uncounted, onStarted }: RunBackupDialogProps) {
  const [scope, setScope] = useState<BackupScope | null>(null)
  const [saved, setSaved] = useState<BackupScope | null>(null)
  const [remember, setRemember] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState("")
  const tenantId = tenant?.credentials.tenantId

  useEffect(() => {
    if (!open || !tenantId) return
    setScope(null)
    setRemember(false)
    setError("")
    void bridge.backups.scope(tenantId).then((setting) => {
      setScope(setting.scope)
      setSaved(setting.scope)
    })
  }, [open, tenantId])

  const start = async () => {
    if (!tenant || !scope) return
    setStarting(true)
    setError("")
    try {
      if (remember) await bridge.backups.setScope(tenant.credentials.tenantId, scope)
      const response = await fetch("/api/backup/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...tenant.credentials, storageAccountName: tenant.storageAccountName, scope }),
      })
      const data = (await response.json()) as { jobId?: string; status?: string; error?: string }
      if (!response.ok || !data.jobId) throw new Error(data.error ?? "The backup could not start.")
      onOpenChange(false)
      onStarted(data.jobId, data.status)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setStarting(false)
    }
  }

  const empty = scope !== null && includedTypes(scope).length === 0
  const changed = scope !== null && saved !== null && !same(scope, saved)

  return (
    <Dialog open={open} onOpenChange={(next) => !starting && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Back up {tenant?.name}</DialogTitle>
          <DialogDescription>Choose what this backup covers. Fewer types make the backup faster.</DialogDescription>
        </DialogHeader>

        {scope ? (
          <BackupScopePicker value={scope} onChange={setScope} counts={counts} uncounted={uncounted} disabled={starting} />
        ) : (
          <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading this tenant's backup settings...
          </div>
        )}

        {changed && (
          <label className="flex items-center gap-3 text-sm text-gray-700">
            <input type="checkbox" className="h-4 w-4" checked={remember} disabled={starting} onChange={(event) => setRemember(event.target.checked)} />
            Also use this for automatic backups of {tenant?.name}
          </label>
        )}

        {error && <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</p>}

        <div className="flex justify-end gap-3">
          <Button variant="outline" disabled={starting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="bg-coral-600 text-white hover:bg-coral-700" disabled={!scope || empty || starting} onClick={() => void start()}>
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Start backup
          </Button>
        </div>
        {empty && <p className="text-right text-xs text-red-600">Choose at least one type.</p>}
      </DialogContent>
    </Dialog>
  )
}
