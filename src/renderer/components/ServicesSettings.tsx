import { privilegedRestoreEnabled } from "../../shared/intune/directory-review-folders"
import { NoticeCard, noticeActionClass } from "./NoticeCard"
import { BackupCoverage } from "./BackupCoverage"
import { backupAreaCoverage, needsBackupAccess } from "../../shared/services/backup-coverage"
import { needsAccessText, StartNowAccessHelp } from "./BackupAccessHelp"
import { TENUVAULT_CLIENT_ID } from "../../shared/tenant-connection"
import { servicesStatusKey } from "../features/notifications/optional-permissions"
import { ApplicationRestoreDisclosure } from "./ApplicationRestoreDisclosure"
import { AddPermissions } from "./AddPermissions"
import { useEffect, useId, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, MinusCircle, RefreshCw } from "lucide-react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { useConfirm } from "~/components/ConfirmDialog"
import { useTenants } from "~/contexts/TenantContext"
import type { ServicesStatus } from "../../shared/ipc"
import type { AreaHealth, ConnectionHealthReport, ServiceHealth, SignInHealth } from "../../shared/connection-health/model"
import { PERSONAL_DATA } from "../../shared/services/onboarding"
import { graphCliCoverage } from "../../shared/services/graph-cli-coverage"
import { BACKUP_SERVICES } from "../../shared/services/presentation"
import { MODULE_BY_ID, entraApiPermissionsUrl } from "../../shared/services/modules"
import { optionalPermissionStatus, type OptionalPermissionStatus } from "../../shared/services/optional-permissions"
import { HEALTH_CAUSE_TEXT, READER_HEALTH_TEXT, SIGN_IN_HEALTH_TEXT, STORAGE_HEALTH_TEXT, changeText, healthDate, permissionRemediation, verificationText } from "../lib/connection-health-view"
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
export function PermissionRoutes({ report, missing, inApp = false, restoring = false, compact = false }: { compact?: boolean; inApp?: boolean; restoring?: boolean; report: Pick<ConnectionHealthReport, "tenantId" | "clientId">; missing: readonly string[] }) {
  const fix = permissionRemediation(report, missing)
  if (!fix.names.length) return null
  if (report.clientId.toLowerCase() === TENUVAULT_CLIENT_ID) return (
    <Link className="block text-sm text-blue-800 underline" to={settingsHref("signin")}>Review TenuVault app permission packs</Link>
  )
  return <div data-permission-routes>
    <NoticeCard summary={compact ? "Review missing permissions." : `Needs ${fix.names.length} more ${fix.names.length === 1 ? "permission" : "permissions"}.`}
      details={<div className="space-y-3">
      <p className="break-words">{fix.names.join(", ")}</p>
      <p>Add these as delegated Microsoft Graph permissions. The CLI grants tenant-wide consent for only these scopes, preserves existing tenant-wide scopes and stops if individual consent needs separate review. Other pending permissions are not consented.</p>
      <details><summary className="cursor-pointer font-medium">Azure CLI commands</summary>
        <p className="mt-2 text-xs">Run in Bash or zsh with Azure CLI installed. Sign in as an Application Administrator. Azure CLI needs delegated DelegatedPermissionGrant.ReadWrite.All access or a documented higher permission. These commands add permissions to this registration, update existing tenant-wide consent in place, or create consent only if none exists. They never delete grants. An earlier permission declaration can remain saved if a later step fails.</p>
        <pre className="my-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-card p-3 text-xs">{fix.commands}</pre>
        <Button variant="outline" size="sm" onClick={() => void copy(fix.commands, "the Azure CLI commands")}>Copy Azure CLI commands</Button>
      </details>
      <details><summary className="cursor-pointer font-medium">Registration in Entra</summary>
        <p className="my-2 text-xs">API permissions, Add a permission, Microsoft Graph, Delegated permissions. Add exactly the names above. Use the CLI route to consent only these scopes. The portal’s Grant admin consent action also consents other pending permissions; review those with your administrator first.</p>
        <a className="inline-flex items-center gap-1 underline" href={entraApiPermissionsUrl(report.clientId, report.tenantId)} target="_blank" rel="noreferrer">Open API permissions in Entra<ExternalLink aria-hidden="true" className="size-3" /></a>
      </details>
      <details><summary className="cursor-pointer font-medium">Text for your administrator</summary>
        <p className="my-2 break-words text-xs">{fix.request}</p>
        <Button variant="outline" size="sm" onClick={() => void copy(fix.request, "the request for your administrator")}>Copy text for administrator</Button>
      </details>
      {inApp && <AddPermissions tenantId={report.tenantId} clientId={report.clientId} missing={fix.names} />}
      <p className="text-xs">{restoring ? "Then select Check again to verify restore access." : "Then select Check again and run a backup to verify access."}</p>
      </div>} />
  </div>
}

