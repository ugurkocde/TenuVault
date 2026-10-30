import { useEffect, useRef, useState } from "react"
import { ExternalLink } from "lucide-react"
import type { WhatsNewChange, WhatsNewEntry, WhatsNewState } from "../../shared/ipc"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { bridge } from "../lib/bridge"
import { useWhatsNew } from "../lib/whats-new"

const RELEASES_URL = "https://github.com/ugurkocde/TenuVault/releases"

const day = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

function ChangeLine({ change }: { change: WhatsNewChange }) {
  return (
    <li className="flex items-baseline gap-2">
      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-blue-600" />
      <span>
        {change.text}
        {change.url && change.reference && (
          <>
            {" "}
            <a
              href={change.url}
              className="whitespace-nowrap text-blue-600 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
              onClick={(event) => { event.preventDefault(); void bridge.app.openExternal(change.url!) }}
            >
              {change.reference}
            </a>
          </>
        )}
      </span>
    </li>
  )
}

/** The changes of one release, also shown for a pending update in the update settings. */
export function WhatsNewEntryNotes({ entry }: { entry: WhatsNewEntry }) {
  return (
    <section aria-label={`TenuVault ${entry.version}`} className="space-y-2">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-gray-900">
        Version {entry.version}
        {entry.channel === "nightly" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">Nightly</span>}
        {entry.unseen && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">New</span>}
        {entry.publishedAt && <span className="text-xs font-normal text-gray-500">{day(entry.publishedAt)}</span>}
      </h3>
      {entry.changes.length > 0 ? (
        <ul className="space-y-1.5 text-sm text-gray-700">
          {entry.changes.map((change, index) => <ChangeLine key={index} change={change} />)}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No changes were listed for this release.</p>
      )}
      {entry.issues.length > 0 && (
        <>
          <h4 className="pt-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Issues resolved</h4>
          <ul className="space-y-1.5 text-sm text-gray-700">
            {entry.issues.map((change, index) => <ChangeLine key={index} change={change} />)}
          </ul>
        </>
      )}
    </section>
  )
}

/** The notes of the recent releases of this build's channel, newest first. */
export function WhatsNewEntries({ state }: { state: WhatsNewState }) {
  if (state.error) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-red-700">{state.error}</p>
        <p className="text-sm text-gray-700">Every release and its notes are also on GitHub.</p>
      </div>
    )
  }
  const installed = state.entries.filter((entry) => entry.installed)
  if (!installed.length) return <p className="text-sm text-gray-500">No releases were found.</p>
  return (
    <div className="max-h-[55vh] space-y-5 overflow-y-auto pr-1">
      {installed.map((entry) => <WhatsNewEntryNotes key={entry.version} entry={entry} />)}
    </div>
  )
}

/**
 * The What's new dialog. Closing it marks the installed version as seen, so
 * neither the dialog nor the sidebar dot comes back until a later update.
 */
export function WhatsNewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { state, markSeen, refresh } = useWhatsNew()
  useEffect(() => { if (open) void refresh() }, [open, refresh])
  const close = (next: boolean) => {
    // Only a dialog that actually showed notes counts as seeing them. Closing
    // a load error must keep the unseen state for when the notes load again.
    if (!next && state && !state.error && state.entries.some((entry) => entry.installed)) void markSeen()
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>What&apos;s new</DialogTitle>
          <DialogDescription>
            Changes in recent TenuVault releases{state ? `, up to your version ${state.currentVersion}` : ""}.
          </DialogDescription>
        </DialogHeader>
        {state ? <WhatsNewEntries state={state} /> : <p className="text-sm text-gray-500">Loading the release notes...</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => void bridge.app.openExternal(RELEASES_URL)}>
            <ExternalLink className="mr-2 h-4 w-4" /> All releases on GitHub
          </Button>
          <Button onClick={() => close(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The one-time announcement after a stable update. Nightly builds never get it:
 * they update far too often, and the sidebar dot covers their pace instead.
 */
export function WhatsNewAnnouncement() {
  const { state } = useWhatsNew()
  const [open, setOpen] = useState(false)
  const announced = useRef(false)
  useEffect(() => {
    if (state?.announceStable && !announced.current) {
      announced.current = true
      setOpen(true)
    }
  }, [state])
  return <WhatsNewDialog open={open} onOpenChange={setOpen} />
}
