import { useEffect, useState } from "react"
import { bridge } from "./bridge"

/**
 * Shared internal CIS Benchmarks authorization for the renderer. The main process
 * derives it from the server-issued claim in a verified license entitlement. This
 * store starts and fails closed, refreshes when the license changes, when the
 * window becomes visible or focused, and periodically, so a mounted screen follows
 * both a later grant and a later revocation without restarting the app.
 */
const REFRESH_INTERVAL_MS = 30_000

let enabled = false
let attempt = 0
const listeners = new Set<() => void>()
let interval: ReturnType<typeof setInterval> | null = null
let unsubscribeLicense: (() => void) | null = null
let removeWindowListeners: (() => void) | null = null

function setEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  for (const listener of listeners) listener()
}

/**
 * Reads the current authorization from the main process. Sensitive renderer-local
 * actions, such as Build Kit conversion and readiness file exports, call this
 * immediately before acting instead of trusting the last rendered value. If a
 * newer read has already settled, an older read returns that newer state.
 */
export async function refreshInternalCisBenchmarks(): Promise<boolean> {
  const current = ++attempt
  try {
    const info = await bridge.app.info()
    const next = info.internalCisBenchmarks === true
    if (current !== attempt) {
      // A revocation observed by any in-flight read closes the gate immediately.
      // A stale grant never reopens it after a newer read has settled.
      if (!next) setEnabled(false)
      return enabled && next
    }
    setEnabled(next)
    return next
  } catch {
    if (current !== attempt) return false
    setEnabled(false)
    return false
  }
}

function startWatchers(): void {
  if (interval !== null) return
  interval = setInterval(() => { void refreshInternalCisBenchmarks() }, REFRESH_INTERVAL_MS)
  try {
    if (typeof bridge.license?.onChanged === "function") {
      unsubscribeLicense = bridge.license.onChanged(() => { void refreshInternalCisBenchmarks() })
    }
  } catch {
    unsubscribeLicense = null
  }
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
  unsubscribeLicense?.()
  unsubscribeLicense = null
  removeWindowListeners?.()
  removeWindowListeners = null
}

/** Internal CIS Benchmarks access as currently reported by the main process. */
export function useInternalCisBenchmarks(): boolean {
  const [value, setValue] = useState(enabled)
  useEffect(() => {
    const listener = () => setValue(enabled)
    listeners.add(listener)
    if (listeners.size === 1) startWatchers()
    void refreshInternalCisBenchmarks()
    return () => {
      listeners.delete(listener)
      if (!listeners.size) stopWatchers()
    }
  }, [])
  return value
}

/** Clears the shared authorization store. Tests use this between bridge fixtures. */
export function resetInternalCisBenchmarks(): void {
  attempt += 1
  stopWatchers()
  listeners.clear()
  enabled = false
}
