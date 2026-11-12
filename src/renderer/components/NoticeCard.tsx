import type { ReactNode } from "react"
import { cn } from "~/lib/utils"

interface NoticeCardProps {
  /** status for advice, alert for something the admin must act on. */
  role: "status" | "alert"
  title: ReactNode
  /** The explanation under the title, as one or more paragraphs. */
  body: ReactNode
  /** Classes for the body, such as a width limit. */
  bodyClassName?: string
  /** Buttons, in one row that wraps. */
  actions?: ReactNode
  /** Status lines and inline forms under the actions. */
  children?: ReactNode
  className?: string
}

/** The amber card that backup notices share: title, body, a row of actions, then status lines. */
export function NoticeCard({ role, title, body, bodyClassName, actions, children, className }: NoticeCardProps) {
  return (
    <div role={role} className={cn("space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900", className)}>
      <div>
        <p className="font-medium">{title}</p>
        <div className={cn("mt-1", bodyClassName)}>{body}</div>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      {children}
    </div>
  )
}
