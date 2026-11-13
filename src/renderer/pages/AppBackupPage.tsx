import { useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowDownToLine, FolderOpen, Package, RefreshCw, Shield } from "lucide-react"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { cn } from "~/lib/utils"
import { IntuneAppsView } from "../features/app-backup/IntuneAppsView"
import { bridge } from "../lib/bridge"
import type { AppCaptureProgress, AppSourceState, RecoveryDeviceStatus } from "../../shared/app-sources/types"

const size = (bytes: number) => new Intl.NumberFormat(undefined, { style: "unit", unit: bytes >= 1024 ** 2 ? "megabyte" : "kilobyte", maximumFractionDigits: 1 }).format(bytes / (bytes >= 1024 ** 2 ? 1024 ** 2 : 1024))
const enrollmentLabels: Record<RecoveryDeviceStatus["enrollment"], string> = { matched: "Matches selected tenant", "different-tenant": "Enrolled in another tenant", "not-enrolled": "No matching enrollment found", unknown: "Could not be confirmed" }
const certificateLabels: Record<RecoveryDeviceStatus["certificate"], string> = { matched: "Matching certificate found", missing: "No matching certificate found", ambiguous: "Multiple matches found", "access-denied": "Windows denied metadata access", unknown: "Could not be confirmed" }

export default function AppBackupPage() {
  const { selectedTenant } = useSelectedTenant()
  const tenant = selectedTenant?.credentials?.tenantId
  useEffect(() => { window.scrollTo(0, 0) }, [tenant])
  // A tenant switch unmounts its operation view. Its cancellation stays bound to the old tenant.
  return <div className="mx-auto max-w-[1600px] space-y-6 p-6 lg:p-8">
    <header><h1 className="text-4xl font-light tracking-tight text-gray-900">App Backup</h1><p className="mt-2 text-sm text-gray-600">Installer backups from Intune. Completely free for every configured tenant. {selectedTenant ? `Tenant: ${selectedTenant.name}.` : ""}</p></header>
    {tenant ? <SourceWorkspace key={tenant} tenant={tenant} /> : <div className="rounded-3xl bg-card p-6 text-sm text-gray-600">Select a configured tenant to view or store its installers. <Link to="/portal/tenants" className="ml-2 underline underline-offset-4">Connect a tenant</Link></div>}
  </div>
}

