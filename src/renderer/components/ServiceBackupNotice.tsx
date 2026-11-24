import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { ConnectionHealthReport } from "../../shared/connection-health/model"
import { BackupCoverage } from "./BackupCoverage"
import { coverageIssue } from "../../shared/services/backup-coverage"
import { moduleForFolder } from "../../shared/services/modules"
import { sharedSignInMethod } from "../../shared/tenant-connection"
import { bridge } from "../lib/bridge"
import { settingsHref } from "../lib/settings-section"

/** Current selection applies to future runs, never to the contents of older backups. */
export function ServiceBackupNotice({ tenantId, showCoverage = false }: { tenantId: string; showCoverage?: boolean }) {
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
  if (!report || report.tenantId.toLowerCase() !== tenantId.toLowerCase()) return null
  const method = sharedSignInMethod(report.clientId)
  const signIn = settingsHref("signin", `sign-in-${tenantId.toLowerCase()}`)
  const services = `${settingsHref("services")}&tenant=${encodeURIComponent(tenantId)}`
  return <>
    {showCoverage && report.coverage && <div className="mb-3" data-no-select>
      <BackupCoverage coverage={report.coverage} emptyLabel="Off" action={row => {
        const issues = row.folders.map(folder => coverageIssue(row, folder))
        const permissions = issues.includes("permission")
        if (method === "graphCli" && issues.some(Boolean)) return <Link className="text-xs font-medium text-blue-700 underline" to={signIn}>See sign-in upgrade options</Link>
        if (permissions && method === "tenuvaultApp") {
          const folder = row.folders.find(folder => coverageIssue(row, folder) === "permission")!
          const module = moduleForFolder(folder)?.module.id
          const access = report.services.find(service => service.id === module)?.access
          const href = module && access ? `${settingsHref("signin")}&pack=${module}-${access}#sign-in-${tenantId.toLowerCase()}` : signIn
          return <Link className="text-xs font-medium text-blue-700 underline" to={href}>Add app permissions</Link>
        }
        if (permissions) return <Link className="text-xs font-medium text-blue-700 underline" to={services}>Repair in Settings</Link>
        if (issues.includes("role")) return <p className="text-xs text-gray-600">Ask your administrator to review your role.</p>
        if (issues.includes("unknown")) return <Link className="text-xs font-medium text-blue-700 underline" to={services}>Check coverage in Settings</Link>
        return null
      }} />
    </div>}
    {report.services.find(service => service.id === "intune")?.enabled === false && <p className="rounded-2xl bg-blue-50 px-4 py-3 text-sm text-gray-700" data-no-select>
      <span className="font-medium">Intune is off.</span> New manual and scheduled backups leave out Intune. Existing backups keep their contents.{" "}
      <Link to={settingsHref("services")} className="font-medium text-blue-700 underline">Change services and permissions</Link>
    </p>}
  </>
}
