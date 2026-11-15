import { useEffect, useId, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, MinusCircle, RefreshCw } from "lucide-react"
import { Link } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { useConfirm } from "~/components/ConfirmDialog"
import { useTenants } from "~/contexts/TenantContext"
import type { AreaHealth, ConnectionHealthReport, ServiceHealth, SignInHealth } from "../../shared/connection-health/model"
import { MODULE_BY_ID, entraApiPermissionsUrl } from "../../shared/services/modules"
import { optionalPermissionStatus, type OptionalPermissionStatus } from "../../shared/services/optional-permissions"
import { HEALTH_CAUSE_TEXT, READER_HEALTH_TEXT, SIGN_IN_HEALTH_TEXT, changeText, healthDate, permissionRemediation, verificationText } from "../lib/connection-health-view"
import { bridge } from "../lib/bridge"
import { settingsHref } from "../lib/settings-section"
import { toast } from "../lib/toast"

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}.`, "success") }
  catch { toast(`Could not copy ${what}.`, "error") }
}

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (enabled: boolean) => void }) {
  return <label data-no-select className="inline-flex shrink-0 items-center gap-2 text-sm text-gray-700">
    <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="peer sr-only" />
    <span aria-hidden="true" className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-disabled:opacity-50 ${checked ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"}`}>
      <span className={`absolute left-0.5 size-4 rounded-full bg-white shadow ${checked ? "translate-x-4" : ""}`} />
    </span>
    {checked ? "On" : "Off"}
  </label>
}

function PermissionState({ state }: { state: ServiceHealth["permissions"] }) {
  return <span className="text-xs text-gray-600">{state === "present" ? "Permissions present" : state === "missing" ? "Permissions missing" : "Permissions not known"}</span>
}

/** These routes change only the exact gaps reported for the selected service or area. */
function PermissionRoutes({ report, missing }: { report: ConnectionHealthReport; missing: readonly string[] }) {
  const fix = permissionRemediation(report, missing)
  if (!fix.names.length) return null
  return <details data-permission-routes data-no-select className="rounded-xl bg-blue-50 p-3 text-sm text-gray-700">
    <summary className="cursor-pointer font-medium text-blue-800">Add the missing permissions ({fix.names.length})</summary>
    <div className="mt-3 space-y-3">
      <p className="break-words">{fix.names.join(", ")}</p>
      <p>Add these as delegated Microsoft Graph permissions and grant admin consent. An administrator must review all pending permissions on the registration before granting consent.</p>
      <details><summary className="cursor-pointer font-medium">Azure CLI commands</summary>
        <p className="mt-2 text-xs">Run in Bash or zsh with Azure CLI installed. These add permissions to this registration; they do not create a new one.</p>
        <pre className="my-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-card p-3 text-xs">{fix.commands}</pre>
        <Button variant="outline" size="sm" onClick={() => void copy(fix.commands, "the Azure CLI commands")}>Copy Azure CLI commands</Button>
      </details>
      <details><summary className="cursor-pointer font-medium">Registration in Entra</summary>
        <p className="my-2 text-xs">API permissions, Add a permission, Microsoft Graph, Delegated permissions. Add exactly the names above, review pending permissions, then grant admin consent.</p>
        <a className="inline-flex items-center gap-1 underline" href={entraApiPermissionsUrl(report.clientId)} target="_blank" rel="noreferrer">Open API permissions in Entra<ExternalLink aria-hidden="true" className="size-3" /></a>
      </details>
      <details><summary className="cursor-pointer font-medium">Text for your administrator</summary>
        <p className="my-2 break-words text-xs">{fix.request}</p>
        <Button variant="outline" size="sm" onClick={() => void copy(fix.request, "the request for your administrator")}>Copy text for administrator</Button>
      </details>
      <p className="border-t border-blue-200 pt-2 text-xs">Add in the app: not available yet.</p>
      <p className="text-xs">Then select Check again and run a backup to verify access.</p>
    </div>
  </details>
}

function Verification({ value }: { value: AreaHealth["verified"] }) {
  return <div className="space-y-1 text-xs text-gray-600">
    <p>{verificationText(value)}</p>
    {value.cause && <p>{HEALTH_CAUSE_TEXT[value.cause]}</p>}
    {value.notVerified.length > 0 && <p className="break-words">Not read: {value.notVerified.join(", ")}.</p>}
  </div>
}

const PERSONAL_DATA: Record<string, string> = {
  groups: "Stores group properties and the object IDs of members and owners. These identify people and their group memberships.",
  usersAndDevices: "Stores user profiles, device properties and organizational contacts. These can include names, email addresses and device identifiers. Passwords and credentials are never stored.",
}

