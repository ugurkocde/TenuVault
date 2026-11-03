import { useEffect, useId, useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import { AlertCircle, Check, CheckCircle2, Copy, ExternalLink, Loader2, MinusCircle, RefreshCw } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { useTenants } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { DOCS_HOME_URL } from "../../shared/constants"
import type { ServiceModuleStatus, ServicesStatus } from "../../shared/ipc"
import { entraApiPermissionsUrl, missingPermissions, restoreAccessCommands, type AreaCheck, type Readiness, type Requirement } from "../../shared/services/modules"
import { bridge } from "../lib/bridge"
import { toast } from "../lib/toast"

const READINESS_TEXT: Record<Readiness, string> = { ready: "Ready", partial: "Partly covered", missing: "Not permitted" }
const PERMISSIONS_DOCS = `${DOCS_HOME_URL}security/permissions/#check-what-the-app-registration-allows`
/** Tenants whose permissions are read at the same time for the overview. */
const OVERVIEW_CONCURRENCY = 4

type TenantStatus = ServicesStatus | "loading"

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`Copied ${what}.`, "success")
  } catch {
    toast(`Could not copy ${what}.`, "error")
  }
}

/** A permission name as admins type it into Entra, with a copy button. */
function PermissionChip({ name }: { name: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 py-0.5 pl-1.5 pr-0.5 align-middle font-mono text-xs text-gray-800">
      {name}
      <button
        type="button"
        className="flex size-5 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-800"
        aria-label={`Copy ${name}`}
        onClick={() => {
          void copy(name, name)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  )
}

/** "A or B", and every group needed: each permission as a chip. */
function Permissions({ requirement }: { requirement: Requirement }) {
  return (
    <>
      {requirement.map((group, groupIndex) => (
        <span key={group.join("|")}>
          {groupIndex > 0 ? " and " : null}
          {/* Alternatives next to other groups are bracketed, so "A or B and C" cannot be misread. */}
          {requirement.length > 1 && group.length > 1 ? "(" : null}
          {group.map((name, index) => (
            <span key={name}>
              {index > 0 ? " or " : null}
              <PermissionChip name={name} />
            </span>
          ))}
          {requirement.length > 1 && group.length > 1 ? ")" : null}
        </span>
      ))}
    </>
  )
}

/** On and off for an opt-in service, in the app's coral. */
function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) {
  const id = useId()
  return (
    <span className="ml-auto flex items-center gap-2 text-sm text-gray-700">
      <label htmlFor={id}>{label}</label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral-500 focus-visible:ring-offset-2 disabled:opacity-50",
          checked ? "bg-coral-600" : "bg-gray-300",
        )}
      >
        <span className={cn("inline-block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </button>
    </span>
  )
}

function ReadinessBadge({ label, readiness }: { label: string; readiness: Readiness | null }) {
  const tone = readiness === "ready" ? "bg-green-50 text-green-800" : readiness === "partial" ? "bg-amber-50 text-amber-800" : readiness === "missing" ? "bg-red-50 text-red-800" : "bg-gray-100 text-gray-600"
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}: {readiness ? READINESS_TEXT[readiness] : "Unknown"}</span>
}

/** One area with a gap, and the permissions that close it. */
function GapLine({ area }: { area: AreaCheck }) {
  const icon = area.backup
    ? <MinusCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden="true" />
    : <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" aria-hidden="true" />
  return (
    <li className="flex items-start gap-2">
      {icon}
      <span className="leading-6">
        <span className="text-gray-900">{area.label}</span>
        {!area.backup && area.missingBackup ? <span className="block text-gray-500">Backup needs <Permissions requirement={area.missingBackup} /></span> : null}
        {area.backup && area.missingRestore ? <span className="block text-gray-500">Backup only. Restore needs <Permissions requirement={area.missingRestore} /></span> : null}
      </span>
    </li>
  )
}

