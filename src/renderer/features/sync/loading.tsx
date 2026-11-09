import { useEffect, useState } from "react"
import { cn } from "~/lib/utils"

/** Loading pieces of the Sync screens. Each shows a request that is running, never estimated progress. */

/** Whole seconds since `running` turned true; 0 while it is false. A clock, never a progress estimate. */
export function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    setSeconds(0)
    if (!running) return
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [running])
  return seconds
}

/** "Still reading, 12 s" once a read has taken 5 seconds, so a slow tenant does not look stuck. */
export const stillReading = (seconds: number) => (seconds >= 5 ? `Still reading, ${seconds} s` : null)

/** A small spinner; it stands still under reduced motion. */
export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-3.5 shrink-0 rounded-full border-2 border-border border-t-coral-500 motion-safe:animate-spin", className)} />
}

/** A placeholder bar with a soft shimmer, for content that is still loading. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("sync-skeleton block rounded-full bg-gray-100", className)} />
}