function Area({ area, service, report, busy, run }: { area: AreaHealth; service: ServiceHealth; report: ConnectionHealthReport; busy: boolean; run: (action: () => Promise<ConnectionHealthReport>) => void }) {
  return <div className="space-y-2 border-t border-border py-3" data-area={area.id}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-medium text-gray-900">{area.label} <span className="text-xs font-normal text-gray-500">{area.enabled ? "On" : "Off"}</span></h4>
      {area.optIn && <Switch checked={area.enabled} disabled={busy || !service.enabled} label={`Include ${area.label} in backups`} onChange={enabled => run(() => bridge.services.setArea(report.tenantId, service.id, area.id, enabled))} />}
    </div>
    {area.personalData && <p className="text-xs text-gray-600">{PERSONAL_DATA[area.id] ?? "Stores personal data in backup files. Review who can access your backup storage before turning this area on."}</p>}
    <PermissionState state={area.permissions} />
    {area.enabled ? service.hasTypes ? <Verification value={area.verified} /> : <p className="text-xs text-gray-500">Not verified: this version has no backup types for this area yet.</p> : <p className="text-xs text-gray-500">Not included in backups.</p>}
    {area.losses.map(loss => <p key={`${loss.mode}/${loss.folder}`} className="break-words text-xs text-amber-800">
      {loss.mode === "app-only" ? "Scheduled backups with the Backup Reader cannot read" : "Backups with your sign-in cannot read"} {loss.folder}, since {healthDate(loss.since)}. {HEALTH_CAUSE_TEXT[loss.cause]}
    </p>)}
    {area.enabled && area.missing.length > 0 && <PermissionRoutes report={report} missing={area.missing} />}
  </div>
}

function Service({ service, conditionalAccess, report, busy, toggle, run }: { service: ServiceHealth; conditionalAccess?: ServiceHealth; report: ConnectionHealthReport; busy: boolean; toggle: (service: ServiceHealth, enabled: boolean) => void; run: (action: () => Promise<ConnectionHealthReport>) => void }) {
  const losses = service.areas.flatMap(area => area.losses)
  return <section className="rounded-2xl border border-border p-4" data-service={service.id}>
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-medium text-gray-900">{service.label}</h3>
      {MODULE_BY_ID.get(service.id)?.switchable && <Switch checked={service.enabled} disabled={busy} label={`Include ${service.label} in backups`} onChange={enabled => toggle(service, enabled)} />}
    </div>
    <p className="mt-1 text-xs text-gray-500">{MODULE_BY_ID.get(service.id)?.description}</p>
    <div className="mt-3 space-y-1">
      <PermissionState state={service.permissions} />
      {!service.enabled && <p className="text-sm text-gray-600">Off. New manual and scheduled backups leave out this service.</p>}
      {!service.hasTypes ? <p className="text-sm text-gray-600">This version has no backup types for {service.label} yet. Turning it on saves your choice; it does not back up these areas yet.</p> : service.enabled ? <Verification value={service.verified} /> : null}
      {losses.length > 0 && <p className="text-sm text-amber-800">{losses.some(loss => loss.mode === "app-only") ? "The Backup Reader lost access, even if your sign-in verified a backup." : "Your sign-in lost access."} See the affected areas below.</p>}
      {conditionalAccess && <p className="text-xs text-gray-600">Conditional Access: {conditionalAccess.enabled ? "On" : "Off"}, controlled separately below.</p>}
    </div>
    {service.enabled && service.missing.length > 0 && <div className="mt-3"><PermissionRoutes report={report} missing={service.missing} /></div>}
    <details className="mt-3" data-service-details>
      <summary className="cursor-pointer text-sm font-medium text-gray-700">Areas and access ({service.areas.length}{conditionalAccess ? " + Conditional Access" : ""})</summary>
      <div data-no-select className="my-3 space-y-1 text-xs text-gray-600">
        <label className="flex flex-wrap items-center gap-2">Access to request
          <select aria-label={`${service.label} access to request`} className="rounded-lg border border-border bg-card p-2 text-foreground" disabled={busy} value={service.access} onChange={event => run(() => bridge.services.setAccess(report.tenantId, service.id, event.target.value as "backup" | "restore"))}>
            <option value="backup">Backup</option><option value="restore">Backup and restore</option>
          </select>
        </label>
        <p>This choice names the permissions to request. It grants nothing and does not block a restore your sign-in allows.</p>
      </div>
      {conditionalAccess && <Service service={conditionalAccess} report={report} busy={busy} toggle={toggle} run={run} />}
      {service.areas.map(area => <Area key={area.id} area={area} service={service} report={report} busy={busy} run={run} />)}
    </details>
  </section>
}

