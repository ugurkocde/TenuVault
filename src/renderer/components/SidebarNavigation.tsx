import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "~/lib/utils"

const FOLDED_KEY = "tenuvault.sidebar.folded"

function readFolded(): Set<string> {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]")
    return new Set(Array.isArray(list) ? list.filter((label): label is string => typeof label === "string") : [])
  } catch {
    return new Set()
  }
}

/** The sidebar groups this computer keeps folded, remembered across restarts. Every group starts open. */
export function useFoldedGroups() {
  const [folded, setFolded] = useState(readFolded)
  useEffect(() => {
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]))
    } catch {
      // Without storage the groups simply open again next time.
    }
  }, [folded])
  const toggle = (label: string) =>
    setFolded((current) => {
      const next = new Set(current)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  return { folded, toggle }
}

/**
 * Content that folds to nothing: its row eases between full and zero height while the content fades
 * and blurs (styles in desktop.css). Folded content stays in the page but is inert, so it takes no
 * focus or clicks and screen readers skip it.
 */
export function Fold({ id, open, children }: { id?: string; open: boolean; children: ReactNode }) {
  return (
    <div id={id} className="tv-fold" data-open={open ? "true" : "false"}>
      <div className="tv-fold-inner" inert={!open}>{children}</div>
    </div>
  )
}

/**
 * A labelled sidebar group whose heading folds it. The caret shows on hover and focus, and stays
 * while the group is folded; a coral dot marks a folded group that holds the open page.
 */
export function NavFoldGroup({ label, open, holdsActive, onToggle, children }: {
  label: string
  open: boolean
  holdsActive: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const id = `nav-group-${label}`
  return (
    <div role="group" aria-labelledby={id} className="space-y-px">
      <button
        type="button"
        id={id}
        aria-expanded={open}
        aria-controls={`nav-items-${label}`}
        onClick={onToggle}
        className="group/fold flex w-full items-center gap-1 rounded-lg px-4 pb-1 pt-2.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {label}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "tv-fold-caret h-3 w-3 transition-opacity",
            open ? "opacity-0 group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100" : "-rotate-90",
          )}
        />
        {!open && holdsActive && <><span aria-hidden="true" className="ml-0.5 size-1.5 rounded-full bg-coral-500" /><span className="sr-only">, holds the open page</span></>}
      </button>
      <Fold id={`nav-items-${label}`} open={open}>
        <div className="space-y-px">{children}</div>
      </Fold>
    </div>
  )
}

/**
 * Two pills behind the rows of the main navigation: a soft one that slides to the row under the
 * pointer and the filled one that glides to the open page. Rows opt in with `data-nav-row`; the open
 * page is the row holding `aria-current="page"`. While the pills run, desktop.css takes the rows' own
 * backgrounds away, so without ResizeObserver (tests) every row keeps its plain hover and active styles.
 */
export function useSlidingPills(navRef: RefObject<HTMLElement | null>, routeKey: string) {
  const hoverRef = useRef<HTMLSpanElement>(null)
  const activeRef = useRef<HTMLSpanElement>(null)
  const syncRef = useRef<(instant?: boolean) => void>(() => undefined)
  const [on, setOn] = useState(false)

  useEffect(() => {
    const nav = navRef.current
    const hoverPill = hoverRef.current
    const activePill = activeRef.current
    if (!nav || !hoverPill || !activePill || typeof ResizeObserver === "undefined") return
    let hovered: HTMLElement | null = null
    let followUntil = 0
    let frame = 0

    const rowOf = (element: Element | null) => element?.closest<HTMLElement>("[data-nav-row]") ?? null
    const folded = (row: HTMLElement) => Boolean(row.closest('.tv-fold[data-open="false"]'))
    const place = (pill: HTMLElement, row: HTMLElement, instant: boolean) => {
      const box = nav.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      if (instant) pill.style.transition = "none"
      pill.style.transform = `translate(${rect.left - box.left + nav.scrollLeft}px, ${rect.top - box.top + nav.scrollTop}px)`
      pill.style.width = `${rect.width}px`
      pill.style.height = `${rect.height}px`
      if (instant) {
        void pill.offsetWidth
        pill.style.transition = ""
      }
    }
    // A pill that was hidden appears in place instead of sliding in from where it last was.
    const show = (pill: HTMLElement, row: HTMLElement | null, instant: boolean) => {
      if (!row || folded(row)) {
        pill.dataset.shown = "false"
        return
      }
      place(pill, row, instant || pill.dataset.shown !== "true")
      pill.dataset.shown = "true"
    }
    const sync = (instant = false) => {
      const active = rowOf(nav.querySelector('[aria-current="page"]'))
      show(activePill, active, instant)
      show(hoverPill, hovered === active ? null : hovered, instant)
    }
    // While a group folds or unfolds, the rows move every frame; the pills follow them exactly.
    const follow = () => {
      followUntil = performance.now() + 500
      if (frame) return
      const tick = () => {
        sync(true)
        frame = performance.now() < followUntil ? requestAnimationFrame(tick) : 0
      }
      frame = requestAnimationFrame(tick)
    }

    const onOver = (event: PointerEvent) => {
      const row = rowOf(event.target as Element)
      hovered = row && row.getAttribute("aria-disabled") !== "true" ? row : null
      sync()
    }
    const onLeave = () => {
      hovered = null
      sync()
    }
    const onTransition = (event: TransitionEvent) => {
      if ((event.target as Element).classList?.contains("tv-fold")) follow()
    }
    const onScroll = () => sync(true)
    const resize = new ResizeObserver(() => sync(true))
    resize.observe(nav)
    for (const child of nav.children) resize.observe(child)

    nav.addEventListener("pointerover", onOver)
    nav.addEventListener("pointerleave", onLeave)
    nav.addEventListener("transitionrun", onTransition)
    nav.addEventListener("scroll", onScroll, { passive: true })
    syncRef.current = sync
    setOn(true)
    sync(true)
    return () => {
      resize.disconnect()
      cancelAnimationFrame(frame)
      nav.removeEventListener("pointerover", onOver)
      nav.removeEventListener("pointerleave", onLeave)
      nav.removeEventListener("transitionrun", onTransition)
      nav.removeEventListener("scroll", onScroll)
      syncRef.current = () => undefined
      setOn(false)
    }
  }, [navRef])

  // A new page: the filled pill glides to its row once React has marked it.
  useEffect(() => { syncRef.current() }, [routeKey, on])

  return { on, hoverRef, activeRef }
}
