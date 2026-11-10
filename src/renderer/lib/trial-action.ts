import { useRef, useState } from "react"
import { useLicense } from "./license"

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function useTrialAction() {
  const { refresh } = useLicense()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  // One action at a time, also for two clicks that arrive before the buttons are disabled.
  const running = useRef(false)
  const run = async (action: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError("")
    try {
      await action()
    } catch (error) {
      setError(message(error))
    } finally {
      try { await refresh() }
      catch (error) { setError(current => current || message(error)) }
      running.current = false
      setBusy(false)
    }
  }
  return { busy, error, run }
}
