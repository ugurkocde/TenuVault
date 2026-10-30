import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { WhatsNewState } from "../../shared/ipc"
import { bridge } from "./bridge"

interface WhatsNewContextValue {
  state: WhatsNewState | null
  refresh: () => Promise<void>
  markSeen: () => Promise<void>
}

const WhatsNewContext = createContext<WhatsNewContextValue | null>(null)

/**
 * Release notes state for the What's new views: loaded once at start, shared by the
 * sidebar entry, the updates settings and the one-time stable dialog. Loading quietly
 * does nothing on failure: the main process reports the reason in the state itself.
 */
export function WhatsNewProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WhatsNewState | null>(null)
  const attempt = useRef(0)

  const apply = useCallback(async (load: () => Promise<WhatsNewState>) => {
    const current = ++attempt.current
    try {
      const next = await load()
      if (attempt.current === current) setState(next)
    } catch {
      // Without the bridge answer there is nothing to announce; Settings still links out.
    }
  }, [])

  const refresh = useCallback(() => apply(() => bridge.updates.whatsNew()), [apply])
  const markSeen = useCallback(() => apply(() => bridge.updates.markWhatsNewSeen()), [apply])

  useEffect(() => void refresh(), [refresh])

  return <WhatsNewContext.Provider value={{ state, refresh, markSeen }}>{children}</WhatsNewContext.Provider>
}

export function useWhatsNew(): WhatsNewContextValue {
  const value = useContext(WhatsNewContext)
  if (!value) throw new Error("useWhatsNew must be used inside WhatsNewProvider")
  return value
}
