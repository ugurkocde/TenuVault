import { useEffect, useId, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, MinusCircle, RefreshCw } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { useTenants } from "~/contexts/TenantContext"
import type { ServiceModuleStatus, ServicesStatus } from "../../shared/ipc"
import type { AreaCheck, Readiness } from "../../shared/services/modules"
import { bridge } from "../lib/bridge"
import { toast } from "../lib/toast"

const READINESS_TEXT: Record<Readiness, string> = { ready: "Ready", partial: "Partly covered", missing: "Not permitted" }

function ReadinessBadge({ label, readiness }: { label: string; readiness: Readiness | null }) {
  const tone = readiness === "ready" ? "bg-green-50 text-green-800" : readiness === "partial" ? "bg-amber-50 text-amber-800" : readiness === "missing" ? "bg-red-50 text-red-800" : "bg-gray-100 text-gray-600"
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}: {readiness ? READINESS_TEXT[readiness] : "Unknown"}</span>
}

function AreaLine({ area }: { area: AreaCheck }) {
  const ok = area.backup && area.restore
  const icon = ok
    ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-600" aria-hidden="true" />
    : area.backup
      ? <MinusCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600" aria-hidden="true" />
      : <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-600" aria-hidden="true" />
  return (
    <li className="flex items-start gap-2">
      {icon}
      <span>
        <span className="text-gray-900">{area.label}</span>
        {ok ? <span className="text-gray-500">: backup and restore</span> : null}
        {!area.backup ? <span className="block text-gray-500">Backup needs {area.missingBackup}.</span> : null}
        {area.backup && !area.restore ? <span className="block text-gray-500">Backup only. Restore needs {area.missingRestore}.</span> : null}
      </span>
    </li>
  )
}

function ModuleRow({ module, busy, onToggle }: { module: ServiceModuleStatus; busy: boolean; onToggle: (enabled: boolean) => void }) {
  const toggleId = useId()
  const check = module.check
  return (
    <div className="space-y-2 py-4 first:pt-1 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-gray-900">{module.label}</p>
        {module.enabled ? (
          <>
            <ReadinessBadge label="Backup" readiness={check?.backup ?? null} />
            <ReadinessBadge label="Restore" readiness={check?.restore ?? null} />
          </>
        ) : (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Off</span>
        )}
        {module.optIn ? (
          <label htmlFor={toggleId} className="ml-auto flex items-center gap-2 text-sm text-gray-700">
            <input id={toggleId} type="checkbox" className="h-4 w-4" checked={module.enabled} disabled={busy} onChange={(event) => onToggle(event.target.checked)} />
            Include in backups
          </label>
        ) : null}
      </div>
      <p className="text-sm text-gray-500">{module.description}</p>
      {module.enabled && check ? <ul className="space-y-1 text-sm">{check.areas.map((area) => <AreaLine key={area.label} area={area} />)}</ul> : null}
      {module.enabled && check && check.restore !== "ready" && module.restoreSetup ? <p className="text-sm text-gray-500">{module.restoreSetup}</p> : null}
      {module.enabled ? <p className="text-xs text-gray-500">Admin roles: {module.roles}</p> : null}
    </div>
  )
}

/**
 * The services each tenant backs up and what its app registration may do with each: read for
 * backups and drift, write for restores. Opt-in services are turned on here per tenant.
 */
export function ServicesSettings() {
  const tenants = useTenants().filter((tenant) => tenant.credentials?.tenantId)
  const selectId = useId()
  const [tenantId, setTenantId] = useState(tenants[0]?.credentials?.tenantId ?? "")
  const [status, setStatus] = useState<ServicesStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const tenant = tenants.find((candidate) => candidate.credentials?.tenantId === tenantId) ?? tenants[0]
  const clientId = tenant?.credentials?.appId ?? ""
  const currentTenant = tenant?.credentials?.tenantId ?? ""

  useEffect(() => {
    if (!currentTenant || !clientId) return
    // A slow answer for the tenant selected before must not replace this tenant's status.
    let current = true
    setStatus(null)
    bridge.services.status(currentTenant, clientId).then((next) => { if (current) setStatus(next) }, (error: unknown) => {
      if (current) setStatus({ tenantId: currentTenant, modules: [], checkedAt: null, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [currentTenant, clientId])

  if (!tenant) {
    return (
      <Card>
        <CardContent className="pt-6">Connect and sign in to a tenant to see which services TenuVault can back up and restore.</CardContent>
      </Card>
    )
  }

  const run = async (action: () => Promise<ServicesStatus>) => {
    setBusy(true)
    try {
      setStatus(await action())
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Services and permissions</CardTitle>
        <CardDescription>
          What TenuVault backs up for each tenant, and what the tenant's app registration allows: read permissions for backups and drift, write permissions for restores.
          TenuVault reads this from the sign-in it already has and changes nothing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          {tenants.length > 1 ? (
            <label htmlFor={selectId} className="text-sm text-gray-700">
              Tenant
              <select id={selectId} className="ml-2 rounded-md border border-gray-300 px-2 py-1 text-sm" value={currentTenant} onChange={(event) => setTenantId(event.target.value)}>
                {tenants.map((candidate) => <option key={candidate.id} value={candidate.credentials!.tenantId}>{candidate.name}</option>)}
              </select>
            </label>
          ) : null}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => bridge.services.status(currentTenant, clientId, true))}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Check again
          </Button>
          {status?.checkedAt ? <span className="text-xs text-gray-500">Permissions as of {new Date(status.checkedAt).toLocaleString()}. After adding a permission and granting consent, check again.</span> : null}
        </div>
        {status?.error ? <p className="text-sm text-red-700">The permissions could not be checked: {status.error}</p> : null}
        {status === null ? <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Checking permissions...</p> : null}
        <div className="divide-y divide-gray-100">
          {status?.modules.map((module) => (
            <ModuleRow key={module.id} module={module} busy={busy} onToggle={(enabled) => void run(() => bridge.services.setEnabled(currentTenant, clientId, module.id, enabled))} />
          ))}
        </div>
        <p className="text-xs text-gray-500">
          Roles cannot be read from the sign-in reliably (roles you can activate with Privileged Identity Management do not show until activated), so a write
          your account is not allowed to make is still refused by Microsoft with its own message.
        </p>
      </CardContent>
    </Card>
  )
}
