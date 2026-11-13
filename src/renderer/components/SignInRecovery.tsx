import { useEffect, useRef, useState } from "react"
import { Check, Copy, ExternalLink, RotateCcw, Send } from "lucide-react"
import { Button } from "~/components/ui/button"
import { isSignInTimeout, MANUAL_APP_REGISTRATION_URL, offersSignInHandoff, setupHandoffText } from "../../shared/app-registration"
import { bridge } from "../lib/bridge"
import { recordSetup } from "./SetupDiagnostics"

/** How long a sign-in waits for the browser before the recovery panel offers other ways on. */
export const RECOVERY_DELAY_MS = 3 * 60_000

/**
 * Whether a sign-in has waited for the browser for `RECOVERY_DELAY_MS`. The wait belongs to one
 * `attempt`: a new attempt hides the panel in the same render that starts it, so Try again never
 * shows the old panel for a frame, and its own 3 minutes start again.
 */
export function useWaitedLong(waiting: boolean, attempt: number): boolean {
  const [waitedAttempt, setWaitedAttempt] = useState<number | null>(null)
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setWaitedAttempt(attempt), RECOVERY_DELAY_MS)
    return () => clearTimeout(timer)
  }, [waiting, attempt])
  return waiting && waitedAttempt === attempt
}

type Copied = "link" | "handoff" | "no-link" | null

function useCopyNote(): [Copied, (value: Copied) => void, string, (value: string) => void] {
  const [copied, setCopied] = useState<Copied>(null)
  const [error, setErrorState] = useState("")
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // A copy answers after an await; once the panel is gone, its answer changes nothing and starts no timer.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])
  const show = (value: Copied) => {
    if (!mounted.current) return
    setCopied(value)
    clearTimeout(timer.current)
    if (value) timer.current = setTimeout(() => setCopied(null), 5000)
  }
  const setError = (value: string) => { if (mounted.current) setErrorState(value) }
  return [copied, show, error, setError]
}

/** Copies the setup instructions for the Entra administrator, and counts the handoff route. */
async function copyHandoff(show: (value: Copied) => void, setError: (value: string) => void) {
  setError("")
  recordSetup({ name: "setup_route", props: { route: "handoff" } })
  try {
    await navigator.clipboard.writeText(setupHandoffText())
    show("handoff")
  } catch (caught) {
    setError(`Could not copy: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
}

function HandoffButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    // Inside an error alert the text colour is red; the buttons keep their own.
    <Button type="button" variant="outline" size="sm" className="text-foreground" onClick={onCopy}>
      {copied ? <Check className="mr-2 h-4 w-4" aria-hidden="true" /> : <Send className="mr-2 h-4 w-4" aria-hidden="true" />}
      {copied ? "Copied" : "Copy instructions for your admin"}
    </Button>
  )
}

function Notes({ copied, error }: { copied: Copied; error: string }) {
  return (
    <>
      {copied === "link" && <p role="status" className="text-xs text-gray-600">Copied the sign-in link. Paste it into another browser, such as Microsoft Edge signed in to your work profile.</p>}
      {copied === "no-link" && <p role="status" className="text-xs text-gray-600">The sign-in link is no longer available. Select Try again to open a new one.</p>}
      {copied === "handoff" && <p role="status" className="text-xs text-gray-600">Send the instructions to your Entra administrator by email or chat.</p>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </>
  )
}

/**
 * Shown next to a sign-in that has waited for the browser for 3 minutes: start it again, open the
 * same sign-in in another browser, or hand the setup to an administrator.
 */
export function SignInRecoveryPanel({ kind, onTryAgain, retrying = false }: {
  /** The waiting sign-in: the first sign-in to the tenant or the setup sign-in. */
  kind: "signin" | "setup"
  /** Cancels the waiting sign-in and starts it again. */
  onTryAgain: () => void
  retrying?: boolean
}) {
  const [copied, show, error, setError] = useCopyNote()

  const copyLink = async () => {
    setError("")
    try {
      show(await bridge.auth.copySignInLink(kind) ? "link" : "no-link")
    } catch (caught) {
      setError(`Could not copy: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }

  return (
    <div data-sign-in-recovery className="space-y-3 rounded-2xl border border-gray-200 bg-card px-4 py-3">
      <div className="space-y-1">
        <p className="font-medium text-gray-900">Still waiting for Microsoft?</p>
        <p className="text-gray-600">If the browser tab closed or showed an error, try again. You can also open the sign-in link in another browser, or send the setup to your admin.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onTryAgain} disabled={retrying}>
          <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
          {retrying ? "Starting again..." : "Try again"}
        </Button>
        <Button type="button" variant="outline" size="sm" className="text-foreground" onClick={() => void copyLink()}>
          {copied === "link" ? <Check className="mr-2 h-4 w-4" aria-hidden="true" /> : <Copy className="mr-2 h-4 w-4" aria-hidden="true" />}
          {copied === "link" ? "Copied" : "Copy sign-in link"}
        </Button>
        <HandoffButton copied={copied === "handoff"} onCopy={() => void copyHandoff(show, setError)} />
      </div>
      <Notes copied={copied} error={error} />
    </div>
  )
}

/**
 * The ways on next to a failed first sign-in: Try again and the handoff after the 15 minute
 * timeout; the handoff and the manual setup for the Conditional Access, consent and MFA refusals
 * that another administrator or the manual route can get around. Nothing for other errors.
 */
export function SignInErrorActions({ message, onTryAgain }: { message: string; onTryAgain: () => void }) {
  const [copied, show, error, setError] = useCopyNote()
  const timeout = isSignInTimeout(message)
  if (!timeout && !offersSignInHandoff(message)) return null
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {timeout && (
          <Button type="button" size="sm" onClick={onTryAgain}>
            <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
            Try again
          </Button>
        )}
        <HandoffButton copied={copied === "handoff"} onCopy={() => void copyHandoff(show, setError)} />
        {!timeout && (
          <Button type="button" variant="ghost" size="sm" className="text-foreground" onClick={() => void bridge.app.openExternal(MANUAL_APP_REGISTRATION_URL)}>
            <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
            Create it by hand
          </Button>
        )}
      </div>
      <Notes copied={copied} error={error} />
    </div>
  )
}
