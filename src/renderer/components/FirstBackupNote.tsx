import { useEffect, useState } from "react"
import type { Plan } from "../../shared/plans"
import { bridge } from "../lib/bridge"
import { firstBackupNote } from "../lib/plan-notes"

// Several manual backups can finish together; only one completion shows this machine's note.
// The note counts as shown only once its preference is saved, so a failed write lets a later
// completion try again instead of hiding the note until the next restart.
let claimed = false
let reserved = false

/** Mounted only beside a successful manual backup's completion summary. */
export function FirstBackupNote({ plan }: { plan: Plan | null }) {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (plan !== "community" || claimed || reserved) return
    reserved = true
    let active = true
    void (async () => {
      try {
        const preferences = await bridge.preferences.get()
        if (claimed || !firstBackupNote(plan, preferences.firstBackupNoteSeen)) return
        await bridge.preferences.set({ firstBackupNoteSeen: true })
        claimed = true
        if (active) setShown(true)
      } catch (error: unknown) {
        console.error("Could not record the backup completion note:", error)
      } finally {
        reserved = false
      }
    })()
    return () => { active = false }
  }, [plan])

  const message = shown ? firstBackupNote(plan, false) : null
  return message ? <p className="text-sm text-gray-500">{message}</p> : null
}
