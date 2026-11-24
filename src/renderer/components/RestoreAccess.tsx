import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { restoreCapability, typeForFolder } from "../../shared/intune/registry"
import type { ConnectionHealthReport } from "../../shared/connection-health/model"
import { moduleForFolder, MODULE_BY_ID, type ModuleId } from "../../shared/services/modules"
import { missingPackScopes, servicePack } from "../../shared/services/permission-packs"
import { backupServiceForFolder, BACKUP_SERVICES } from "../../shared/services/presentation"
import { GRAPH_CLI_READ_ONLY, sharedSignInMethod } from "../../shared/tenant-connection"
import { bridge } from "../lib/bridge"
import { settingsHref } from "../lib/settings-section"
import { PermissionRoutes } from "./ServicesSettings"
import { StartNowUpgradeLinks } from "./StartNowNotice"
import { TenuVaultConsent } from "./TenuVaultConsent"

type Credentials = { tenantId: string; appId: string }
type AccessIssue = { id: ModuleId; label: string; missing: string[]; method: "graphCli" | "tenuvaultApp" | "ownApp"; enabled?: boolean; areas?: string[] }

export function useRestoreAccess(credentials: Credentials | undefined, active: boolean) {
  const tenantId = credentials?.tenantId.toLowerCase()
  const clientId = credentials?.appId.toLowerCase()
  const method = sharedSignInMethod(clientId ?? null) ?? "ownApp"
  const [report, setReport] = useState<ConnectionHealthReport | null>(null)
  const [verified, setVerified] = useState<{ tenantId: string; scopes: string[] } | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState("")
  const generation = useRef(0)
  const refresh = useCallback(async (again = false) => {
    if (!tenantId || !clientId || method === "graphCli" || !bridge.health?.check) return
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
    if (method === "graphCli") return { id, label, missing: [], method }
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
      if (issue.method === "graphCli") return [issue]
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
  if (!issues.length) return null
  if (issues[0]?.method === "graphCli") return <StartNowUpgradeLinks tenantId={tenantId.toLowerCase()} message={GRAPH_CLI_READ_ONLY} />
  return <div className="space-y-3" data-no-select>
    {issues.map(issue => {
      const module = MODULE_BY_ID.get(issue.id)!
      return <section key={issue.id} aria-label={`${module.label} restore access`} className="space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-gray-700">
        <p className="font-medium text-gray-900">Restore access for {module.label}</p>
        {issue.method === "tenuvaultApp" ? issue.enabled ? <>
          <p>An administrator can approve restore access for this service.</p>
          <TenuVaultConsent tenantId={tenantId} plan={{ packs: [servicePack(issue.id, "restore", issue.areas)] }} active
            restore={{ id: issue.id, label: module.label }} onRestoreVerified={() => void onCheck()} />
        </> : <Link className="font-medium underline" to={settingsHref("services")}>Turn on {module.label} in Services and permissions</Link>
          : <>
            <p className="break-words">Add these permissions to your app registration to restore the selected policies. {issue.missing.join(", ")}</p>
            <PermissionRoutes report={{ tenantId, clientId }} missing={issue.missing} inApp restoring />
            <Button variant="outline" size="sm" disabled={checking} onClick={() => void onCheck()}>Check again</Button>
          </>}
      </section>
    })}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
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
