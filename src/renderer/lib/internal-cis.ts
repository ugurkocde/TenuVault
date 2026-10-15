import { useEffect, useState } from "react"
import { bridge } from "./bridge"

/**
 * Internal CIS Benchmarks access as reported by the main process, which derives it from
 * the server-issued claim in a verified license entitlement. Off until reported on, and
 * off in every build without that claim.
 */
export function useInternalCisBenchmarks(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let active = true
    void bridge.app.info().then(info => { if (active) setEnabled(info.internalCisBenchmarks === true) }).catch(() => undefined)
    return () => { active = false }
  }, [])
  return enabled
}
