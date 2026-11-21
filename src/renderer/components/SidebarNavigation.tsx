import { useEffect, useRef, useState, type ReactNode } from "react"
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
 * Content that folds to nothing: its row eases between full and zero height and clips the content,
 * which never fades, so labels in view keep their contrast (styles in desktop.css). Folded content
 * stays in the page but is inert, so it takes no focus or clicks and screen readers skip it.
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
        className="group/fold flex w-full items-center gap-1 rounded-lg px-4 pb-1 pt-2.5 text-left text-xs font-medium text-muted-foreground motion-safe:transition-colors hover:text-foreground"
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
 * A soft pill behind the rows of the main navigation that slides to the row under the pointer. Rows opt
 * in with `data-nav-row`. The open page keeps its own filled background, so its label is readable at
 * every moment, and the pill steps aside while the pointer is on it. While the pill runs, desktop.css
 * takes the other rows' hover backgrounds away; without ResizeObserver (tests) the rows keep them.
 *
 * It works on the nav element itself (a callback ref), so a sidebar that unmounts and comes back, as
 * it does around the first-run setup, gets a fresh pill bound to the new element.
 */
export function useHoverPill(routeKey: string) {
  const [nav, setNav] = useState<HTMLElement | null>(null)
  const syncRef = useRef<() => void>(() => undefined)
  const [on, setOn] = useState(false)

  useEffect(() => {
    const pill = nav?.querySelector<HTMLElement>(":scope > .tv-pill")
    if (!nav || !pill || typeof ResizeObserver === "undefined") return
    let hovered: HTMLElement | null = null
    let pointer: { x: number; y: number } | null = null
    let followUntil = 0
    let frame = 0
    let hideTimer = 0

    const rowOf = (element: Element | null) => element?.closest<HTMLElement>("[data-nav-row]") ?? null
    const usable = (row: HTMLElement | null): row is HTMLElement =>
      Boolean(row && nav.contains(row) && row.getAttribute("aria-disabled") !== "true" && !row.closest('.tv-fold[data-open="false"]'))
    const place = (row: HTMLElement, instant: boolean) => {
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
    const sync = (instant = false) => {
      // After a layout change the row under a resting pointer may be a different one, or gone.
      if (pointer && instant && typeof document.elementFromPoint === "function") hovered = rowOf(document.elementFromPoint(pointer.x, pointer.y))
      const active = rowOf(nav.querySelector('[aria-current="page"]'))
      const target = usable(hovered) && hovered !== active ? hovered : null
      if (!target) {
        // Once faded, the pill leaves the layout, so its old position never adds to the scroll height.
        // The timer starts once, when the pill goes, so a fold that syncs every frame cannot keep it waiting.
        if (pill.dataset.shown !== "false") {
          pill.dataset.shown = "false"
          window.clearTimeout(hideTimer)
          hideTimer = window.setTimeout(() => { if (pill.dataset.shown === "false") pill.style.display = "none" }, 200)
        }
        return
      }
      window.clearTimeout(hideTimer)
      const appearing = pill.dataset.shown !== "true"
      pill.style.display = ""
      // A pill that was hidden appears in place instead of sliding in from where it last was.
      place(target, instant || appearing)
      pill.dataset.shown = "true"
    }
    // While a group folds or unfolds, the rows move every frame; the pill follows them exactly.
    const follow = () => {
      followUntil = performance.now() + 500
      if (frame) return
      const tick = () => {
        sync(true)
        frame = performance.now() < followUntil ? requestAnimationFrame(tick) : 0
      }
      frame = requestAnimationFrame(tick)
    }

    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY }
      const row = rowOf(event.target as Element)
      if (row === hovered) return
      hovered = row
      sync()
    }
    const onLeave = () => {
      pointer = null
      hovered = null
      sync()
    }
    const onTransition = (event: TransitionEvent) => {
      if ((event.target as Element).classList?.contains("tv-fold")) follow()
    }
    const onScroll = () => sync(true)
    const resize = new ResizeObserver(() => sync(true))
    // The groups, not the pill: the pill resizing as it slides would otherwise snap itself into place.
    resize.observe(nav)
    for (const child of nav.children) if (child !== pill) resize.observe(child)

    nav.addEventListener("pointermove", onMove)
    nav.addEventListener("pointerleave", onLeave)
    nav.addEventListener("transitionrun", onTransition)
    nav.addEventListener("scroll", onScroll, { passive: true })
    syncRef.current = () => sync()
    setOn(true)
    sync(true)
    return () => {
      resize.disconnect()
      cancelAnimationFrame(frame)
      window.clearTimeout(hideTimer)
      nav.removeEventListener("pointermove", onMove)
      nav.removeEventListener("pointerleave", onLeave)
      nav.removeEventListener("transitionrun", onTransition)
      nav.removeEventListener("scroll", onScroll)
      syncRef.current = () => undefined
      setOn(false)
    }
  }, [nav])

  // A new page: the pill steps off the row that just became the open page.
  useEffect(() => { syncRef.current() }, [routeKey])

  // setNav is stable, so the nav's callback ref does not detach and re-attach on every render.
  return { on, nav, navRef: setNav }
}
