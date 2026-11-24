import { useEffect, useId, useState } from "react"
import { Link } from "react-router-dom"
import { CalendarClock, Check, X } from "lucide-react"
import { Button } from "~/components/ui/button"
import { settingsHref } from "@desktop/lib/settings-section"
import { MODULE_BY_ID } from "../../../shared/services/modules"
import type { DashboardBackup } from "~/hooks/dashboard/useDashboardStats"

export const scheduleHref = "/portal/backup?tab=schedule"
export const quietLink = "text-sm font-medium text-gray-700 underline decoration-gray-400 underline-offset-4 hover:text-gray-900"

export function useFirstBackupHero(tenantId: string, successes: number) {
  const key = `tenuvault:dashboard:first-backup:${tenantId}`
  const [dismissed, setDismissed] = useState<string>()
  useEffect(() => {
    if (tenantId && successes > 1) localStorage.setItem(key, "1")
  }, [key, tenantId, successes])
  const visible = !!tenantId && successes === 1 && dismissed !== key && globalThis.window?.localStorage.getItem(key) !== "1"
  return {
    visible,
    dismiss: () => {
      localStorage.setItem(key, "1")
      setDismissed(key)
    },
  }
}

export function FirstBackupHero({ tenantId, backup, scheduleAction, startNow, dismiss }: {
  tenantId: string
  backup: DashboardBackup
  scheduleAction: string | null
  startNow: boolean
  dismiss: () => void
}) {
  const title = useId()
  const coverageKey = `tenuvault:dashboard:start-now-coverage:${tenantId}`
  const [coverageDismissed, setCoverageDismissed] = useState(() => globalThis.window?.localStorage.getItem(coverageKey) === "1")
  const services = (backup.capturedServices ?? []).flatMap(id => MODULE_BY_ID.get(id)?.label ?? [])
  const serviceList = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(services)
  const count = backup.policiesBackedUp
  const parts = [`${count.toLocaleString()} ${count === 1 ? "policy" : "policies"}`]
  if (backup.inventoryBackedUp) parts.push(`${backup.inventoryBackedUp.toLocaleString()} inventory objects`)
  const viewHref = `/portal/backup?backup=${encodeURIComponent(backup.id)}`
  return (
    <section aria-labelledby={title} className="relative mx-auto max-w-[640px] rounded-3xl border border-gray-200 bg-white px-6 py-6 text-center shadow-sm">
      <Button type="button" variant="ghost" size="icon" aria-label="Dismiss first backup message" className="absolute right-3 top-3 size-8 rounded-full" onClick={dismiss}><X aria-hidden /></Button>
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-green-50 text-green-700"><Check className="size-6" aria-hidden /></div>
      <h2 id={title} className="mt-3 text-2xl font-medium tracking-tight text-gray-900">Your first backup is done</h2>
      <p className="mt-1 text-sm text-gray-600">{parts.join(" and ")}{serviceList && ` from ${serviceList}`}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2" data-no-select>
        <Button asChild className="min-h-11 min-w-52 rounded-full bg-blue-600 text-white hover:bg-blue-700">
          <Link to={scheduleAction ? scheduleHref : viewHref}>{scheduleAction ? <><CalendarClock aria-hidden />{scheduleAction}</> : "View backup"}</Link>
        </Button>
        {scheduleAction && <Link to={viewHref} className={quietLink}>View backup</Link>}
      </div>
      {startNow && !coverageDismissed && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t border-gray-100 pt-3 text-sm text-gray-600" data-no-select>
          <span>Start now backs up what your sign-in can read.</span>
          <Link to={settingsHref("services")} className={quietLink}>Add more coverage</Link>
          <Button type="button" variant="ghost" size="icon" aria-label="Dismiss coverage message" className="size-7 rounded-full" onClick={() => {
            localStorage.setItem(coverageKey, "1")
            setCoverageDismissed(true)
          }}><X aria-hidden /></Button>
        </div>
      )}
    </section>
  )
}
