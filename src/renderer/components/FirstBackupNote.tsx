import { useEffect, useState } from "react"
import type { Plan } from "../../shared/plans"
import { bridge } from "../lib/bridge"
import { firstBackupNote } from "../lib/plan-notes"

// Several manual backups can finish together; only one completion shows this machine's note.
let claimed = false

/** Mounted only beside a successful manual backup's completion summary. */
export function FirstBackupNote({ plan }: { plan: Plan | null }) {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (plan !== "community" || claimed) return
    let active = true
    void bridge.preferences.get().then((preferences) => {
      if (!active || claimed || !firstBackupNote(plan, preferences.firstBackupNoteSeen)) return
      claimed = true
      setShown(true)
    }).catch((error: unknown) => console.error("Could not read the backup completion note preference:", error))
    return () => { active = false }
  }, [plan])

  useEffect(() => {
    if (!shown) return
    void bridge.preferences.set({ firstBackupNoteSeen: true })
      .catch((error: unknown) => console.error("Could not save the backup completion note preference:", error))
  }, [shown])

  const message = shown ? firstBackupNote(plan, false) : null
  return message ? <p className="text-sm text-gray-500">{message}</p> : null
}
