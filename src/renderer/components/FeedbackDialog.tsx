import { useEffect, useId, useState } from "react"
import { Mail } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Checkbox } from "~/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { cn } from "~/lib/utils"
import {
  FEEDBACK_EMAIL_MAX,
  FEEDBACK_TEXT_MAX,
  feedbackDiagnostics,
  feedbackMailto,
  isValidFeedbackEmail,
  type FeedbackContext,
  type FeedbackSendResult,
} from "../../shared/feedback"
import { bridge } from "../lib/bridge"
import { toast } from "../lib/toast"

const textareaClass =
  "w-full resize-none rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function Question({ id, label, value, onChange, disabled }: { id: string; label: string; value: string; onChange: (value: string) => void; disabled: boolean }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <span className="shrink-0 text-xs text-gray-500">Required · <span id={`${id}-count`}>{value.length}/{FEEDBACK_TEXT_MAX}</span></span>
      </div>
      <textarea id={id} className={textareaClass} rows={3} maxLength={FEEDBACK_TEXT_MAX} required aria-describedby={`${id}-count`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

/**
 * Two questions, an optional reply-to address and an opt-in screenshot, sent to TenuVault only when
 * the admin clicks Send. The draft stays while the app runs, so closing the dialog loses nothing.
 */
export function FeedbackDialog({ open, onOpenChange, preview, page, onOpenSupport }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A preview of the window captured before the dialog opened, or null when capture failed. */
  preview: string | null
  /** The current section's name, never a route. */
  page?: string
  onOpenSupport: () => void
}) {
  const ids = useId()
  const [goal, setGoal] = useState("")
  const [blocker, setBlocker] = useState("")
  const [replyTo, setReplyTo] = useState("")
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID())
  const [includeScreenshot, setIncludeScreenshot] = useState(false)
  const [context, setContext] = useState<FeedbackContext | null>(null)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<Extract<FeedbackSendResult, { ok: false }> | null>(null)

  // Each opening starts with the screenshot unticked and no old error; the answers are kept.
  useEffect(() => {
    if (!open) return
    setIncludeScreenshot(false)
    setFailure(null)
    let current = true
    bridge.feedback.context().then((value) => { if (current) setContext(value) }, () => undefined)
    return () => { current = false }
  }, [open])

  const email = replyTo.trim()
  const emailInvalid = email !== "" && !isValidFeedbackEmail(email)
  const screenshot = includeScreenshot && preview !== null
  const canSend = !sending && goal.trim() !== "" && blocker.trim() !== "" && !emailInvalid

  const close = (next: boolean) => {
    if (next) return onOpenChange(true)
    if (sending) return
    void bridge.feedback.discardCapture().catch(() => undefined)
    onOpenChange(false)
  }

  const send = async () => {
    if (!canSend) return
    setSending(true)
    setFailure(null)
    let result: FeedbackSendResult
    try {
      result = await bridge.feedback.send({ submissionId, goal, blocker, ...(email ? { replyTo: email } : {}), includeScreenshot: screenshot, ...(page ? { page } : {}) })
    } catch {
      result = { ok: false, kind: "server", message: "The feedback could not be sent. Try again, or use Copy as email." }
    }
    setSending(false)
    if (!result.ok) return setFailure(result)
    setGoal("")
    setBlocker("")
    setReplyTo("")
    setSubmissionId(crypto.randomUUID())
    toast("Thanks, your feedback was sent.", "success")
    onOpenChange(false)
  }

  const copyAsEmail = () => void bridge.app.openExternal(feedbackMailto({ goal, blocker, context, page })).catch(() => toast("No email app could be opened.", "error"))

  const rows = context ? feedbackDiagnostics(context, page) : null

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share feedback</DialogTitle>
          <DialogDescription>
            Something broken or need help?{" "}
            <button type="button" className="font-medium text-blue-600 hover:underline disabled:opacity-50" disabled={sending} onClick={() => { close(false); onOpenSupport() }}>Open Support.</button>
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void send() }}>
          <Question id={`${ids}-goal`} label="What were you trying to do?" value={goal} onChange={setGoal} disabled={sending} />
          <Question id={`${ids}-blocker`} label="What got in your way, and what would help?" value={blocker} onChange={setBlocker} disabled={sending} />

          {preview !== null && (
            <div className="flex items-start gap-3">
              <Checkbox id={`${ids}-screenshot`} className="mt-0.5" checked={includeScreenshot} disabled={sending} onCheckedChange={(checked) => setIncludeScreenshot(checked === true)} />
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor={`${ids}-screenshot`}>Attach a screenshot of this window</Label>
                <p className="text-xs text-gray-500">It may show tenant, policy or user names.</p>
              </div>
              <img src={preview} alt="Screenshot of this window" className={cn("h-16 shrink-0 rounded-lg border border-gray-200", !includeScreenshot && "opacity-60")} />
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor={`${ids}-email`}>Reply-to email</Label>
              <span className="shrink-0 text-xs text-gray-500">Optional</span>
            </div>
            <Input id={`${ids}-email`} type="email" autoComplete="email" maxLength={FEEDBACK_EMAIL_MAX} value={replyTo} disabled={sending} aria-invalid={emailInvalid || undefined} aria-describedby={emailInvalid ? `${ids}-email-error` : undefined} onChange={(event) => setReplyTo(event.target.value)} />
            {emailInvalid && <p id={`${ids}-email-error`} className="text-xs text-red-700">Enter a valid email address, or leave it empty.</p>}
          </div>

          <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
            <div className="font-medium text-foreground">Sent with your feedback</div>
            <ul aria-label="Sent with your feedback" className="mt-1.5 space-y-0.5 break-words text-gray-700">
              {rows
                ? rows.map((row) => <li key={row.label}>{row.label}: {row.value}</li>)
                : <li>App version, operating system and plan</li>}
              {email && !emailInvalid && <li>Reply-to email: {email}</li>}
              {screenshot && <li>Screenshot of this window</li>}
            </ul>
          </div>

          {failure && (
            <div role="alert" className="space-y-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
              <p>{failure.message}</p>
              <Button type="button" size="sm" variant="outline" onClick={copyAsEmail}>
                <Mail className="mr-2 h-4 w-4" />
                Copy as email
              </Button>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={sending} onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" disabled={!canSend}>{sending ? "Sending..." : "Send feedback"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
