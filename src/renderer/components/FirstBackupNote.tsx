import { useEffect, useRef, useState } from "react"
import type { Plan } from "../../shared/plans"
import { bridge } from "../lib/bridge"
import { firstBackupNote } from "../lib/plan-notes"

// Several manual backups can finish together; only one completion shows this machine's note.
// The preference is saved by an effect that runs after the note has rendered, and the note
// counts as shown only once that write succeeds, so neither a failed write nor a completion
// view that disappears before the note appears consumes it for good.
let claimed = false
let reserved = false

/** Mounted only beside a successful manual backup's completion summary. */
export function FirstBackupNote({ plan }: { plan: Plan | null }) {
  const [shown, setShown] = useState(false)
  // A ref rather than a per-run flag, so the development double mount does not consume the note unseen.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (plan !== "community" || claimed || reserved) return
    reserved = true
    void (async () => {
      try {
        const preferences = await bridge.preferences.get()
        if (claimed || !mounted.current || !firstBackupNote(plan, preferences.firstBackupNoteSeen)) {
          reserved = false
          return
        }
        // The reservation stays until the effect below has saved the preference.
        setShown(true)
      } catch (error: unknown) {
        reserved = false
        console.error("Could not read the backup completion note preference:", error)
      }
    })()
  }, [plan])

  useEffect(() => {
    if (!shown) return
    void (async () => {
      try {
        await bridge.preferences.set({ firstBackupNoteSeen: true })
        claimed = true
      } catch (error: unknown) {
        console.error("Could not save the backup completion note preference:", error)
      } finally {
        reserved = false
      }
    })()
  }, [shown])

  const message = shown ? firstBackupNote(plan, false) : null
  return message ? <p className="text-sm text-gray-500">{message}</p> : null
}
