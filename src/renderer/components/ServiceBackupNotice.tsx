import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { ConnectionHealthReport } from "../../shared/connection-health/model"
import { bridge } from "../lib/bridge"
import { settingsHref } from "../lib/settings-section"

/** Current selection applies to future runs, never to the contents of older backups. */
export function ServiceBackupNotice({ tenantId }: { tenantId: string }) {
  const [report, setReport] = useState<ConnectionHealthReport | null>(null)
  useEffect(() => {
    let active = true
    let generation = 0
    const read = () => {
      const sent = ++generation
      void bridge.health.report(tenantId).then(next => {
        if (active && sent === generation && next.tenantId.toLowerCase() === tenantId.toLowerCase()) setReport(next)
      }).catch(() => { if (active && sent === generation) setReport(null) })
    }
    read()
    const unsubscribe = bridge.health.onChanged(changed => {
      if (changed.toLowerCase() === tenantId.toLowerCase()) read()
    })
    return () => { active = false; generation++; unsubscribe() }
  }, [tenantId])
  if (!report || report.tenantId.toLowerCase() !== tenantId.toLowerCase() || report.services.find(service => service.id === "intune")?.enabled !== false) return null
  return <p className="rounded-2xl bg-blue-50 px-4 py-3 text-sm text-gray-700" data-no-select>
    <span className="font-medium">Intune is off.</span> New manual and scheduled backups leave out Intune. Existing backups keep their contents.{" "}
    <Link to={settingsHref("services")} className="font-medium text-blue-700 underline">Change services and permissions</Link>
  </p>
}
