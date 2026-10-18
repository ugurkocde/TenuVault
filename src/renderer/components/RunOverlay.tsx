import { useEffect, useRef, type ReactNode } from "react"
import { Check } from "lucide-react"
import { cn } from "~/lib/utils"
import { BrandMark } from "./BrandMark"

export interface RunOverlayStep {
  label: string
  state: "done" | "current" | "waiting"
}

/**
 * A running job as a full-page overlay over the content column, so starting a run never
 * pushes the page around: the host page stays mounted underneath (rendered inert by the
 * host while the overlay shows) and is uncovered when the run finishes. The sidebar
 * (z-40) stays above it, so the app can still be navigated mid-run. All motion is
 * transform and opacity (desktop.css), which the compositor runs off the main thread.
 * The host page supplies the run semantics: heading, percent, detail lines and steps.
 */
export function RunOverlay({ ariaLabel, title, subtitle, percent, progressLabel, progressValueText, detail, subDetail, steps, summary, error, actions, captureFocus = true, focusFallbackSelector = '[aria-label="Results header"]', children }: {
  ariaLabel: string
  title: string
  subtitle?: string
  /** Whole percent for the single progress bar, or null while the run is indeterminate. */
  percent: number | null
  progressLabel: string
  progressValueText?: string
  /** Fixed-height live line under the bar, such as a count or the current step detail. */
  detail?: string
  /** Second fixed-height line, truncated, such as the item being read or the elapsed time. */
  subDetail?: string
  steps?: RunOverlayStep[]
  /** Slot above the error, for partial tallies and counts. */
  summary?: ReactNode
  error?: string
  /** Slot below the error, for a Cancel button. */
  actions?: ReactNode
  /**
   * Focus moves into the overlay on entry and back out on exit. A run the admin did not
   * start from this page (an auto-started scan) passes false, so opening the page never
   * takes focus unprompted.
   */
  captureFocus?: boolean
  /** Where focus lands on exit when the control that started the run is gone. */
  focusFallbackSelector?: string
  /** Slot under the error, for partial results streamed during the run. */
  children?: ReactNode
}) {
  // Focus moves into the overlay on entry, because the covered page is inert while it shows.
  // On exit it returns to the control that started the run, or to the fallback when that
  // control is gone (a first run replaces setup with results), but only when focus is still in
  // the overlay: focus the user moved to the sidebar or a dialog is left where it is.
  const overlayRef = useRef<HTMLDivElement>(null)
  // Captured once, in a ref: Strict Mode replays the mount effect, and a recapture after the
  // first cleanup would save the overlay itself instead of the control that started the run.
  const restoreFocusTo = useRef<{ captured: boolean; target: HTMLElement | null }>({ captured: false, target: null })
  const captureOnMount = useRef(captureFocus).current
  const fallback = useRef(focusFallbackSelector).current
  // Where focus was last seen, tracked on focusin: by cleanup time the overlay may already be
  // out of the DOM, which puts focus on body and hides that it just left the overlay.
  const focusInside = useRef(false)
  useEffect(() => {
    const overlay = overlayRef.current
    const track = (event: FocusEvent) => { focusInside.current = !!(overlay && event.target instanceof Node && overlay.contains(event.target)) }
    document.addEventListener("focusin", track)
    if (captureOnMount) {
      if (!restoreFocusTo.current.captured) {
        const active = document.activeElement
        restoreFocusTo.current = { captured: true, target: active instanceof HTMLElement && active !== document.body && !(overlay && overlay.contains(active)) ? active : null }
      }
      overlay?.focus({ preventScroll: true })
      focusInside.current = true
    }
    return () => {
      document.removeEventListener("focusin", track)
      const active = document.activeElement
      const inside = focusInside.current || !!(overlay && active && overlay.contains(active))
      if (active && active !== document.body && !inside) return
      // A run that never captured focus only moves it when the overlay itself held it (the
      // admin tabbed to Cancel), so an auto-started run finishing never yanks focus either.
      if (!captureOnMount && !inside) return
      const target = restoreFocusTo.current.target
      if (target?.isConnected) target.focus({ preventScroll: true })
      else document.querySelector<HTMLElement>(fallback)?.focus({ preventScroll: true })
    }
  }, [captureOnMount, fallback])
  const valueText = progressValueText ?? (percent !== null ? `${percent} percent${detail ? `, ${detail}` : ""}` : title)
  return <div ref={overlayRef} role="region" tabIndex={-1} aria-label={ariaLabel} className="run-overlay fixed inset-y-0 right-0 left-64 z-30 overflow-y-auto bg-background/90 backdrop-blur-sm outline-none">
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      <div className="run-panel w-full max-w-[36rem] text-center">
        <BrandMark className="mx-auto size-12" />
        <div role="status" className="mt-5">
          <h2 className="text-2xl font-light tracking-tight text-gray-900">{title}</h2>
          {subtitle && <p className="mt-2 text-sm text-gray-500">{subtitle}</p>}
        </div>
        {/* Fixed height, so the percent appearing after connecting never shifts the bar below it. */}
        <p aria-hidden="true" className="mt-7 flex h-16 items-baseline justify-center text-6xl font-light leading-none tabular-nums text-gray-900">{percent !== null && <>{percent}<span className="text-3xl text-gray-500">%</span></>}</p>
        <div role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} {...(percent !== null ? { "aria-valuenow": percent } : {})} aria-valuetext={valueText} className="mt-4 h-1.5 overflow-hidden rounded-full bg-gray-200">
          {percent !== null
            ? <div className="h-full w-full origin-left rounded-full bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${percent / 100})` }} />
            : <div className="run-indeterminate h-full w-1/3 rounded-full bg-primary" />}
        </div>
        {/* Fixed-height lines: long names truncate instead of wrapping and moving the steps. */}
        {detail !== undefined && <p className="mt-4 h-5 truncate text-sm font-medium tabular-nums text-gray-700" title={detail || undefined}>{detail}</p>}
        {subDetail !== undefined && <p title={subDetail || undefined} className="h-5 truncate text-xs text-gray-500">{subDetail}</p>}
        {!!steps?.length && <ol className="mt-7 flex items-start justify-between gap-2">
          {steps.map((step, index) => <li key={step.label} {...(step.state === "current" ? { "aria-current": "step" as const } : {})} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span aria-hidden="true" className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold", step.state === "done" ? "bg-green-100 text-green-800" : step.state === "current" ? "bg-primary text-primary-foreground motion-safe:animate-pulse" : "bg-gray-200 text-gray-500")}>{step.state === "done" ? <Check className="h-3.5 w-3.5" /> : index + 1}</span>
            <span className={cn("text-xs font-medium leading-tight", step.state === "waiting" ? "text-gray-500" : "text-gray-900")}>{step.label}</span>
            <span className="text-[11px] leading-tight text-gray-500">{step.state === "done" ? "Done" : step.state === "current" ? "In progress" : "Waiting"}</span>
          </li>)}
        </ol>}
        {summary}
        {error && <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
        {children}
        {actions && <div className="mt-7 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
      </div>
    </div>
  </div>
}
