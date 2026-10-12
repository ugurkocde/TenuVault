import { useEffect, useRef, useState } from "react"
import type { Plan } from "../../shared/plans"
import { bridge } from "../lib/bridge"
import { firstBackupNote } from "../lib/plan-notes"

// Several manual backups can finish together; only one completion shows this machine's note.
// The note is shown before its preference is saved and counts as shown only once the write
// succeeds, so neither a failed write nor a completion that disappears before the note renders
// consumes it for good.
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
        if (claimed || !mounted.current || !firstBackupNote(plan, preferences.firstBackupNoteSeen)) return
        setShown(true)
        await bridge.preferences.set({ firstBackupNoteSeen: true })
        claimed = true
      } catch (error: unknown) {
        console.error("Could not record the backup completion note:", error)
      } finally {
        reserved = false
      }
    })()
  }, [plan])

  const message = shown ? firstBackupNote(plan, false) : null
  return message ? <p className="text-sm text-gray-500">{message}</p> : null
}
