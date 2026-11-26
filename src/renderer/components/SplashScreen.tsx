import { ArrowRight, DatabaseBackup, GitCompare, MonitorSmartphone, RotateCcw, ShieldCheck } from "lucide-react"
import { useEffect, useRef, useState, type CSSProperties } from "react"
import { Button } from "~/components/ui/button"
import { bridge } from "../lib/bridge"
import { BrandMark } from "./BrandMark"
import { onboardingPrimary } from "./OnboardingCard"

const SEEN_KEY = "tenuvault.splash.seen"
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)"
const INTRO_DELAY = 200
const INTRO_DURATION = 500
const CONTENT_START = INTRO_DELAY + INTRO_DURATION + 200
const TILE_ENTRY = 1500
/** When the Get started button has finished rising: focus waits for it, so the ring never lands on an invisible button. */
const ACTION_SETTLED = CONTENT_START + 400 + 1000
const EXIT_DURATION = 500
const TILE_EASE = "cubic-bezier(0.84, 0, 0.16, 1)"
const tiles = {
  devices: { Icon: MonitorSmartphone, shape: "circle", fill: "var(--color-coral-500)" },
  backup: { Icon: DatabaseBackup, shape: "square", fill: "var(--color-coral-300)" },
  access: { Icon: ShieldCheck, shape: "tag", fill: "var(--color-coral-700)" },
  restore: { Icon: RotateCcw, shape: "square", fill: "var(--tv-splash-restore-fill)" },
  compare: { Icon: GitCompare, shape: "circle", fill: "var(--color-coral-200)" },
}
const slots = [
  { primary: "devices", alternate: "compare", entryPosition: 3 },
  { primary: "backup", alternate: "devices", entryPosition: 1 },
  { primary: "access", alternate: "restore", entryPosition: 2 },
  { primary: "restore", alternate: "access", entryPosition: 0 },
  { primary: "compare", alternate: "backup", entryPosition: 4 },
] as const

/**
 * Kept in both local storage and the encrypted app store, so clearing either one does not bring the
 * splash back. A read that fails counts as seen: showing it again is worse than skipping it once.
 */
function splashSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1" || bridge.storage.getItemSync(SEEN_KEY) === "1"
  } catch {
    return true
  }
}

export function markSplashSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1")
  } catch {
    // The app store below still remembers it.
  }
  try {
    if (bridge.storage.getItemSync(SEEN_KEY) !== "1") {
      void bridge.storage.setItem(SEEN_KEY, "1").catch((error: unknown) => console.warn("Could not save that the splash was seen:", error))
    }
  } catch (error) {
    console.warn("Could not save that the splash was seen:", error)
  }
}

export function shouldShowSplash(): boolean {
  if (splashSeen()) return false
  if (window.matchMedia?.(REDUCED_MOTION).matches) {
    // Skipped for good: turning motion back on later must not show it in the middle of setup.
    markSplashSeen()
    return false
  }
  return true
}

/**
 * After the tiles have slid in, they swap between two layouts. The loop starts when the slide-in has
 * really finished (it waits while the window is hidden in the tray) and pauses rather than restarts
 * while the window is hidden, so showing the window again never pops the tiles back.
 */
function animateTiles(row: HTMLDivElement) {
  const motion = window.matchMedia(REDUCED_MOTION)
  let animations: Animation[] = []
  let ready = false
  let disposed = false
  const stagger = 100
  const scaleDuration = 300
  const sweep = (slots.length - 1) * stagger + scaleDuration
  const hold = 1000
  const cycle = 4 * sweep + hold + 1500
  const frame = (time: number, scale: number) => ({ offset: time / cycle, transform: `scale(${scale})`, easing: TILE_EASE })
  const start = () => {
    const animateLayer = (selector: string, alternate: boolean) => {
      row.querySelectorAll<HTMLElement>(selector).forEach((tile, index) => {
        const begin = (alternate ? sweep : 0) + index * stagger
        const reverse = (alternate ? 2 : 3) * sweep + hold + index * stagger
        const resting = alternate ? 0 : 1
        animations.push(tile.animate([
          frame(begin, resting),
          frame(begin + scaleDuration, 1 - resting),
          frame(reverse, 1 - resting),
          frame(reverse + scaleDuration, resting),
        ], { duration: cycle, iterations: Infinity }))
      })
    }
    animateLayer(".tv-splash-tile-primary", false)
    animateLayer(".tv-splash-tile-alternate", true)
  }
  const sync = () => {
    if (disposed || !ready) return
    if (motion.matches) {
      for (const animation of animations) animation.cancel()
      animations = []
      return
    }
    if (animations.length === 0) start()
    const hidden = document.visibilityState === "hidden"
    for (const animation of animations) {
      if (hidden) animation.pause()
      else animation.play()
    }
  }
  const entries = typeof row.getAnimations === "function" ? row.getAnimations({ subtree: true }) : []
  void Promise.allSettled(entries.map(animation => animation.finished)).then(() => {
    ready = true
    sync()
  })
  document.addEventListener("visibilitychange", sync)
  motion.addEventListener("change", sync)
  return () => {
    disposed = true
    document.removeEventListener("visibilitychange", sync)
    motion.removeEventListener("change", sync)
    for (const animation of animations) animation.cancel()
    animations = []
  }
}