export function SourceWorkspace({ tenant }: { tenant: string }) {
  const { tabId } = useParams()
  const tab = tabId === "versions" ? "versions" : "apps"
  const [state, setState] = useState<AppSourceState | null>(null)
  const [error, setError] = useState("")
  const [catalogError, setCatalogError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [progress, setProgress] = useState<AppCaptureProgress | null>(null)
  const [feedbackSource, setFeedbackSource] = useState<string | null>(null)
  const [platform, setPlatform] = useState<string>("")
  const [cancelling, setCancelling] = useState(false)
  const [appsVisited, setAppsVisited] = useState(tab === "apps")
  const [loading, setLoading] = useState(true)
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
  useEffect(() => {
    if (!busy || !capturing) return
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const id = operation.current
      if (!id || disposed) return
      try { const value = await bridge.appSources.captureProgress(tenant, id); if (!disposed && operation.current === id) setProgress(value) } catch { /* The capture result reports errors. */ }
      if (!disposed) timer = setTimeout(() => void poll(), 500)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [busy, capturing, tenant])
  async function run(action: (id: string) => Promise<boolean>, success: string, sourceId: string | null = null, capture = false) {
    if (operation.current) return false
    setCapturing(capture); setProgress(null)
    const id = crypto.randomUUID(); operation.current = id
    setBusy(true); setFeedbackSource(sourceId); setCancelling(false); setError(""); setNotice("")
    const cancelled = capture ? "Backup cancelled. No installer backup was stored." : "Export cancelled. No destination file was published."
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
        else if (message.includes("Windows approval was cancelled")) setNotice(cancelled)
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
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><Shield className="mt-1 size-5 text-gray-600" aria-hidden="true" /><div><h4 id="device-heading" className="text-base font-semibold text-gray-900">Check this PC</h4><p className="mt-1 max-w-3xl text-sm text-gray-600">Check Windows enrollment for the selected tenant. This read-only check does not install the app or confirm installer access.</p></div></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={deviceBusy || platform !== "win32"} onClick={() => void checkDevice(true)}>{deviceBusy ? "Checking…" : "Check Windows enrollment"}</Button></div></div>
      {device ? <div role="status" className="mt-4 space-y-2 rounded-2xl bg-secondary/50 p-4 text-sm text-gray-700"><p>Enrollment: {enrollmentLabels[device.enrollment]}. Certificate: {certificateLabels[device.certificate]}.</p><p>{device.reason}</p></div> : <p className="mt-4 text-sm text-gray-600">{deviceBusy ? "Checking device metadata…" : platform && platform !== "win32" ? "Windows only. Installer capture is not available on this computer in this build." : "Device not checked."}</p>}
      {deviceError && <p role="alert" className="mt-4 text-sm text-red-800">{deviceError}</p>}
    </section>
  )
  const feedback = <>
    {busy && <div role="status" className="mt-4 space-y-2 rounded-2xl bg-secondary p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3"><span>{capturing ? cancelling ? "Cancellation requested. Dismiss any Windows approval prompt." : progress?.phase === "downloading" ? `Downloading installer… ${size(progress.receivedBytes)}${progress.totalBytes ? ` of ${size(progress.totalBytes)}` : ""}` : progress?.phase === "verifying" ? "Verifying and saving encrypted backup…" : progress?.phase === "windows-approval" ? "Approve Windows access, then checking installer availability…" : "Checking Microsoft authorization…" : "Exporting installer…"}</span><Button variant="outline" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Cancelling…" : "Cancel operation"}</Button></div>
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
      {[{ id: "apps", label: "Intune apps" }, { id: "versions", label: "Backups" }].map(item => <Link key={item.id} to={item.id === "apps" ? "/portal/app-backup" : "/portal/app-backup/versions"} aria-current={tab === item.id ? "page" : undefined} className={cn("flex h-10 items-center rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", tab === item.id ? "bg-primary text-primary-foreground" : "bg-card text-gray-700 hover:bg-secondary")}>{item.label}</Link>)}
    </nav>
    {appsVisited && <div hidden={tab !== "apps"} className="space-y-6"><IntuneAppsView active={tab === "apps"} tenant={tenant} devicePanel={devicePanel} busy={busy} platform={platform} feedback={tab === "apps" ? feedback : null} onCapture={appId => run(id => bridge.appSources.capture(tenant, id, appId), "Installer backed up from Intune. View it in Backups, and keep your recovery key from Settings safe.", null, true)} /></div>}
    {tab === "versions" && <section aria-labelledby="stored-sources-heading" className="rounded-3xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 id="stored-sources-heading" className="text-lg font-semibold text-gray-900">Installer backups</h2><p className="mt-1 text-sm text-gray-600">{state ? `${state.sources.filter(source => source.provenance === "intune-capture").length} Intune captures · Folder: ${state.storeName}` : "Connect the source folder that holds this tenant's installers."}</p></div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || loading} onClick={() => { setNotice(""); void reload() }}><RefreshCw className="mr-2 size-4" aria-hidden="true" />Refresh</Button><Button variant="outline" disabled={busy} onClick={() => void reconnect()}><FolderOpen className="mr-2 size-4" aria-hidden="true" />Choose installer folder</Button></div>
      </div>
      <p className="mt-5 max-w-prose text-sm text-gray-600">Backups contain installer content retrieved from Intune. Capture runs on an enrolled Windows PC. Restore is not available in this build. Existing local archives can still be exported, but they are not Intune backups and cannot be used for restore.</p>
      {(loading || !feedbackSource || !state?.sources.some(source => source.id === feedbackSource)) && feedback}
      {state?.warnings.map(warning => <p role="status" key={warning} className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">{warning}</p>)}
      <p className="mt-4 text-xs text-gray-600">Export needs a destination with hard-link support and preserves existing files.</p>
      <div className="mt-6"><label htmlFor="source-search" className="mb-2 block text-sm font-medium text-gray-900">Search backups and archives</label><Input id="source-search" name="sourceSearch" autoComplete="off" disabled={!state || !state.sources.length || busy} value={search} onChange={event => setSearch(event.target.value)} placeholder="App label or file name…" /></div>
      {loading ? <p role="status" className="py-8 text-sm text-gray-600">Reading the source store…</p> : sources.length ? <ul className="mt-4 divide-y">{sources.map(source => <li key={source.id} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 140px" }} className="flex flex-wrap items-start gap-4 py-5">
        <Package className="mt-1 size-5 shrink-0 text-gray-500" aria-hidden="true" /><div className="min-w-0 flex-1 basis-64"><h3 className="break-words font-medium text-gray-900">{source.appName}</h3><p className="mt-1 break-all text-sm text-gray-600">{source.fileName}</p><p className="mt-2 text-xs text-gray-600">{source.provenance === "intune-capture" ? "Captured from Intune" : "Legacy local archive"} · {size(source.bytes)} · {new Date(source.createdAt).toLocaleString()}</p><details className="mt-2 text-xs text-gray-600"><summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">File details</summary><p className="mt-2 break-all font-mono">SHA-256: {source.sha256}</p><p className="mt-1">{source.provenance === "intune-capture" ? `Content version ${source.receipt.contentVersion}. Captured installer payload; restore is not available in this build.` : "Previously selected local file. Not an Intune backup; unavailable for restore."}</p></details></div>
        <Button variant="outline" disabled={busy} onClick={() => void run(id => bridge.appSources.export(tenant, id, source.id), "Installer exported.", source.id)}><ArrowDownToLine className="mr-2 size-4" aria-hidden="true" />{source.provenance === "intune-capture" ? "Export installer" : "Export archive"}</Button>
        {feedbackSource === source.id && <div className="min-w-0 basis-full">{feedback}</div>}
      </li>)}</ul> : <p className="py-8 text-sm text-gray-600">{!state ? "The source store is unavailable. Reconnect it and check the matching recovery key." : search ? "No stored packages match your search." : "No Intune backups yet. Choose a Win32 app in the Intune apps tab to start."}</p>}
    </section>}

  </>
}