function causeText(cause: keyof typeof HEALTH_CAUSE_TEXT, readOnly?: boolean): string {
  return readOnly && cause === "permission" ? "Start now lacks a required permission. Change sign-in method for more coverage." : HEALTH_CAUSE_TEXT[cause]
}

function Verification({ value, readOnly }: { value: AreaHealth["verified"]; readOnly?: boolean }) {
  return <div className="space-y-1 text-xs text-gray-600">
    <p>{verificationText(value)}</p>
    {value.cause && <p>{causeText(value.cause, readOnly)}</p>}
  </div>
}


function deferredEntraArea(service: ServiceHealth, area: AreaHealth) {
  return !privilegedRestoreEnabled && service.id === "entra" && ["applications", "roles"].includes(area.id)
}

function Area({ area, service, report, busy, run }: { area: AreaHealth; service: ServiceHealth; report: ConnectionHealthReport; busy: boolean; run: (action: () => Promise<ConnectionHealthReport>) => void }) {
  const deferred = deferredEntraArea(service, area)
  return <div className="space-y-2 border-t border-border py-3" data-area={area.id}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-medium text-gray-900">{area.label} <span className="text-xs font-normal text-gray-500">{area.enabled ? "On" : "Off"}</span></h4>
      {area.optIn && area.hasTypes && <Switch checked={area.enabled} disabled={busy || !service.enabled} label={`Include ${area.label} in backups`} onChange={enabled => run(() => bridge.services.setArea(report.tenantId, service.id, area.id, enabled))} />}
    </div>
    {service.id === "entra" && area.id === "externalIdentities" && area.hasTypes && <p className="text-xs text-gray-600">API connectors require the Backup Reader. Their delegated read permission has not been verified.</p>}
    {service.id === "entra" && area.id === "governance" && area.hasTypes && <p className="text-xs text-gray-600">Access packages, review definitions, lifecycle workflows and terms of use. Some features need Entra ID P2 or ID Governance. PDFs, review decisions and workflow history are excluded.</p>}
    {privilegedRestoreEnabled && service.id === "entra" && area.id === "applications" && <ApplicationRestoreDisclosure />}
    {area.personalData && <p className="text-xs text-gray-600">{PERSONAL_DATA[area.id] ?? "Stores personal data in backup files. Review who can access your backup storage before turning this area on."}</p>}
    <p className="text-xs text-gray-600">Backup: <PermissionState state={area.permissions} />. Restore: {deferred ? "Available in a later version" : report.readOnly ? "Unavailable with Start now" : <PermissionState state={area.restore} />}.</p>
    {!deferred && !report.readOnly && area.enabled && area.permissions === "present" && area.restore === "missing" && service.access === "restore" && <p className="text-xs text-gray-600">Backup permissions are present. Restore needs: {area.missing.join(", ")}. The Backup and restore access level asks for these permissions. Choose Backup under Areas and access to request only backup permissions.</p>}
    {!area.hasTypes ? <p className="text-xs text-gray-500">Not verified: this version has no backup types for this area yet.</p> : area.enabled ? <Verification value={area.verified} readOnly={report.readOnly} /> : <p className="text-xs text-gray-500">Not included in backups.</p>}
    {area.losses.length > 0 && <NoticeCard summary={`Backup access was lost for ${new Set(area.losses.map(loss => loss.folder)).size} types.`}
      details={<ul className="space-y-1">{area.losses.map(loss => <li key={`${loss.mode}/${loss.folder}`}>
        {loss.mode === "app-only" ? "Scheduled backups with the Backup Reader cannot read" : "Backups with your sign-in cannot read"} {loss.folder}, since {healthDate(loss.since)}. {causeText(loss.cause, report.readOnly && loss.mode === "delegated")}
      </li>)}</ul>} />}
    {!report.readOnly && area.enabled && area.missing.length > 0 && <PermissionRoutes inApp report={report} missing={area.missing} />}
  </div>
}

