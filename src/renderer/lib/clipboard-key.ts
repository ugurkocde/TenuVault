import { useEffect, useRef } from "react"
import { bridge } from "./bridge"

/**
 * While `active` (a trial key was requested and is on its way by email), checks the clipboard
 * whenever TenuVault gets focus and calls `onKey` with a license key copied from the email. The
 * main process only ever returns text shaped like a TenuVault key, nothing else on the clipboard.
 */
export function useClipboardLicenseKey(active: boolean, onKey: (key: string) => void): void {
  const listener = useRef(onKey)
  listener.current = onKey
  useEffect(() => {
    if (!active) return
    let last: string | null = null
    let stopped = false
    const check = () => {
      void bridge.license.clipboardKey().then((key) => {
        if (stopped || !key || key === last) return
        last = key
        listener.current(key)
      }).catch(() => undefined)
    }
    const onVisible = () => { if (document.visibilityState === "visible") check() }
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      stopped = true
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [active])
}
