import { useEffect, useState } from "react"
import { bridge } from "./bridge"

/** Internal CIS Benchmarks flag as reported by the main process. Off until reported on. */
export function useInternalCisBenchmarks(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let active = true
    void bridge.app.info().then(info => { if (active) setEnabled(info.internalCisBenchmarks === true) }).catch(() => undefined)
    return () => { active = false }
  }, [])
  return enabled
}