/** How to add the missing permissions to the tenant's existing app registration. */
function FixCallout({ module, tenantId, clientId }: { module: ServiceModuleStatus; tenantId: string; clientId: string }) {
  // The restore permission and its commands are the whole fix only when backup already works; otherwise
  // the read permission is missing too (writing Conditional Access policies also needs Policy.Read.All).
  const access = module.check?.backup === "ready" ? module.restoreAccess : undefined
  const commands = access ? restoreAccessCommands(module, tenantId, clientId) : undefined
  const missing = missingPermissions(module)
  return (
    <div className="space-y-2 rounded-2xl bg-gray-50 px-4 py-3 text-sm">
      <p className="font-medium text-gray-900">{access ? "Allow restores" : "Add the missing permissions"}</p>
      <p className="text-gray-600">
        Add {access ? <Permissions requirement={[access.permissions.map((permission) => permission.name)]} /> : missing.length ? <Permissions requirement={missing} /> : "the permissions above"} to this tenant's TenuVault app registration as delegated Microsoft Graph permissions, and grant admin consent. That needs a Global Administrator, Privileged Role Administrator or Cloud Application Administrator.
      </p>
      <div className="flex flex-wrap gap-2">
        {commands ? (
          <Button variant="outline" size="sm" onClick={() => void copy(commands, "the Azure CLI commands")}>
            <Copy className="h-4 w-4" /> Copy Azure CLI commands
          </Button>
        ) : null}
        <a
          href={entraApiPermissionsUrl(clientId)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-full border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-100"
        >
          Open API permissions in Entra <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
      </div>
      <p className="text-xs text-gray-500">
        In Entra: API permissions, Add a permission, Microsoft Graph, Delegated permissions, then Grant admin consent. Then select Check again.
        {access ? <> Setting up a new app registration? Run New-TenuVaultDesktopApp.ps1 with <span className="font-mono">{access.newSetupSwitch}</span>; running it again creates a new app registration instead of changing this one.</> : null}
      </p>
    </div>
  )
}

function ModuleDetail({ module, tenantId, clientId, busy, onToggle }: { module: ServiceModuleStatus; tenantId: string; clientId: string; busy: boolean; onToggle: (enabled: boolean) => void }) {
  const check = module.check
  const gaps = check?.areas.filter((area) => !area.backup || !area.restore) ?? []
  const covered = (check?.areas.length ?? 0) - gaps.length
  return (
    <div className="space-y-3 py-5 first:pt-1 last:pb-1">
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
        {module.optIn ? <Switch checked={module.enabled} disabled={busy} label="Include in backups" onChange={onToggle} /> : null}
      </div>
      <p className="text-sm text-gray-500">{module.description}</p>
      {check ? (
        // While a service is off, what would work is shown dimmed, so the admin knows before turning it on.
        <div className={cn("space-y-3", !module.enabled && "opacity-60")}>
          {!module.enabled ? <p className="text-sm text-gray-600">If you turn it on, this is what the app registration allows today:</p> : null}
          <ul className="space-y-1.5 text-sm">
            {covered > 0 ? (
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" aria-hidden="true" />
                <span className="text-gray-700">
                  {gaps.length ? `${covered} other area${covered === 1 ? "" : "s"}` : `All ${covered} area${covered === 1 ? "" : "s"}`}: backup and restore
                </span>
              </li>
            ) : null}
            {gaps.map((area) => <GapLine key={area.label} area={area} />)}
          </ul>
          {gaps.length ? <FixCallout module={module} tenantId={tenantId} clientId={clientId} /> : null}
          <p className="text-xs text-gray-500">Admin roles: {module.roles}</p>
        </div>
      ) : null}
    </div>
  )
}

const DOT: Record<Readiness, string> = { ready: "bg-green-600", partial: "bg-amber-500", missing: "bg-red-600" }

/** Backup and restore readiness of one service in one tenant, as two labelled dots. */
function Cell({ status, moduleId }: { status: TenantStatus | undefined; moduleId: string }) {
  if (!status || status === "loading") return <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-label="Checking" />
  const module = status.modules.find((candidate) => candidate.id === moduleId)
  if (!module?.check) return <span className="text-xs text-gray-500" title={status.error}>Not checked</span>
  if (!module.enabled) return <span className="text-xs text-gray-500">Off</span>
  const label = `Backup ${READINESS_TEXT[module.check.backup].toLowerCase()}, restore ${READINESS_TEXT[module.check.restore].toLowerCase()}`
  return (
    <span className="flex items-center gap-3 text-xs text-gray-600" aria-label={label} title={label}>
      <span className="flex items-center gap-1"><span className={cn("size-2.5 rounded-full", DOT[module.check.backup])} />Backup</span>
      <span className="flex items-center gap-1"><span className={cn("size-2.5 rounded-full", DOT[module.check.restore])} />Restore</span>
    </span>
  )
}

/** Every tenant's services at a glance, for MSPs; a row opens that tenant's detail below. */
function Overview({ tenants, statuses, selected, onSelect }: { tenants: Array<{ id: number | string; name: string; tenantId: string }>; statuses: Map<string, TenantStatus>; selected: string; onSelect: (tenantId: string) => void }) {
  const modules = [...statuses.values()].find((status): status is ServicesStatus => status !== "loading" && status.modules.length > 0)?.modules ?? []
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th className="px-4 py-2 font-medium">Tenant</th>
            {modules.map((module) => <th key={module.id} className="px-4 py-2 font-medium">{module.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {tenants.map((tenant) => (
            <tr key={tenant.id} className={cn("border-t border-gray-100", tenant.tenantId === selected && "bg-coral-50")}>
              <td className="px-4 py-2">
                <button type="button" className="text-left font-medium text-gray-900 hover:underline" aria-current={tenant.tenantId === selected} onClick={() => onSelect(tenant.tenantId)}>
                  {tenant.name}
                </button>
              </td>
              {modules.map((module) => <td key={module.id} className="px-4 py-2"><Cell status={statuses.get(tenant.tenantId)} moduleId={module.id} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The services each tenant backs up and what its app registration may do with each: read for backups
 * and drift, write for restores. Opt-in services are turned on here per tenant. With several tenants,
 * an overview lists them all. Backup and restore messages link here (#services) when a permission is missing.
 */
export function ServicesSettings() {
  const tenants = useTenants().filter((tenant) => tenant.credentials?.tenantId)
  const rows = tenants.map((tenant) => ({ id: tenant.id, name: tenant.name, tenantId: tenant.credentials!.tenantId, clientId: tenant.credentials!.appId }))
  const key = rows.map((row) => `${row.tenantId}:${row.clientId}`).join(",")
  const [selected, setSelected] = useState(rows[0]?.tenantId ?? "")
  const [statuses, setStatuses] = useState<Map<string, TenantStatus>>(new Map())
  const [busy, setBusy] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const { hash } = useLocation()
  const current = rows.find((row) => row.tenantId === selected) ?? rows[0]

  useEffect(() => {
    if (hash !== "#services") return
    // Settings scrolls to the top when its section changes, after this effect; scroll on the next frame.
    const frame = requestAnimationFrame(() => card.current?.scrollIntoView({ block: "start", behavior: "smooth" }))
    return () => cancelAnimationFrame(frame)
  }, [hash])

  useEffect(() => {
    // Statuses come from tokens TenuVault already holds; a slow answer for an old tenant list is dropped.
    let active = true
    setStatuses(new Map(rows.map((row) => [row.tenantId, "loading" as const])))
    const queue = [...rows]
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const tenant = row
        const status = await bridge.services.status(tenant.tenantId, tenant.clientId).catch((error: unknown): ServicesStatus => ({
          tenantId: tenant.tenantId, modules: [], checkedAt: null, error: error instanceof Error ? error.message : String(error),
        }))
        if (active) setStatuses((previous) => new Map(previous).set(tenant.tenantId, status))
      }
    }
    void Promise.all(Array.from({ length: Math.min(OVERVIEW_CONCURRENCY, rows.length) }, worker))
    return () => { active = false }
    // The tenant list is compared by its IDs, not by array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!current) {
    return (
      <Card>
        <CardContent className="pt-6">Connect and sign in to a tenant to see which services TenuVault can back up and restore.</CardContent>
      </Card>
    )
  }

  const status = statuses.get(current.tenantId)
  const run = async (action: () => Promise<ServicesStatus>) => {
    setBusy(true)
    try {
      const next = await action()
      setStatuses((previous) => new Map(previous).set(next.tenantId, next))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card ref={card} id="services" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>Services and permissions</CardTitle>
        <CardDescription>
          What TenuVault backs up for each tenant, and what the tenant's app registration allows: read permissions for backups and drift, write permissions for restores.
          Read from the sign-in TenuVault already has; nothing is changed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length > 1 ? <Overview tenants={rows} statuses={statuses} selected={current.tenantId} onSelect={setSelected} /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-medium text-gray-900">{current.name}</p>
          <Button variant="outline" size="sm" disabled={busy || status === "loading"} onClick={() => void run(() => bridge.services.status(current.tenantId, current.clientId, true))}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Check again
          </Button>
          {status && status !== "loading" && status.checkedAt ? <span className="text-xs text-gray-500">As of {new Date(status.checkedAt).toLocaleString()}</span> : null}
        </div>
        {status && status !== "loading" && status.error ? <p className="text-sm text-red-700">The permissions could not be checked: {status.error}</p> : null}
        {!status || status === "loading" ? <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Checking permissions...</p> : null}
        {status && status !== "loading" ? (
          <div className="divide-y divide-gray-100">
            {status.modules.map((module) => (
              <ModuleDetail
                key={module.id}
                module={module}
                tenantId={current.tenantId}
                clientId={current.clientId}
                busy={busy}
                onToggle={(enabled) => void run(() => bridge.services.setEnabled(current.tenantId, current.clientId, module.id, enabled))}
              />
            ))}
          </div>
        ) : null}
        <p className="text-xs text-gray-500">
          Roles are checked by Microsoft when you restore.{" "}
          <a href={PERMISSIONS_DOCS} target="_blank" rel="noreferrer" className="underline underline-offset-2">How permissions work</a>
        </p>
      </CardContent>
    </Card>
  )
}
