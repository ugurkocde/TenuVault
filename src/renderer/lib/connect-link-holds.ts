import { useLayoutEffect, useSyncExternalStore } from "react"

const holds = new Set<symbol>()
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }

/** Explicit holds for modal dialogs and work that must finish before a link is presented. */
export function holdConnectLinks(): () => void {
  const id = Symbol()
  holds.add(id)
  changed()
  return () => { if (holds.delete(id)) changed() }
}

/** Runs work that must finish before a link is presented, such as a Microsoft sign-in, and always releases the hold. */
export async function whileHoldingConnectLinks<T>(work: () => Promise<T>): Promise<T> {
  const release = holdConnectLinks()
  try { return await work() } finally { release() }
}

export function useConnectLinkHold(held: boolean): void {
  useLayoutEffect(() => held ? holdConnectLinks() : undefined, [held])
}

export function useConnectLinksHeld(): boolean {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => holds.size > 0)
}
