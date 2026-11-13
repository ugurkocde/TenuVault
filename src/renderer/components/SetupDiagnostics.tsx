import { useEffect, useState } from "react"
import { Activity, CheckCircle2 } from "lucide-react"
import { Button } from "~/components/ui/button"
import type { RendererSetupEvent, SetupDiagnosticsStatus } from "../../shared/ipc"
import { bridge } from "../lib/bridge"

export const SETUP_DIAGNOSTICS_DOCS_URL = "https://docs.tenuvault.com/security/data-flows/#setup-diagnostics"

/** Reports a setup step. Reporting never changes the setup, so a failure is ignored. */
export function recordSetup(event: RendererSetupEvent): void {
  try {
    void bridge.diagnostics.record(event).catch(() => undefined)
  } catch {
    // See above.
  }
}

/** The current answer, or null while it loads or when it cannot be read. */
function useDiagnosticsStatus(): [SetupDiagnosticsStatus | null, (status: SetupDiagnosticsStatus) => void] {
  const [status, setStatus] = useState<SetupDiagnosticsStatus | null>(null)
  useEffect(() => {
    let active = true
    try {
      void bridge.diagnostics.status().then((value) => { if (active) setStatus(value) }, () => undefined)
    } catch {
      // Without the answer nothing is asked.
    }
    return () => { active = false }
  }, [])
  return [status, setStatus]
}

const openDocs = () => void bridge.app.openExternal(SETUP_DIAGNOSTICS_DOCS_URL).catch(() => undefined)

const linkClass = "rounded-sm font-medium text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/**
 * The question on the welcome screen, below "Connect your tenant". It never blocks the setup:
 * Connect works without an answer, and nothing is preselected.
 */
export function SetupDiagnosticsCard() {
  const [status, setStatus] = useDiagnosticsStatus()
  const [answered, setAnswered] = useState<"granted" | "declined" | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  if (answered) {
    return (
      <p role="status" className="flex items-start gap-2 text-xs text-gray-600">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-700" aria-hidden="true" />
        {answered === "granted" ? "Thank you. Setup diagnostics are on for 30 days." : "Setup diagnostics stay off."} Change it anytime in Settings.
      </p>
    )
  }
  if (!status || status.policy || status.state !== "unasked") return null

  const answer = async (share: boolean) => {
    setBusy(true)
    setError("")
    try {
      setStatus(share ? await bridge.diagnostics.consent("welcome") : await bridge.diagnostics.decline())
      setAnswered(share ? "granted" : "declined")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="setup-diagnostics-title" className="space-y-3 rounded-2xl border border-gray-200 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><Activity className="h-4 w-4" /></span>
        <div className="min-w-0 space-y-1">
          <h2 id="setup-diagnostics-title" className="text-sm font-medium text-gray-900">Help us make setup work in your environment</h2>
          <p className="text-xs text-gray-600">
            TenuVault can tell us which setup steps worked and which Microsoft error codes stopped them, for 30 days after
            you agree. Never sent: tenant names or IDs, account names, policies or backups. A random ID links the steps. It is
            deleted from this computer after 30 days, and we delete the events after 180 days.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void answer(true)}>Share setup diagnostics</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void answer(false)}>Don&apos;t share</Button>
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      <p className="text-xs text-gray-600">
        <button type="button" className={linkClass} onClick={openDocs}>See exactly what is sent</button>
        <span aria-hidden="true"> · </span>
        Change it anytime in Settings
      </p>
    </section>
  )
}

/**
 * The one reminder next to the first setup error an install shows while it has not answered:
 * agreeing shares this error and the steps after it, nothing from before.
 */
export function SetupDiagnosticsReminder({ step }: { step: "setup" | "signin" }) {
  const [status] = useDiagnosticsStatus()
  const [answered, setAnswered] = useState<"granted" | "declined" | null>(null)
  const [busy, setBusy] = useState(false)
  const visible = Boolean(status?.reminder[step])
  useEffect(() => {
    if (visible) void bridge.diagnostics.reminderShown().catch(() => undefined)
  }, [visible])

  if (answered) {
    return (
      <p role="status" className="text-xs text-gray-600">
        {answered === "granted" ? "Thank you. This error and the next setup steps are shared." : "Nothing is shared."} Change it anytime in Settings.
      </p>
    )
  }
  if (!visible) return null

  const answer = async (share: boolean) => {
    setBusy(true)
    try {
      if (share) await bridge.diagnostics.consent("error", step)
      else await bridge.diagnostics.decline()
      setAnswered(share ? "granted" : "declined")
    } catch {
      setAnswered(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-gray-50 px-4 py-3 text-xs text-gray-700">
      <p className="min-w-0 flex-1 basis-64">
        Share this error and the next setup steps with TenuVault so we can fix setups like yours?{" "}
        <button type="button" className={linkClass} onClick={openDocs}>What is sent</button>
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void answer(true)}>Share</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void answer(false)}>Don&apos;t share</Button>
      </div>
    </div>
  )
}

/** The toggle in Settings > About. Installs from before this feature are never asked and see none. */
export function SetupDiagnosticsSetting() {
  const [status, setStatus] = useDiagnosticsStatus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  if (!status || status.state === "ineligible") return null
  const locked = status.policy || status.state === "ended"
  const set = async (share: boolean) => {
    setBusy(true)
    setError("")
    try {
      setStatus(share ? await bridge.diagnostics.consent("settings") : await bridge.diagnostics.decline())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1.5 border-t border-gray-100 pt-3">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={!locked && status.state === "granted"}
          disabled={busy || locked}
          onChange={(event) => void set(event.target.checked)}
        />
        Share setup diagnostics
      </label>
      <p className="text-xs text-gray-600">
        {status.policy
          ? "Turned off by your organization."
          : status.state === "ended"
            ? "Ended 30 days after you agreed. Nothing more is sent."
            : "Which setup steps worked and which Microsoft error codes stopped them, for 30 days after you agree. No tenant names or IDs, account names, policies or backups. Turning it off also deletes the events already sent."}{" "}
        <button type="button" className={linkClass} onClick={openDocs}>See exactly what is sent</button>
      </p>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </div>
  )
}
