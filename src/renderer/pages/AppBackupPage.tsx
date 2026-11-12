import { useEffect, useRef, useState } from "react"
import { Link, useParams, useNavigate } from "react-router-dom"
import { ArrowDownToLine, FolderOpen, Package, Plus, RefreshCw, Shield } from "lucide-react"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { cn } from "~/lib/utils"
import { IntuneAppsView } from "../features/app-backup/IntuneAppsView"
import { bridge } from "../lib/bridge"
import type { AppSourceState, RecoveryDeviceStatus } from "../../shared/app-sources/types"

const SAVED = "Installer saved. Back up the installer folder and keep your recovery key separately."
const size = (bytes: number) => new Intl.NumberFormat(undefined, { style: "unit", unit: bytes >= 1024 ** 2 ? "megabyte" : "kilobyte", maximumFractionDigits: 1 }).format(bytes / (bytes >= 1024 ** 2 ? 1024 ** 2 : 1024))
const enrollmentLabels: Record<RecoveryDeviceStatus["enrollment"], string> = { matched: "Matches selected tenant", "different-tenant": "Enrolled in another tenant", "not-enrolled": "No matching enrollment found", unknown: "Could not be confirmed" }
const certificateLabels: Record<RecoveryDeviceStatus["certificate"], string> = { matched: "Matching certificate found", missing: "No matching certificate found", ambiguous: "Multiple matches found", "access-denied": "Windows denied metadata access", unknown: "Could not be confirmed" }

export default function AppBackupPage() {
  const { selectedTenant } = useSelectedTenant()
  const tenant = selectedTenant?.credentials?.tenantId
  useEffect(() => { window.scrollTo(0, 0) }, [tenant])
  // A tenant switch unmounts its operation view. Its cancellation stays bound to the old tenant.
  return <div className="mx-auto max-w-[1600px] space-y-6 p-6 lg:p-8">
    <header><h1 className="text-4xl font-light tracking-tight text-gray-900">Win32 app backup</h1><p className="mt-2 text-sm text-gray-600">Free encrypted installer storage for every configured tenant. {selectedTenant ? `Tenant: ${selectedTenant.name}.` : ""}</p></header>
    {tenant ? <SourceWorkspace key={tenant} tenant={tenant} /> : <div className="rounded-3xl bg-card p-6 text-sm text-gray-600">Select a configured tenant to view or store its installers. <Link to="/portal/tenants" className="ml-2 underline underline-offset-4">Connect a tenant</Link></div>}
  </div>
}

