import { useSyncExternalStore } from "react"
import { bridge } from "./bridge"

/**
 * The internal CIS claim for the renderer. The main process derives it from the
 * server-issued claim in a verified license entitlement. It enables Build Kit import,
 * internal testing tooling, and nothing else: CIS Benchmarks itself follows the
 * tenant's plan. This store starts and fails closed. LicenseProvider refreshes it
 * whenever license status changes, and the store also refreshes when the window
 * becomes visible or focused and periodically, so a mounted screen follows both a
 * later grant and a later revocation without restarting the app. A failed read is not a
 * revocation: the shown state keeps the last answer from the main process.
 */
const REFRESH_INTERVAL_MS = 30_000

let enabled = false
// Whether the main process has answered once since the window loaded.
let answered = false
let attempt = 0
// The newest read whose answer the store shows. An older read that settles later is out of date.
let settled = 0
const listeners = new Set<() => void>()
let interval: ReturnType<typeof setInterval> | null = null
let removeWindowListeners: (() => void) | null = null

function setEnabled(next: boolean): void {
  if (enabled === next && answered) return
  answered = true
  enabled = next
  for (const listener of listeners) listener()
}

/**
 * Reads the current claim from the main process. Build Kit import actions call this
 * immediately before acting instead of trusting the last rendered value. If a
 * newer read has already settled, an older read does not change the store, and
 * it returns access only when both it and the newer read granted it. A failed
 * read returns false to its caller but leaves the shown state unchanged.
 */
export async function refreshInternalCisBenchmarks(): Promise<boolean> {
  const current = ++attempt
  let next: boolean
  try {
    next = (await bridge.app.info()).internalCisBenchmarks === true
  } catch {
    return false
  }
  if (current < settled) return enabled && next
  settled = current
  setEnabled(next)
  return next
}

function startWatchers(): void {
  if (interval !== null) return
  interval = setInterval(() => { void refreshInternalCisBenchmarks() }, REFRESH_INTERVAL_MS)
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const onFocus = () => { void refreshInternalCisBenchmarks() }
    const onVisible = () => { if (document.visibilityState === "visible") void refreshInternalCisBenchmarks() }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    removeWindowListeners = () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }
}

function stopWatchers(): void {
  if (interval !== null) clearInterval(interval)
  interval = null
  removeWindowListeners?.()
  removeWindowListeners = null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) startWatchers()
  void refreshInternalCisBenchmarks()
  return () => {
    listeners.delete(listener)
    if (!listeners.size) stopWatchers()
  }
}

function snapshot(): boolean {
  return enabled
}

/**
 * The internal CIS claim as currently reported by the main process. The store is read
 * at subscription as well as on change, so an answer that settles between a render and its
 * subscription still reaches the screen.
 */
export function useInternalCisBenchmarks(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Clears the shared authorization store. Tests use this between bridge fixtures. */
export function resetInternalCisBenchmarks(): void {
  attempt += 1
  settled = attempt
  stopWatchers()
  listeners.clear()
  enabled = false
  answered = false
}
