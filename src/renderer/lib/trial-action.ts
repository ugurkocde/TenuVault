import { useState } from "react"
import { useLicense } from "./license"

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function useTrialAction() {
  const { refresh } = useLicense()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError("")
    try {
      await action()
    } catch (error) {
      setError(message(error))
    } finally {
      try { await refresh() }
      catch (error) { setError(current => current || message(error)) }
      setBusy(false)
    }
  }
  return { busy, error, run }
}