function Tile({ tile: { Icon, shape, fill }, alternate = false }: { tile: typeof tiles[keyof typeof tiles]; alternate?: boolean }) {
  return (
    <div className={`tv-splash-tile tv-splash-tile-${shape} tv-splash-tile-${alternate ? "alternate" : "primary"}`} style={{ backgroundColor: fill }}>
      <Icon strokeWidth={1.5} />
    </div>
  )
}

export function SplashScreen({ onDone }: { onDone: () => void }) {
  const row = useRef<HTMLDivElement>(null)
  const action = useRef<HTMLButtonElement>(null)
  const done = useRef(onDone)
  done.current = onDone
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (row.current && typeof row.current.animate === "function") return animateTiles(row.current)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) action.current?.focus()
    }, window.matchMedia?.(REDUCED_MOTION).matches ? 0 : ACTION_SETTLED)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!exiting) return
    const timer = window.setTimeout(() => done.current(), window.matchMedia?.(REDUCED_MOTION).matches ? 0 : EXIT_DURATION)
    return () => window.clearTimeout(timer)
  }, [exiting])

  function getStarted() {
    if (exiting) return
    markSplashSeen()
    setExiting(true)
  }

  return (
    <main
      className={`tv-splash-screen relative grid h-dvh overflow-hidden bg-background text-foreground${exiting ? " tv-splash-exiting" : ""}`}
      aria-labelledby="tv-splash-title"
      style={{
        "--tv-splash-intro-delay": `${INTRO_DELAY}ms`,
        "--tv-splash-intro-duration": `${INTRO_DURATION}ms`,
        "--tv-splash-content-start": `${CONTENT_START}ms`,
        "--tv-splash-exit-duration": `${EXIT_DURATION}ms`,
      } as CSSProperties}
    >
      <div className="flex flex-col items-center justify-center px-6 text-center">
        <BrandMark title="TenuVault" className="tv-splash-mark mb-7 size-12" />
        <h1 id="tv-splash-title" className="tv-splash-title text-balance font-medium">
          <span className="tv-splash-rise block">Intune backup, restore</span>{" "}
          <span className="tv-splash-rise tv-splash-second-line block">and disaster recovery</span>
        </h1>
        <p className="tv-splash-rise tv-splash-subtitle mt-6 max-w-xl text-balance text-lg text-muted-foreground">
          Back up the Microsoft services you choose, restore what breaks, and see what changed.
        </p>
        <div className="tv-splash-rise tv-splash-action mt-7">
          <Button ref={action} type="button" className={`${onboardingPrimary} focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background`} aria-disabled={exiting} onClick={getStarted}>
            Get started <ArrowRight className="ml-2 size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div ref={row} aria-hidden="true" className="tv-splash-tiles">
        {slots.map(({ primary, alternate, entryPosition }) => {
          const delay = entryPosition * 150
          return (
            <div key={primary} className="tv-splash-slot" style={{
              "--tv-splash-slot-delay": `${delay}ms`,
              "--tv-splash-slot-duration": `${TILE_ENTRY - delay}ms`,
            } as CSSProperties}>
              <Tile tile={tiles[primary]} />
              <Tile tile={tiles[alternate]} alternate />
            </div>
          )
        })}
      </div>
      <div aria-hidden="true" className="tv-splash-overlay pointer-events-none absolute inset-0 bg-background" />
    </main>
  )
}
