import { useSyncExternalStore } from "react"
import type { ConnectLink } from "../../shared/deep-link"

let pending: ConnectLink | null = null
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }

/** A confirmed link is handed to the wizard, including when that page is already mounted. */
export function requestOnboardingConnect(details: ConnectLink): void {
  pending = details
  changed()
}

export function useOnboardingConnect(): ConnectLink | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => pending)
}

export function takeOnboardingConnect(): ConnectLink | null {
  const result = pending
  pending = null
  changed()
  return result
}
