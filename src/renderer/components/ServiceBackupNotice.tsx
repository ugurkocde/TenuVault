import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { ConnectionHealthReport } from "../../shared/connection-health/model"
import { BackupCoverage } from "./BackupCoverage"
import { moduleForFolder } from "../../shared/services/modules"
import { coverageIssue } from "../../shared/services/backup-coverage"
import { NoticeCard, noticeActionClass } from "./NoticeCard"
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
  const services = `${settingsHref("services")}&tenant=${encodeURIComponent(tenantId)}`
  const missing = report.coverage?.flatMap(row => row.folders.filter(folder => coverageIssue(row, folder) === "permission")) ?? []
  const modules = new Set(missing.map(folder => moduleForFolder(folder)?.module.id))
  const module = modules.size === 1 ? modules.values().next().value : undefined
  const access = report.services.find(service => service.id === module)?.access
  const signIn = `sign-in-${tenantId.toLowerCase()}`
  const accessTarget = method === "graphCli" ? settingsHref("signin", signIn)
    : method === "tenuvaultApp" && module && access ? `${settingsHref("signin")}&pack=${module}-${access}#${signIn}`
    : services
  return <>
    {showCoverage && report.coverage && <BackupCoverage coverage={report.coverage} emptyLabel="Off"
      action={missing.length > 0 && <Link className={noticeActionClass} to={accessTarget}>Add access</Link>} />}
    {report.services.find(service => service.id === "intune")?.enabled === false && <NoticeCard
      summary="Intune is off for new backups."
      details="New manual and scheduled backups leave out Intune. Existing backups keep their contents."
      action={<Link to={services} className={noticeActionClass}>Turn on Intune</Link>}
    />}
  </>
}