function SignInState({ label, state, storage = false }: { label: string; state: SignInHealth; storage?: boolean }) {
  return <div className="min-w-0 rounded-xl bg-muted p-3">
    <h3 className="text-sm font-medium text-gray-900">{label}</h3>
    <p className="mt-1 text-xs text-gray-600">{SIGN_IN_HEALTH_TEXT[state.state]}</p>
    {state.checkedAt && <p className="mt-1 text-xs text-gray-500">Checked {healthDate(state.checkedAt)}</p>}
    {state.code && <p className="mt-1 break-words text-xs text-gray-600">{state.code}{state.link && <>: <a href={state.link} target="_blank" rel="noreferrer" className="underline">Microsoft's description</a></>}</p>}
    {state.state !== "healthy" && state.state !== "local" && <Link className="mt-2 inline-block text-xs font-medium text-blue-700 underline" to={settingsHref(storage ? "storage" : "signin")}>{storage ? "Open storage settings" : "Open sign-in settings"}</Link>}
  </div>
}

/** Each mounted tenant owns every request, error and receipt, so late answers cannot cross tenants. */
function TenantServices({ tenantId, clientId, name, active }: { tenantId: string; clientId: string; name: string; active: boolean }) {
  const [report, setReport] = useState<ConnectionHealthReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const alive = useRef(true)
  const acknowledged = useRef(new Set<string>())
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const run = async (action: () => Promise<ConnectionHealthReport>) => {
    const sent = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      if (!alive.current || sent !== generation.current || next.tenantId.toLowerCase() !== tenantId.toLowerCase() || next.clientId.toLowerCase() !== clientId.toLowerCase()) return
      setReport(next)
      void queryClient.invalidateQueries({ queryKey: ["services-status"] })
    } catch (failure) {
      if (alive.current && sent === generation.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (alive.current && sent === generation.current) setBusy(false)
    }
  }
  useEffect(() => {
    alive.current = true
    void run(() => bridge.health.check(tenantId))
    return () => { alive.current = false; generation.current++ }
  }, [tenantId, clientId])

  useEffect(() => {
    if (!active || !report?.changes.length || !report.acknowledgement || acknowledged.current.has(report.acknowledgement)) return
    const receipt = report.acknowledgement
    const sent = generation.current
    // The change list is expanded in the committed DOM. Wait for a paint before acknowledging it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!alive.current || sent !== generation.current) return
        acknowledged.current.add(receipt)
        // Keep the displayed changes on screen; the answer may already include newer observations.
        void bridge.health.acknowledge(tenantId, receipt).catch(() => { acknowledged.current.delete(receipt) })
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [report, tenantId, active])

  const toggle = async (service: ServiceHealth, enabled: boolean) => {
    if (!enabled && MODULE_BY_ID.get(service.id)?.defaultOn) {
      const ok = await confirm({ title: `Turn off ${service.label}?`, description: `${MODULE_BY_ID.get(service.id)?.description} New manual backups and scheduled backups will stop backing up ${service.label}. Existing backups stay available.`, confirmLabel: `Turn off ${service.label}`, destructive: true })
      if (!ok || !alive.current) return
    }
    await run(async () => { await bridge.services.setEnabled(tenantId, clientId, service.id, enabled); return bridge.health.report(tenantId) })
  }
  return <div className="space-y-4">
    {confirmDialog}
    <div data-no-select className="flex flex-wrap items-center gap-3">
      <h3 className="text-sm font-medium text-gray-900">{name}</h3>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => bridge.health.check(tenantId, true))}><RefreshCw className="size-4" aria-hidden="true" />Check again</Button>
      {report && <span className="text-xs text-gray-500">As of {new Date(report.evaluatedAt).toLocaleString()}</span>}
    </div>
    {busy && <p role="status" className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Checking connection health...</p>}
    {error && <p role="alert" className="text-sm text-red-700">Connection health could not be checked: {error} Select Check again.</p>}
    {report && <>
      <div className="grid gap-2 sm:grid-cols-3">
        <SignInState label="Microsoft Graph sign-in" state={report.graph} />
        <div className="min-w-0 rounded-xl bg-muted p-3"><h3 className="text-sm font-medium text-gray-900">Backup Reader</h3>
          <p className="mt-1 text-xs text-gray-600">{READER_HEALTH_TEXT[report.reader.state]}</p>
          {report.reader.notAfter && <p className="mt-1 text-xs text-gray-500">Certificate expires {healthDate(report.reader.notAfter)}{report.reader.daysLeft !== undefined ? ` (${report.reader.daysLeft} days left)` : ""}.</p>}
          {report.reader.code && <p className="mt-1 text-xs text-gray-600">{report.reader.code}{report.reader.link && <>: <a className="underline" href={report.reader.link} target="_blank" rel="noreferrer">Microsoft's description</a></>}</p>}
          {report.reader.roleChange && <p className="mt-1 break-words text-xs text-gray-600">Added: {report.reader.roleChange.added.join(", ") || "none"}. Removed: {report.reader.roleChange.removed.join(", ") || "none"}.</p>}
          <Link className="mt-2 inline-block text-xs font-medium text-blue-700 underline" to={settingsHref("background")}>Open Backup Reader settings</Link>
        </div>
        <SignInState label="Backup storage" state={report.storage} storage />
      </div>
      {report.changes.length > 0 && <section aria-label="Changes since the last check" className="space-y-2 rounded-xl bg-blue-50 p-4 text-sm text-gray-700">
        <h3 className="font-medium text-blue-800">Changes since the last check</h3>
        <ul className="list-disc space-y-2 pl-4">{report.changes.map((change, index) => <li key={index} className="break-words">{changeText(change, report.since)}</li>)}</ul>
      </section>}
      {report.services.filter(service => service.id !== "conditionalAccess").map(service => <Service key={service.id} service={service} conditionalAccess={service.id === "entra" ? report.services.find(entry => entry.id === "conditionalAccess") : undefined} report={report} busy={busy} toggle={(service, enabled) => void toggle(service, enabled)} run={action => void run(action)} />)}
      <OptionalPermissions entries={optionalPermissionStatus(report.granted ? { kind: "delegated", permissions: new Set(report.granted) } : undefined)} clientId={clientId} checking={busy} />
    </>}
  </div>
}

export function ServicesSettings({ active = true }: { active?: boolean }) {
  const tenants = useTenants().filter(tenant => tenant.credentials?.tenantId)
  const [selected, setSelected] = useState(tenants[0]?.credentials?.tenantId ?? "")
  const id = useId()
  const current = tenants.find(tenant => tenant.credentials?.tenantId === selected) ?? tenants[0]
  return <Card id="services">
    <CardHeader><CardTitle>Services and permissions</CardTitle><CardDescription>Choose what each tenant backs up. Permissions come from a token check; a backup verifies what can actually be read. Health checks never open a sign-in window or block a backup.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {tenants.length > 1 && <label data-no-select htmlFor={id} className="flex items-center gap-3 text-sm text-gray-700">Tenant<select id={id} value={current?.credentials?.tenantId} onChange={event => setSelected(event.target.value)} className="rounded-lg border border-border bg-card p-2 text-foreground">{tenants.map(tenant => <option key={tenant.id} value={tenant.credentials!.tenantId}>{tenant.name}</option>)}</select></label>}
      {current ? <TenantServices key={`${current.credentials!.tenantId}/${current.credentials!.appId}`} tenantId={current.credentials!.tenantId} clientId={current.credentials!.appId} name={current.name} active={active} /> : <p className="text-sm text-gray-600">Connect and sign in to a tenant to see its services and permissions.</p>}
    </CardContent>
  </Card>
}
/**
 * Delegated permissions the setup script only adds on request. Each one turns on a single
 * feature; without it that feature fails while the rest keeps working.
 */
function OptionalPermissions({ entries, clientId, checking }: { entries: OptionalPermissionStatus[]; clientId: string; checking: boolean }) {
  return (
    <section aria-labelledby="optional-permissions-heading" className="space-y-2 border-t border-gray-100 pt-4 dark:border-gray-800">
      <h3 id="optional-permissions-heading" className="text-sm font-medium text-gray-900">Optional permissions</h3>
      {/* The text switches to "Checking" while Check again runs, so every finished check is announced, also when the result is unchanged. */}
      <p role="status" aria-live="polite" className="sr-only">
        {checking ? "Checking optional permissions." : entries.some((entry) => entry.granted === null) ? "Optional permissions could not be checked." : `${entries.filter((entry) => entry.granted).length} of ${entries.length} optional permissions granted.`}
      </p>
      <p className="text-xs text-gray-500">
        Added only when you ask for them. A new app registration gets them with the setup switch shown; for this one, add the delegated permission in Entra and grant admin consent, then check again.
      </p>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
            {entry.granted === true ? <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" /> : entry.granted === false ? <MinusCircle className="h-4 w-4 text-gray-400" aria-hidden="true" /> : <AlertCircle className="h-4 w-4 text-gray-400" aria-hidden="true" />}
            <span className="font-medium text-gray-900">{entry.label}</span>
            <span className="font-mono text-xs text-gray-600">{entry.permissions.join(", ")}</span>
            <span className="text-xs text-gray-500">{entry.granted === true ? "Granted" : entry.granted === false ? `Not granted: ${entry.missing.join(", ")}` : "Could not be checked"}</span>
            {entry.granted === false && (
              <span className="ml-auto flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span>New app registration: <span className="font-mono">{entry.setupSwitch}</span></span>
                <a href={entraApiPermissionsUrl(clientId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">Open in Entra<ExternalLink className="h-3 w-3" aria-hidden="true" /></a>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
