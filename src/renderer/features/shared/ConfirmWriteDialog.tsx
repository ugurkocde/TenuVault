import { useId, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"

/**
 * The explicit confirmation before a tenant write. It names the target tenant, lists what
 * cannot be undone and what no rollback covers, and stays disabled until the admin ticks that
 * they read it. `backupSkipped` says no backup runs, for a change set bound to skipping it. The
 * backup it names is the pre-change backup of the change-set engine: a backup with the tenant's
 * backup settings that must hold every policy type the change writes.
 */
export function ConfirmWriteDialog({
  open,
  onOpenChange,
  title,
  tenantName,
  irreversible,
  unsupported,
  confirmLabel,
  busy,
  onConfirm,
  backupSkipped = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  tenantName: string
  irreversible: string[]
  unsupported: string[]
  confirmLabel: string
  busy: boolean
  onConfirm: () => void
  backupSkipped?: boolean
}) {
  const [understood, setUnderstood] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  // Every opening asks again, also when the parent closed the dialog itself after a write.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setUnderstood(false)
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-w-2xl" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <DialogHeader>
          <DialogTitle id={titleId} className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription id={descriptionId}>
            This writes to the tenant <strong className="text-gray-900 dark:text-gray-100">{tenantName}</strong>. {backupSkipped ? "No backup runs: the current state of every affected object is captured first, and the write stops if that fails." : "A backup with this tenant's backup settings runs first and must hold every policy type this change writes. The current state of every affected object is captured too; the write stops if either fails."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-4 overflow-y-auto text-sm">
          {irreversible.length > 0 && (
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">What cannot be undone</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-gray-700 dark:text-gray-300">
                {irreversible.map((line, index) => <li key={index}>{line}</li>)}
              </ul>
            </div>
          )}
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">Not covered by any rollback</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-gray-700 dark:text-gray-300">
              {unsupported.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          </div>
          <label className="flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
            <span>I read the irreversible steps and the recovery limits, and I want to write these changes to {tenantName} now.</span>
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={!understood || busy} onClick={onConfirm}>
            {busy ? "Working" : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
