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
  feedbackTextProblem,
  isValidFeedbackEmail,
  type FeedbackField,
  type FeedbackFieldErrors,
  type FeedbackSendResult,
  type FeedbackSnapshot,
} from "../../shared/feedback"
import { bridge } from "../lib/bridge"
import { toast } from "../lib/toast"

const textareaClass =
  "w-full resize-none rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function Question({ id, label, value, onChange, disabled, error }: { id: string; label: string; value: string; onChange: (value: string) => void; disabled: boolean; error?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <span className="shrink-0 text-xs text-gray-500">Required · <span id={`${id}-count`}>{value.length}/{FEEDBACK_TEXT_MAX}</span></span>
      </div>
      <textarea id={id} className={textareaClass} rows={3} maxLength={FEEDBACK_TEXT_MAX} required aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-count ${id}-error` : `${id}-count`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      {error && <p id={`${id}-error`} className="text-xs text-red-700">{error}</p>}
    </div>
  )
}

/**
 * Two questions, an optional reply-to address and an opt-in screenshot, sent to TenuVault only when
 * the admin clicks Send. The draft stays while the app runs, so closing the dialog loses nothing.
 */
export function FeedbackDialog({ open, onOpenChange, snapshot, onOpenSupport }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * What the main process recorded when the dialog opened: the screenshot preview, the context and
   * the page. Send uses the same snapshot. Null when it could not be recorded.
   */
  snapshot: FeedbackSnapshot | null
  onOpenSupport: () => void
}) {
  const ids = useId()
  const [goal, setGoal] = useState("")
  const [blocker, setBlocker] = useState("")
  const [replyTo, setReplyTo] = useState("")
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID())
  const [includeScreenshot, setIncludeScreenshot] = useState(false)
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<Extract<FeedbackSendResult, { ok: false }> | null>(null)
  // The service's or main process's message per answer, until that answer is edited.
  const [fieldErrors, setFieldErrors] = useState<FeedbackFieldErrors>({})

  // Each opening starts with the screenshot unticked and no old error; the answers are kept.
  useEffect(() => {
    if (!open) return
    setIncludeScreenshot(false)
    setFailure(null)
    setFieldErrors({})
  }, [open])

  const preview = snapshot?.preview ?? null
  const context = snapshot?.context ?? null
  const page = snapshot?.page
  const edit = (field: FeedbackField, set: (value: string) => void) => (value: string) => {
    set(value)
    setFieldErrors(({ [field]: _cleared, ...rest }) => rest)
  }
  const email = replyTo.trim()
  const emailError = email !== "" && !isValidFeedbackEmail(email) ? "Enter a valid email address, or leave it empty." : fieldErrors.replyTo
  const goalError = feedbackTextProblem(goal) ?? fieldErrors.goal
  const blockerError = feedbackTextProblem(blocker) ?? fieldErrors.blocker
  const screenshot = includeScreenshot && preview !== null
  const canSend = !sending && snapshot !== null && goal.trim() !== "" && blocker.trim() !== "" && !feedbackTextProblem(goal) && !feedbackTextProblem(blocker) && (email === "" || isValidFeedbackEmail(email))

  const close = (next: boolean) => {
    if (next) return onOpenChange(true)
    if (sending) return
    if (snapshot) void bridge.feedback.discardCapture(snapshot.id).catch(() => undefined)
    onOpenChange(false)
  }

  const send = async () => {
    if (!canSend || !snapshot) return
    setSending(true)
    setFailure(null)
    let result: FeedbackSendResult
    try {
      result = await bridge.feedback.send(snapshot.id, { submissionId, goal, blocker, ...(email ? { replyTo: email } : {}), includeScreenshot: screenshot })
    } catch {
      result = { ok: false, kind: "server", message: "The feedback could not be sent. Try again, or use Copy as email." }
    }
    setSending(false)
    if (!result.ok) {
      setFieldErrors(result.fields ?? {})
      return setFailure(result)
    }
    setGoal("")
    setBlocker("")
    setReplyTo("")
    setSubmissionId(crypto.randomUUID())
    toast("Thanks, your feedback was sent.", "success")
    onOpenChange(false)
  }

  const copyAsEmail = () => void bridge.app.openExternal(feedbackMailto({ goal, blocker, context, page })).catch(() => toast("No email app could be opened.", "error"))

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
          <Question id={`${ids}-goal`} label="What were you trying to do?" value={goal} onChange={edit("goal", setGoal)} disabled={sending} error={goalError} />
          <Question id={`${ids}-blocker`} label="What got in your way, and what would help?" value={blocker} onChange={edit("blocker", setBlocker)} disabled={sending} error={blockerError} />

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
            <Input id={`${ids}-email`} type="email" autoComplete="email" maxLength={FEEDBACK_EMAIL_MAX} value={replyTo} disabled={sending} aria-invalid={emailError ? true : undefined} aria-describedby={emailError ? `${ids}-email-error` : undefined} onChange={(event) => edit("replyTo", setReplyTo)(event.target.value)} />
            {emailError && <p id={`${ids}-email-error`} className="text-xs text-red-700">{emailError}</p>}
          </div>

          <div className="rounded-2xl bg-secondary px-4 py-3 text-sm">
            <div className="font-medium text-foreground">Sent with your feedback</div>
            <ul aria-label="Sent with your feedback" className="mt-1.5 space-y-0.5 break-words text-gray-700">
              {context
                ? feedbackDiagnostics(context, page).map((row) => <li key={row.label}>{row.label}: {row.value}</li>)
                : <li className="text-red-700">The app details could not be read. Close Share feedback and open it again.</li>}
              {email && isValidFeedbackEmail(email) && <li>Reply-to email: {email}</li>}
              <li>A random message ID, so a retry is not counted twice</li>
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
