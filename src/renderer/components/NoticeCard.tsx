import { useId, useState, type ReactElement, type ReactNode } from "react"
import { AlertCircle, AlertTriangle, ChevronDown, Info, X } from "lucide-react"
import { cn } from "~/lib/utils"

const tones = {
  neutral: { icon: Info, style: "border-border bg-muted/50 text-foreground", role: "status" },
  warning: { icon: AlertTriangle, style: "border-amber-200 bg-amber-50 text-amber-900", role: "status" },
  error: { icon: AlertCircle, style: "border-red-200 bg-red-50 text-red-800", role: "alert" },
} as const

type CompactNoticeCardProps = {
  summary: string
  details?: ReactNode
  action?: ReactElement | false | null
  children?: ReactNode
  className?: string
} & (
  | { tone?: keyof typeof tones; dismiss?: never }
  | { tone?: "neutral" | "warning"; dismiss: { kind: "tip" | "banner"; tenantId: string; id: string } }
)

export const noticeActionClass = "shrink-0 rounded-sm text-xs font-medium text-blue-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

export function NoticeCard({ summary, details, action, children, tone = "neutral", dismiss, className }: CompactNoticeCardProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [dismissedKey, setDismissedKey] = useState<string>()
  const key = dismiss && `tenuvault.notice.${dismiss.kind}.${dismiss.tenantId.toLowerCase()}.${dismiss.id}`
  const { icon: Icon, style, role } = tones[tone]
  if (key) {
    if (dismissedKey === key) return null
    try { if (localStorage.getItem(key) === "1") return null } catch { /* The notice still works without storage. */ }
  }
  return (
    <div data-no-select data-notice-tone={tone} className={cn("min-w-0 rounded-xl border px-4 py-3 text-left text-sm", style, className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p role={role} className="flex min-w-0 flex-[1_1_12rem] items-start gap-2 font-medium leading-snug">
          <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{summary}</span>
        </p>
        {(details || action || key) && <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {details && <button type="button" aria-expanded={open} aria-controls={id} aria-label={`Details: ${summary}`} className="inline-flex items-center gap-1 rounded-sm text-xs font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => setOpen(!open)}>
            Details <ChevronDown className={cn("size-3.5", open && "rotate-180")} aria-hidden="true" />
          </button>}
          {action}
          {key && <button type="button" aria-label={`Dismiss: ${summary}`} className="rounded-sm p-0.5 hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => {
            try { localStorage.setItem(key, "1") } catch { /* Remember for this mount. */ }
            setDismissedKey(key)
          }}><X className="size-3.5" aria-hidden="true" /></button>}
        </div>}
      </div>
      {details && <div id={id} hidden={!open} tabIndex={0} role="region" aria-label={`Details: ${summary}`} className="mt-2 max-h-56 space-y-2 overflow-auto overscroll-contain break-words border-t border-border pt-2 text-xs">{details}</div>}
      {children && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  )
}