function Service({ service, conditionalAccess, report, busy, toggle, run }: { service: ServiceHealth; conditionalAccess?: ServiceHealth; report: ConnectionHealthReport; busy: boolean; toggle: (service: ServiceHealth, enabled: boolean) => void; run: (action: () => Promise<ConnectionHealthReport>) => void }) {
  const label = service.id === "conditionalAccess" ? "Conditional Access" : service.label
  const losses = service.areas.flatMap(area => area.losses)
  const included = service.areas.filter(area => area.enabled && !deferredEntraArea(service, area))
  const restore = !included.length ? "unknown" : included.every(area => area.restore === "present") ? "present" : included.some(area => area.restore === "missing") ? "missing" : "unknown"
  const coverage = report.coverage?.find(row => row.service === service.id)
  const signInNeedsAccess = needsBackupAccess(coverage) && (service.enabled || conditionalAccess?.enabled)
  const readerOnly = signInNeedsAccess && coverage && report.readerReadableServices?.includes(coverage.service)
  const needsAccess = signInNeedsAccess && !readerOnly
  const signInSettings = settingsHref("signin", `sign-in-${report.tenantId}`)
  return <section id={`service-${service.id}`} className="scroll-mt-4 rounded-2xl border border-border p-4" data-service={service.id}>
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-gray-900">{label}</h3>
        {needsAccess && <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-gray-700">Needs access</span>}
      </div>
      {MODULE_BY_ID.get(service.id)?.switchable && <Switch checked={service.enabled} disabled={busy} label={`Include ${label} in backups`} onChange={enabled => toggle(service, enabled)} />}
    </div>
    {readerOnly && <NoticeCard className="mt-3" summary="Only the Backup Reader can back up this service."
      details="Scheduled backups can read this service with the Backup Reader. Your sign-in can't read it." />}
    {needsAccess && coverage && <NoticeCard className="mt-3" summary={needsAccessText([label])}
      action={(report.readOnly || report.clientId.toLowerCase() === TENUVAULT_CLIENT_ID) &&
        <Link className={noticeActionClass} to={signInSettings}>Review sign-in options</Link>}
      details={<>
        <p>Your choice is saved. Backups skip this service until it can be read.</p>
        {report.readOnly ? <StartNowAccessHelp /> : <p>Ask a Microsoft administrator to approve backup access.</p>}
        <p className="font-medium">Areas needing access</p>
        <ul className="list-disc pl-4">{backupAreaCoverage(coverage).missing.map(area => <li key={area}>{area}</li>)}</ul>
      </>} />}
    <p className="mt-1 text-xs text-gray-500">{MODULE_BY_ID.get(service.id)?.description}</p>
    {service.id === "defender" && <p className="mt-2 text-xs text-gray-600">Backs up 17 Microsoft Graph configuration types, including tenant attack simulation content. Anti-phishing, Safe Links, Safe Attachments, anti-spam, anti-malware and quarantine policies, the Tenant Allow/Block List and Defender for Endpoint settings are not covered. Restore is not available yet.</p>}
    <div className="mt-3 space-y-1">
      <p className="text-xs text-gray-600">Backup: <PermissionState state={service.permissions} />. Restore: {report.readOnly ? "Unavailable with Start now" : <PermissionState state={restore} />}.</p>
      {!report.readOnly && service.enabled && service.permissions === "present" && service.access === "restore" && service.missing.length > 0 && <p className="text-sm text-gray-600">Backup permissions are present. Restore needs: {service.missing.join(", ")}. The Backup and restore access level asks for these permissions. Choose Backup under Areas and access to request only backup permissions.</p>}
      {!service.enabled && <p className="text-sm text-gray-600">Off. New manual and scheduled backups leave out this service.</p>}
      {!service.hasTypes ? <p className="text-sm text-gray-600">This version has no backup types for {service.label} yet. Turning it on saves your choice; it does not back up these areas yet.</p> : service.enabled ? <Verification value={service.verified} readOnly={report.readOnly} /> : null}
      {losses.length > 0 && <p className="text-sm text-amber-800">{losses.some(loss => loss.mode === "app-only") ? "The Backup Reader lost access, even if your sign-in verified a backup." : "Your sign-in lost access."} See the affected areas below.</p>}
      {conditionalAccess && <p className="text-xs text-gray-600">Conditional Access: {conditionalAccess.enabled ? "On" : "Off"}, managed under Areas and access.</p>}
    </div>
    {!report.readOnly && service.enabled && service.missing.length > 0 && <div className="mt-3"><PermissionRoutes inApp report={report} missing={service.missing} /></div>}
    <details className="mt-3" data-service-details>
      <summary className="cursor-pointer text-sm font-medium text-gray-700">Areas and access ({service.areas.length}{conditionalAccess ? " + Conditional Access" : ""})</summary>
      {!report.readOnly && <div data-no-select className="my-3 space-y-1 text-xs text-gray-600">
        <label className="flex flex-wrap items-center gap-2">Access to request
          <select aria-label={`${label} access to request`} className="rounded-lg border border-border bg-card p-2 text-foreground" disabled={busy} value={service.access} onChange={event => run(() => bridge.services.setAccess(report.tenantId, service.id, event.target.value as "backup" | "restore"))}>
            <option value="backup">Backup</option><option value="restore">Backup and restore</option>
          </select>
        </label>
        <p>This choice names the permissions to request. It grants nothing and does not block a restore your sign-in allows.</p>
        {!privilegedRestoreEnabled && service.id === "entra" && <p>Restore for app registrations, enterprise apps, directory roles, PIM and administrative units comes in a later version.</p>}
      </div>}
      {conditionalAccess && <Service service={conditionalAccess} report={report} busy={busy} toggle={toggle} run={run} />}
      {service.areas.map(area => <Area key={area.id} area={area} service={service} report={report} busy={busy} run={run} />)}
    </details>
  </section>
}

function SignInState({ label, state, storage = false, readOnly }: { label: string; state: SignInHealth; storage?: boolean; readOnly?: boolean }) {
  const needsDifferentMethod = readOnly && ["consentMissing", "registrationNotFoundInTenant", "servicePrincipalMissing"].includes(state.state)
  return <div className="min-w-0 rounded-xl bg-muted p-3">
    <h3 className="text-sm font-medium text-gray-900">{label}</h3>
    <p className="mt-1 text-xs text-gray-600">{needsDifferentMethod ? "Start now is unavailable in this tenant. Change sign-in method to continue." : (storage ? STORAGE_HEALTH_TEXT : SIGN_IN_HEALTH_TEXT)[state.state]}</p>
    {state.checkedAt && <p className="mt-1 text-xs text-gray-500">Checked {healthDate(state.checkedAt)}</p>}
    {state.code && <p className="mt-1 break-words text-xs text-gray-600">{state.code}{state.link && <>: <a href={state.link} target="_blank" rel="noreferrer" className="underline">Microsoft's description</a></>}</p>}
    {state.state !== "healthy" && state.state !== "local" && <Link className="mt-2 inline-block text-xs font-medium text-blue-700 underline" to={settingsHref(storage ? "storage" : "signin")}>{storage ? "Open storage settings" : "Open sign-in settings"}</Link>}
  </div>
}

/** Each mounted tenant owns every request, error and receipt, so late answers cannot cross tenants. */
function TenantServices({ tenantId, clientId, name, active }: { tenantId: string; clientId: string; name: string; active: boolean }) {
  const { hash } = useLocation()
  const [report, setReport] = useState<ConnectionHealthReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const alive = useRef(true)
  const acknowledged = useRef(new Set<string>())
  const queryClient = useQueryClient()
  const statusKey = servicesStatusKey(tenantId, clientId)
  const { confirm, confirmDialog } = useConfirm()
  const run = async (action: () => Promise<ConnectionHealthReport>, refresh = false) => {
    const sent = ++generation.current
    setBusy(true)
    setError(null)
    try {
      if (refresh) await queryClient.cancelQueries({ queryKey: statusKey, exact: true })
      const next = await action()
      if (!alive.current || sent !== generation.current || next.tenantId.toLowerCase() !== tenantId.toLowerCase() || next.clientId.toLowerCase() !== clientId.toLowerCase()) return
      setReport(next)
      const optional = optionalPermissionStatus(next.granted ? { kind: "delegated", permissions: new Set(next.granted) } : undefined)
      const cached = queryClient.setQueryData<ServicesStatus>(statusKey, previous => previous ? { ...previous, optional } : previous)
      if (!cached && next.granted) void queryClient.invalidateQueries({ queryKey: statusKey, exact: true })
    } catch (failure) {
      if (alive.current && sent === generation.current) {
        if (refresh) {
          setReport(previous => previous ? { ...previous, granted: null } : previous)
          queryClient.setQueryData<ServicesStatus>(statusKey, cached => cached ? { ...cached, optional: optionalPermissionStatus(undefined) } : cached)
        }
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (alive.current && sent === generation.current) setBusy(false)
    }
  }
  useEffect(() => {
    alive.current = true
    // Hidden Settings panels stay mounted. Discard old account evidence before each activation.
    setReport(null)
    if (active) void run(() => bridge.health.check(tenantId))
    const unsubscribe = bridge.auth?.onAccountsChanged?.(changed => {
      if (active && changed.toLowerCase() === tenantId.toLowerCase()) {
        setReport(null)
        void run(() => bridge.health.check(tenantId))
      }
    })
    return () => { alive.current = false; generation.current++; unsubscribe?.() }
  }, [tenantId, clientId, active])

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

  const hasReport = Boolean(report)
  useEffect(() => {
    if (!active || !hasReport || !BACKUP_SERVICES.some(service => hash === `#service-${service.id}`)) return
    const frame = requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "nearest" }))
    return () => cancelAnimationFrame(frame)
  }, [active, hasReport, hash])

  const toggle = async (service: ServiceHealth, enabled: boolean) => {
    const sent = generation.current
    let confirmed = false
    if (!enabled && MODULE_BY_ID.get(service.id)?.defaultOn) {
      const ok = await confirm({ title: `Turn off ${service.label}?`, description: `${MODULE_BY_ID.get(service.id)?.description} New manual backups and scheduled backups will stop backing up ${service.label}. Existing backups stay available.`, confirmLabel: `Turn off ${service.label}`, destructive: true })
      if (!ok || !alive.current || sent !== generation.current) return
      confirmed = true
    }
    await run(async () => { await bridge.services.setEnabled(tenantId, clientId, service.id, enabled, confirmed ? { confirmed: true } : undefined); return bridge.health.report(tenantId) })
  }
  return <div className="space-y-4">
    {confirmDialog}
    <div data-no-select className="flex flex-wrap items-center gap-3">
      <h3 className="text-sm font-medium text-gray-900">{name}</h3>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => bridge.health.check(tenantId, true), true)}><RefreshCw className="size-4" aria-hidden="true" />Check again</Button>
      {report && <span className="text-xs text-gray-500">As of {new Date(report.evaluatedAt).toLocaleString()}</span>}
    </div>
    {busy && <p role="status" className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Checking connection health...</p>}
    {error && <p role="alert" className="text-sm text-red-700">Connection health could not be checked: {error} Select Check again.</p>}
    {report && active && <>
      {report.readOnly && <section className="space-y-2" aria-label="Start now backup coverage">
        <h3 className="text-sm font-medium">Backup coverage from granted scopes</h3>
        <BackupCoverage coverage={graphCliCoverage(report.granted ? new Set(report.granted) : undefined)} />
        <p className="text-xs text-gray-600">Your Microsoft role and service licenses can limit what a backup reads.</p>
      </section>}
      <div className="grid gap-2 sm:grid-cols-3">
        <SignInState label="Microsoft Graph sign-in" state={report.graph} readOnly={report.readOnly} />
        <div className="min-w-0 rounded-xl bg-muted p-3"><h3 className="text-sm font-medium text-gray-900">Backup Reader</h3>
          {report.readOnly ? <p className="mt-1 text-xs text-gray-600">Scheduled backups use your Start now sign-in. To use a Backup Reader, change the sign-in method.</p> : <>
            <p className="mt-1 text-xs text-gray-600">{READER_HEALTH_TEXT[report.reader.state]}</p>
            {report.reader.notAfter && <p className="mt-1 text-xs text-gray-500">Certificate expires {healthDate(report.reader.notAfter)}{report.reader.daysLeft !== undefined ? ` (${report.reader.daysLeft} days left)` : ""}.</p>}
            {report.reader.code && <p className="mt-1 text-xs text-gray-600">{report.reader.code}{report.reader.link && <>: <a className="underline" href={report.reader.link} target="_blank" rel="noreferrer">Microsoft's description</a></>}</p>}
            {report.reader.roleChange && <p className="mt-1 break-words text-xs text-gray-600">Added: {report.reader.roleChange.added.join(", ") || "none"}. Removed: {report.reader.roleChange.removed.join(", ") || "none"}.</p>}
            <Link className="mt-2 inline-block text-xs font-medium text-blue-700 underline" to={settingsHref("background")}>Open Backup Reader settings</Link>
          </>}
        </div>
        <SignInState label="Backup storage" state={report.storage} storage />
      </div>
      {report.changes.length > 0 && <NoticeCard
        summary={`Connection health found ${report.changes.length} ${report.changes.length === 1 ? "change" : "changes"}.`}
        details={<ul className="list-disc space-y-2 pl-4">{report.changes.map((change, index) => <li key={index}>{changeText(change, report.since)}</li>)}</ul>} />}
      {BACKUP_SERVICES.map(({ id }) => {
        const service = report.services.find(entry => entry.id === id)
        return service && <Service key={service.id} service={service} conditionalAccess={service.id === "entra" ? report.services.find(entry => entry.id === "conditionalAccess") : undefined} report={report} busy={busy} toggle={(service, enabled) => void toggle(service, enabled)} run={action => void run(action)} />
      })}
      {!report.readOnly && <OptionalPermissions tenantId={tenantId} entries={optionalPermissionStatus(report.granted ? { kind: "delegated", permissions: new Set(report.granted) } : undefined)} clientId={clientId} checking={busy} />}
    </>}
  </div>
}

export function ServicesSettings({ active = true }: { active?: boolean }) {
  const tenants = useTenants().filter(tenant => tenant.credentials?.tenantId)
  const [params] = useSearchParams()
  const requestedTenant = params.get("tenant")
  const [selected, setSelected] = useState(requestedTenant ?? tenants[0]?.credentials?.tenantId ?? "")
  useEffect(() => { if (requestedTenant) setSelected(requestedTenant) }, [requestedTenant])
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
 * Delegated permissions used by specific features.
 */
function OptionalPermissions({ entries, clientId, tenantId, checking }: { entries: OptionalPermissionStatus[]; clientId: string; tenantId: string; checking: boolean }) {
  const shared = clientId.toLowerCase() === TENUVAULT_CLIENT_ID
  const displayed = shared ? entries.filter(entry => entry.id === "conditionalAccessWatching" || entry.id === "groupRead") : entries
  return (
    <section aria-labelledby="optional-permissions-heading" className="space-y-2 border-t border-gray-100 pt-4 dark:border-gray-800">
      <h3 id="optional-permissions-heading" className="text-sm font-medium text-gray-900">Feature permissions</h3>
      {/* The text switches to "Checking" while Check again runs, so every finished check is announced, also when the result is unchanged. */}
      <p role="status" aria-live="polite" className="sr-only">
        {checking ? "Checking feature permissions." : displayed.some((entry) => entry.granted === null) ? "Feature permissions could not be checked." : `${displayed.filter((entry) => entry.granted).length} of ${displayed.length} feature permissions granted.`}
      </p>
      {shared ? (
        <p className="text-xs text-gray-500">The Intune packs include group read. Turn on Conditional Access change watching to include the audit log pack. <Link className="font-medium text-blue-800 underline" to={settingsHref("signin")}>Review TenuVault app permission packs</Link></p>
      ) : <p className="text-xs text-gray-500">
        For feature permissions with a setup switch, use that switch when creating a new app registration. You can also add the delegated permission in Entra, grant admin consent, then check again.
        {" "}<span className="font-mono">-IncludeNotifications</span> adds <span className="font-mono">Mail.Send</span> and <span className="font-mono">User.Read.All</span>.
      </p>}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {displayed.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
            {entry.granted === true ? <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" /> : entry.granted === false ? <MinusCircle className="h-4 w-4 text-gray-400" aria-hidden="true" /> : <AlertCircle className="h-4 w-4 text-gray-400" aria-hidden="true" />}
            <span className="font-medium text-gray-900">{entry.label}</span>
            <span className="font-mono text-xs text-gray-600">{entry.permissions.join(", ")}</span>
            <span className="text-xs text-gray-500">{entry.granted === true ? "Granted" : entry.granted === false ? `Not granted: ${entry.missing.join(", ")}` : "Could not be checked"}</span>
            {entry.id === "groupRecipients" && <span className="text-xs text-gray-500">Also needs Group read.</span>}
            {!shared && entry.id === "groupRead" && <span className="basis-full text-xs text-gray-500">Included in new app registrations. For an older registration, add the delegated GroupMember.Read.All permission in Entra and grant admin consent, then select Check again.</span>}
            {!shared && entry.granted === false && (
              <span className="ml-auto flex flex-wrap items-center gap-2 text-xs text-gray-500">
                {entry.setupSwitch && <span>New app registration: <span className="font-mono">{entry.setupSwitch}</span></span>}
                <a href={entraApiPermissionsUrl(clientId, tenantId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">Open in Entra<ExternalLink className="h-3 w-3" aria-hidden="true" /></a>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
