import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { restoreCapability, typeForFolder } from "../../shared/intune/registry"
import type { ConnectionHealthReport } from "../../shared/connection-health/model"
import { moduleForFolder, MODULE_BY_ID, type ModuleId } from "../../shared/services/modules"
import { missingPackScopes, servicePack } from "../../shared/services/permission-packs"
import { backupServiceForFolder, BACKUP_SERVICES } from "../../shared/services/presentation"
import { isTenuVaultApp } from "../../shared/tenant-connection"
import { bridge } from "../lib/bridge"
import { settingsHref } from "../lib/settings-section"
import { NoticeCard, noticeActionClass } from "./NoticeCard"
import { PermissionRoutes } from "./ServicesSettings"
import { TenuVaultConsent } from "./TenuVaultConsent"

type Credentials = { tenantId: string; appId: string }
type AccessIssue = { id: ModuleId; label: string; missing: string[]; method: "tenuvaultApp" | "ownApp"; enabled?: boolean; areas?: string[] }

export function useRestoreAccess(credentials: Credentials | undefined, active: boolean) {
  const tenantId = credentials?.tenantId.toLowerCase()
  const clientId = credentials?.appId.toLowerCase()
  const method = isTenuVaultApp(clientId) ? "tenuvaultApp" : "ownApp"
  const [report, setReport] = useState<ConnectionHealthReport | null>(null)
  const [verified, setVerified] = useState<{ tenantId: string; scopes: string[] } | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState("")
  const generation = useRef(0)
  const refresh = useCallback(async (again = false) => {
    if (!tenantId || !clientId || !bridge.health?.check) return
    const sent = ++generation.current
    setChecking(true)
    setError("")
    try {
      const [health, connection] = await Promise.all([
        bridge.health.check(tenantId, again),
        method === "tenuvaultApp" ? bridge.auth.connection(tenantId) : null,
      ])
      if (sent !== generation.current) return
      if (health.tenantId.toLowerCase() === tenantId && health.clientId.toLowerCase() === clientId) setReport(health)
      if (connection?.clientId.toLowerCase() === clientId) setVerified({ tenantId, scopes: connection.graphScopes ?? [] })
    } catch {
      if (sent === generation.current && again) setError("Could not check restore access. Try again.")
    } finally {
      if (sent === generation.current) setChecking(false)
    }
  }, [tenantId, clientId, method])

  useEffect(() => {
    if (!active) return
    void refresh()
    return () => { generation.current++ }
  }, [active, refresh])

  const current = report?.tenantId.toLowerCase() === tenantId && report?.clientId.toLowerCase() === clientId ? report : null
  const granted = current?.granted ? new Set(current.granted) : null
  const sharedScopes = verified?.tenantId === tenantId ? new Set(verified?.scopes) : null

  const issueFor = (folder: string): AccessIssue | undefined => {
    const type = typeForFolder(folder)
    const entry = moduleForFolder(folder)
    if (!entry || !type || ["none", "metadata"].includes(restoreCapability(type))) return
    const id = entry.module.id
    const label = BACKUP_SERVICES.find(service => service.id === backupServiceForFolder(folder))?.label ?? entry.module.label
    if (method === "tenuvaultApp" && current && sharedScopes) {
      if (entry.part.restore.delegated === "unsupported") return
      const service = current.services.find(service => service.id === id)
      if (!service) return
      const areas = service.areas.filter(area => area.optIn && area.enabled).map(area => area.id)
      const pack = servicePack(id, "restore", areas)
      const missing = missingPackScopes(pack.scopes, sharedScopes)
      if (service.access !== "restore" || !service.enabled || missing.length) return { id, label, missing, method, enabled: service.enabled, areas }
    }
    if (method !== "ownApp" || !granted || entry.part.restore.delegated === "unsupported") return
    const missing = entry.part.restore.delegated.filter(group => !group.some(scope => granted.has(scope))).map(group => group[0]!)
    if (missing.length) return { id, label, missing, method }
  }

  const issuesFor = (folders: readonly string[]): AccessIssue[] => {
    const issues = new Map<ModuleId, AccessIssue>()
    for (const folder of new Set(folders)) {
      const issue = issueFor(folder)
      if (!issue) continue
      const previous = issues.get(issue.id)
      issues.set(issue.id, previous ? { ...issue, missing: [...new Set([...previous.missing, ...issue.missing])] } : issue)
    }
    return [...issues.values()]
  }

  return { issuesFor, issueFor, refresh, checking: active && checking, error }
}

export function RestoreAccess({ credentials, issues, checking, error, onCheck }: {
  credentials: Credentials
  issues: readonly AccessIssue[]
  checking: boolean
  error: string
  onCheck: () => Promise<void> | void
}) {
  const { tenantId, appId: clientId } = credentials
  const services = [...new Set(issues.map(issue => issue.label))]
  const accessLink = issues.every(issue => issue.method === "tenuvaultApp" && issue.enabled)
    ? settingsHref("signin", `sign-in-${tenantId.toLowerCase()}`)
    : `${settingsHref("services")}&tenant=${encodeURIComponent(tenantId)}`
  return <div className="space-y-2" data-no-select>
    {services.length > 0 && <NoticeCard
      summary={services.length === 1 ? `Needs restore access for ${services[0]}.` : `Needs restore access for ${services.length} services.`}
      action={<Link className={noticeActionClass} to={accessLink}>Add access</Link>}
      details={<>
        {services.map(label => {
          const related = issues.filter(issue => issue.label === label)
          const permissions = new Set(related.flatMap(issue => issue.missing))
          return <section key={label} className="space-y-2">
            <p className="font-medium">{label}{permissions.size > 0 && ` (${permissions.size} missing)`}</p>
            {related.map(issue => {
              const module = MODULE_BY_ID.get(issue.id)!
              return issue.method === "tenuvaultApp"
                ? issue.enabled
                  ? <TenuVaultConsent key={issue.id} tenantId={tenantId} plan={{ packs: [servicePack(issue.id, "restore", issue.areas)] }} active
                    restore={{ id: issue.id, label: module.label }} onRestoreVerified={() => void onCheck()} />
                  : <p key={issue.id}>Turn on {module.label} in Services and permissions.</p>
                : <PermissionRoutes key={issue.id} report={{ tenantId, clientId }} missing={issue.missing} inApp restoring />
            })}
          </section>
        })}
        <Button variant="outline" size="sm" disabled={checking} onClick={() => void onCheck()}>Check again</Button>
      </>}
    />}
    {error && <NoticeCard tone="error" summary={error} />}
  </div>
}

export function RestoreTargetAccess({ credentials, folders, name }: { credentials: Credentials; folders: readonly string[]; name?: string }) {
  const access = useRestoreAccess(credentials, folders.length > 0)
  const issues = access.issuesFor(folders)
  if (!issues.length) return null
  return <div className="space-y-2">
    {name && <p className="text-sm font-medium text-gray-900">{name}</p>}
    <RestoreAccess credentials={credentials} issues={issues} checking={access.checking} error={access.error} onCheck={() => access.refresh(true)} />
  </div>
}