export function SourceWorkspace({ tenant }: { tenant: string }) {
  const { tabId } = useParams()
  const navigate = useNavigate()
  const tab = tabId === "versions" ? "versions" : "apps"
  const [state, setState] = useState<AppSourceState | null>(null)
  const [error, setError] = useState("")
  const [catalogError, setCatalogError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [feedbackSource, setFeedbackSource] = useState<string | null>(null)
  const [platform, setPlatform] = useState<string>("")
  const [kind, setKind] = useState<"save" | "export">("save")
  const [cancelling, setCancelling] = useState(false)
  const [appsVisited, setAppsVisited] = useState(tab === "apps")
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState("")
  const [search, setSearch] = useState("")
  const [device, setDevice] = useState<RecoveryDeviceStatus | null>(null)
  const [deviceBusy, setDeviceBusy] = useState(false)
  const [deviceError, setDeviceError] = useState("")
  const operation = useRef<string | null>(null)
  const listGeneration = useRef(0)
  const alive = useRef(true)
  async function reload() {
    const generation = ++listGeneration.current
    setLoading(true)
    try { const value = await bridge.appSources.list(tenant); if (alive.current && generation === listGeneration.current) { setState(value); setCatalogError("") } }
    catch (e) { if (alive.current && generation === listGeneration.current) { setState(null); setCatalogError(e instanceof Error ? e.message : "The installer folder could not be read.") } }
    finally { if (alive.current && generation === listGeneration.current) setLoading(false) }
  }
  useEffect(() => {
    alive.current = true
    void reload()
    void bridge.app.info().then(info => { if (alive.current) setPlatform(info.platform) }).catch(() => {})
    return () => { alive.current = false; listGeneration.current++; if (operation.current) void bridge.appSources.cancel(tenant, operation.current).catch(() => {}) }
  }, [tenant])
  useEffect(() => { if (tab === "apps") setAppsVisited(true) }, [tab])
  useEffect(() => {
    if (!busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [busy])
  async function run(action: (id: string) => Promise<boolean>, success: string, actionKind: "save" | "export" = "save", sourceId: string | null = null) {
    const id = crypto.randomUUID(); operation.current = id
    setBusy(true); setKind(actionKind); setFeedbackSource(sourceId); setCancelling(false); setError(""); setNotice("")
    const cancelled = actionKind === "save" ? "Save cancelled. No installer was stored." : "Export cancelled. No destination file was published."
    try {
      const done = await action(id)
      if (alive.current) {
        if (done) { setNotice(success); void reload() }
        else setNotice(cancelled)
      }
      return done
    } catch (e) {
      if (alive.current) {
        const message = e instanceof Error ? e.message : "The installer operation failed."
        if (message.endsWith("Source operation cancelled.")) setNotice(cancelled)
        else setError(message)
      }
      return false
    } finally { operation.current = null; if (alive.current) { setBusy(false); setCancelling(false) } }
  }
  async function cancel() {
    if (!operation.current || cancelling) return
    setCancelling(true)
    try { await bridge.appSources.cancel(tenant, operation.current) }
    catch (e) { if (alive.current) { setCancelling(false); setError(e instanceof Error ? e.message : "Cancellation failed. Retry.") } }
  }
  async function reconnect() {
    setError(""); setNotice("")
    try { if (await bridge.appSources.chooseStore(tenant) && alive.current) await reload() }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "The folder could not be connected.") }
  }
  async function checkDevice(signIn = false) {
    setDeviceBusy(true); setDevice(null); setDeviceError("")
    try {
      if (platform !== "win32") return
      if (signIn && !(await bridge.auth.accounts()).some(account => account.tenantId.toLowerCase() === tenant.toLowerCase())) await bridge.appSources.signIn(tenant)
      if (!alive.current) return
      const value = await bridge.appSources.deviceStatus(tenant)
      if (alive.current) setDevice(value)
    } catch (e) { if (alive.current) setDeviceError(e instanceof Error ? e.message : "The device could not be checked.") }
    finally { if (alive.current) setDeviceBusy(false) }
  }
  const sources = (state?.sources ?? []).filter(source => `${source.appName} ${source.fileName}`.toLowerCase().includes(search.toLowerCase()))
  const devicePanel = (
    <section aria-labelledby="device-heading" className="border-l-2 pl-4">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><Shield className="mt-1 size-5 text-gray-600" aria-hidden="true" /><div><h5 id="device-heading" className="text-base font-semibold text-gray-900">Check this PC</h5><p className="mt-1 max-w-3xl text-sm text-gray-600">Check Windows enrollment for the selected tenant. This read-only check does not install the app or confirm installer access.</p></div></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={deviceBusy || platform !== "win32"} onClick={() => void checkDevice(true)}>{deviceBusy ? "Checking…" : "Check Windows enrollment"}</Button></div></div>
      {device ? <div role="status" className="mt-4 space-y-2 rounded-2xl bg-secondary/50 p-4 text-sm text-gray-700"><p>Enrollment: {enrollmentLabels[device.enrollment]}. Certificate: {certificateLabels[device.certificate]}.</p><p>{device.reason}</p></div> : <p className="mt-4 text-sm text-gray-600">{deviceBusy ? "Checking device metadata…" : platform && platform !== "win32" ? "Windows only. Saving and exporting your own files still works on this computer." : "Device not checked."}</p>}
      {deviceError && <p role="alert" className="mt-4 text-sm text-red-800">{deviceError}</p>}
    </section>
  )
  const feedback = <>
    {busy && <div role="status" className="mt-4 space-y-2 rounded-2xl bg-secondary p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3"><span>{kind === "save" ? "Saving installer…" : "Exporting original…"}</span><Button variant="outline" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Cancelling…" : "Cancel operation"}</Button></div>
      <p>Leaving App Backup or changing tenant cancels this operation. You can switch between its two tabs.</p>
    </div>}
    {(error || catalogError) && <div role="alert" className="mt-4 rounded-2xl bg-red-50 p-4 text-sm text-red-900">
      {error && <p>{error}</p>}{catalogError && <p>{catalogError}</p>}
      {(catalogError || state?.unreadableSources) && <p className="mt-2">Reconnect the installer folder and import its matching recovery key in Settings.</p>}
    </div>}
    {notice && <div role="status" className="mt-4 flex items-start justify-between gap-3 rounded-2xl bg-secondary p-4 text-sm text-gray-700"><p>{notice}</p><Button variant="ghost" size="sm" onClick={() => setNotice("")}>Dismiss</Button></div>}
  </>
  return <>
    <nav aria-label="App Backup sections" className="flex flex-wrap gap-2">
      {[{ id: "apps", label: "Intune apps" }, { id: "versions", label: "Saved installers" }].map(item => <Link key={item.id} to={item.id === "apps" ? "/portal/app-backup" : "/portal/app-backup/versions"} aria-current={tab === item.id ? "page" : undefined} className={cn("flex h-10 items-center rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", tab === item.id ? "bg-primary text-primary-foreground" : "bg-card text-gray-700 hover:bg-secondary")}>{item.label}</Link>)}
    </nav>
    {appsVisited && <div hidden={tab !== "apps"} className="space-y-6">{tab === "apps" && kind === "export" && feedback}<IntuneAppsView active={tab === "apps"} tenant={tenant} devicePanel={devicePanel} busy={busy} feedback={tab === "apps" && kind === "save" ? feedback : null} attach={label => { void run(id => bridge.appSources.attach(tenant, id, label), SAVED).then(done => { if (done && alive.current) navigate("/portal/app-backup/versions") }) }} /></div>}
    {tab === "versions" && <section aria-labelledby="stored-sources-heading" className="rounded-3xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 id="stored-sources-heading" className="text-lg font-semibold text-gray-900">Saved installers</h2><p className="mt-1 text-sm text-gray-600">{state ? `${state.sources.length} stored ${state.sources.length === 1 ? "package" : "packages"} · Folder: ${state.storeName}` : "Connect the source folder that holds this tenant's installers."}</p></div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || loading} onClick={() => { setNotice(""); void reload() }}><RefreshCw className="mr-2 size-4" aria-hidden="true" />Refresh</Button><Button variant="outline" disabled={busy} onClick={() => void reconnect()}><FolderOpen className="mr-2 size-4" aria-hidden="true" />Choose installer folder</Button></div>
      </div>
      <details className="mt-5" open={state?.sources.length === 0 || undefined}><summary className="cursor-pointer text-sm font-medium">Save an installer file</summary>
      <form className="mt-6 flex flex-wrap items-end gap-3 rounded-2xl bg-secondary/50 p-4" onSubmit={event => { event.preventDefault(); void run(id => bridge.appSources.attach(tenant, id, name), SAVED) }}>
        <div className="min-w-48 flex-1"><label htmlFor="source-app-name" className="mb-2 block text-sm font-medium text-gray-900">App name <span className="font-normal text-gray-600">(optional label)</span></label><Input id="source-app-name" name="appName" autoComplete="off" maxLength={200} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="For example, Finance desktop app…" /></div>
        <Button type="submit" disabled={busy}><Plus className="mr-2 size-4" aria-hidden="true" />Save installer</Button>
        <p className="basis-full text-xs text-gray-600">Choose an existing .intunewin package, up to 2 GiB. Its container is checked and the original bytes are encrypted in the source folder. Installation behavior is not tested.</p>
      </form></details>
      {(loading || !feedbackSource || !state?.sources.some(source => source.id === feedbackSource)) && feedback}
      {state?.warnings.map(warning => <p role="status" key={warning} className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">{warning}</p>)}
      <p className="mt-4 text-xs text-gray-600">Export needs a destination with hard-link support and preserves existing files.</p>
      <div className="mt-6"><label htmlFor="source-search" className="mb-2 block text-sm font-medium text-gray-900">Search stored packages</label><Input id="source-search" name="sourceSearch" autoComplete="off" disabled={!state || !state.sources.length || busy} value={search} onChange={event => setSearch(event.target.value)} placeholder="App label or file name…" /></div>
      {loading ? <p role="status" className="py-8 text-sm text-gray-600">Reading the source store…</p> : sources.length ? <ul className="mt-4 divide-y">{sources.map(source => <li key={source.id} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 140px" }} className="flex flex-wrap items-start gap-4 py-5">
        <Package className="mt-1 size-5 shrink-0 text-gray-500" aria-hidden="true" /><div className="min-w-0 flex-1 basis-64"><h3 className="break-words font-medium text-gray-900">{source.appName}</h3><p className="mt-1 break-all text-sm text-gray-600">{source.fileName}</p><p className="mt-2 text-xs text-gray-600">Administrator selected · {size(source.bytes)} · {new Date(source.createdAt).toLocaleString()}</p><details className="mt-2 text-xs text-gray-600"><summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">File details</summary><p className="mt-2 break-all font-mono">SHA-256: {source.sha256}</p><p className="mt-1">Stored copy only. Intune content equivalence is unknown.</p></details></div>
        <Button variant="outline" disabled={busy} onClick={() => void run(id => bridge.appSources.export(tenant, id, source.id), "Original package exported.", "export", source.id)}><ArrowDownToLine className="mr-2 size-4" aria-hidden="true" />Export original</Button>
        {feedbackSource === source.id && <div className="min-w-0 basis-full">{feedback}</div>}
      </li>)}</ul> : <p className="py-8 text-sm text-gray-600">{!state ? "The source store is unavailable. Reconnect it and check the matching recovery key." : search ? "No stored packages match your search." : "No saved installers yet. Use Save installer above to keep an original .intunewin file."}</p>}
    </section>}

  </>
}
