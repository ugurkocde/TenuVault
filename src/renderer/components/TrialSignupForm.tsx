import { forwardRef, useId, useState } from "react"
import { AlertCircle, Loader2, Mail, MailCheck } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { bridge } from "../lib/bridge"

/**
 * The no-card Pro trial: the admin enters an email address and the licensing service emails
 * a 30 day trial key to it. The key is never shown here, so the address has to be theirs.
 */
export const TrialSignupForm = forwardRef<HTMLInputElement, {
  source: string
  /** Called once the request was accepted, for example to point at the key field. */
  onSent?: (email: string) => void
  className?: string
}>(function TrialSignupForm({ source, onSent, className }, ref) {
  const id = useId()
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sentTo, setSentTo] = useState("")

  const submit = async () => {
    setBusy(true)
    setError("")
    try {
      await bridge.license.startTrial(email.trim(), { source })
      setSentTo(email.trim())
      onSent?.(email.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        if (email.trim() && !busy) void submit()
      }}
    >
      <Label htmlFor={`${id}-email`}>Work email</Label>
      <div className="mt-2 flex flex-wrap gap-2">
        <Input
          id={`${id}-email`}
          ref={ref}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          maxLength={254}
          spellCheck={false}
          placeholder="you@company.com"
          className="min-w-0 flex-1 basis-56"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            setError("")
            setSentTo("")
          }}
          disabled={busy}
          aria-describedby={`${id}-help`}
        />
        <Button type="submit" disabled={busy || !email.trim()}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Mail className="mr-2 h-4 w-4" aria-hidden="true" />}
          Start free trial
        </Button>
      </div>
      <p id={`${id}-help`} className="mt-2 text-xs text-gray-600">
        No card needed. We email you a Pro license key for 30 days, and nothing is charged when it ends.
      </p>
      {sentTo && (
        <Alert className="mt-3" role="status">
          <MailCheck className="h-4 w-4 text-green-600" aria-hidden="true" />
          <AlertDescription>
            Check your inbox at <span className="font-medium break-all">{sentTo}</span>. The key usually arrives within a
            minute. Paste it into the license key field below.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mt-3">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  )
})
