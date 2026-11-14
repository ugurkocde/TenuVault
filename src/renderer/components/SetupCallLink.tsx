import { createContext, useContext } from "react"
import { CalendarClock } from "lucide-react"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { setupCallUrl, type SetupCallSource } from "../../shared/setup-call"
import { bridge } from "../lib/bridge"

const LABEL = "Book a free setup call"
const inline = "rounded-sm font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/**
 * True below a screen that already shows the hint next to an error of its own. A hint further
 * down then renders nothing, so one step never shows the line twice.
 */
export const SetupCallHintShown = createContext(false)

/**
 * The free setup call: 30 minutes in which the admin shares their screen and we guide them through
 * connecting the tenant and the first backup. Every mention of it in the app is this component, so
 * the offer can be changed or removed in one place.
 *
 * It only opens the page that explains the call in the default browser, with the name of the screen
 * it was opened from. The app itself contacts nothing. It is offered on every plan and reads no
 * license state.
 */
export function SetupCallLink({ source, variant, size = "sm", className, onOpened }: {
  /** The screen the link is on, sent to the page as `src=app-<source>`. */
  source: SetupCallSource
  /** `row` on the welcome screen, `nav` in the first-run header, `button` next to other buttons, `hint` under an error. */
  variant: "row" | "nav" | "button" | "hint"
  /** The size of the `button` variant. */
  size?: "sm" | "default"
  className?: string
  /** Called after the click, for a dialog that closes with it. */
  onOpened?: () => void
}) {
  const hintShown = useContext(SetupCallHintShown)
  const open = () => {
    // A browser that cannot be opened leaves the screen as it is.
    void bridge.app.openExternal(setupCallUrl(source)).catch(() => undefined)
    onOpened?.()
  }

  if (variant === "nav") {
    return <button type="button" data-setup-call={source} className={className} onClick={open}>Free setup call</button>
  }
  if (variant === "button") {
    return (
      // Inside an error alert the text colour is red; the button keeps its own.
      <Button type="button" variant="outline" size={size} data-setup-call={source} className={cn("text-foreground", className)} onClick={open}>
        <CalendarClock className="mr-2 h-4 w-4" aria-hidden="true" />
        {LABEL}
      </Button>
    )
  }
  if (variant === "hint") {
    if (hintShown) return null
    return (
      <p className={cn("text-xs text-gray-600", className)}>
        Stuck here?{" "}
        <button type="button" data-setup-call={source} className={cn(inline, "text-gray-900")} onClick={open}>{LABEL}</button>
        {" "}and we sort it out together.
      </p>
    )
  }
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><CalendarClock className="h-4 w-4" /></span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm text-gray-700">
          Rather do it together?{" "}
          <button type="button" data-setup-call={source} className={cn(inline, "text-blue-600")} onClick={open}>{LABEL}</button>
        </p>
        <p className="text-xs text-gray-600">30 minutes, free on every plan. You share your screen and we set it up in your tenant.</p>
      </div>
    </div>
  )
}
