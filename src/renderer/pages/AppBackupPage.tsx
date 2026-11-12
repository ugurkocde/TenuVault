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
    {tenant ? <SourceWorkspace key={tenant} tenant={tenant} /> : <div className="rounded-3xl bg-card p-6 text-sm text-gray-600">Select a configured tenant to view or store its installers.</div>}
  </div>
}

export function SourceWorkspace({ tenant }: { tenant: string }) {
  const { tabId } = useParams()
  const navigate = useNavigate()
  const tab = tabId === "versions" ? "versions" : "apps"
  const [state, setState] = useState<AppSourceState | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
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
    try { const value = await bridge.appSources.list(tenant); if (alive.current && generation === listGeneration.current) { setState(value); setError("") } }
    catch (e) { if (alive.current && generation === listGeneration.current) { setState(null); setError(e instanceof Error ? e.message : "The source store could not be read.") } }
    finally { if (alive.current && generation === listGeneration.current) setLoading(false) }
  }
  useEffect(() => {
    alive.current = true
    void reload()
    return () => { alive.current = false; listGeneration.current++; if (operation.current) void bridge.appSources.cancel(tenant, operation.current).catch(() => {}) }
  }, [tenant])
  async function run(action: (id: string) => Promise<boolean>, success: string) {
    const id = crypto.randomUUID(); operation.current = id
    setBusy(true); setError(""); setNotice("")
    try { const done = await action(id); if (alive.current && done) { setNotice(success); await reload() } return done }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "The source operation failed."); return false }
    finally { operation.current = null; if (alive.current) setBusy(false) }
  }
  async function reconnect() {
    setError("")
    try { if (await bridge.appSources.chooseStore(tenant) && alive.current) await reload() }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "The folder could not be connected.") }
  }
  async function checkDevice(signIn = false) {
    setDeviceBusy(true); setDevice(null); setDeviceError("")
    try {
      if (signIn) await bridge.appSources.signIn(tenant)
      if (!alive.current) return
      const value = await bridge.appSources.deviceStatus(tenant)
      if (alive.current) setDevice(value)
    } catch (e) { if (alive.current) setDeviceError(e instanceof Error ? e.message : "The device could not be checked.") }
    finally { if (alive.current) setDeviceBusy(false) }
  }
  const sources = (state?.sources ?? []).filter(source => `${source.appName} ${source.fileName}`.toLowerCase().includes(search.toLowerCase()))
  const devicePanel = (
    <section aria-labelledby="device-heading" className="rounded-3xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><Shield className="mt-1 size-5 text-gray-600" aria-hidden="true" /><div><h2 id="device-heading" className="text-base font-semibold text-gray-900">Check this PC</h2><p className="mt-1 max-w-3xl text-sm text-gray-600">Check Windows enrollment for the selected tenant. This read-only check does not install the app or confirm installer access.</p></div></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={deviceBusy} onClick={() => void checkDevice(true)}>Sign in again</Button><Button variant="outline" disabled={deviceBusy} onClick={() => void checkDevice()}>{deviceBusy ? "Checking…" : "Check this device"}</Button></div></div>
      {device ? <div role="status" className="mt-4 space-y-2 rounded-2xl bg-secondary/50 p-4 text-sm text-gray-700"><p>Enrollment: {enrollmentLabels[device.enrollment]}. Certificate: {certificateLabels[device.certificate]}.</p><p>{device.reason}</p></div> : <p className="mt-4 text-sm text-gray-600">{deviceBusy ? "Checking device metadata…" : "Device not checked."}</p>}
      {deviceError && <p role="alert" className="mt-4 text-sm text-red-800">{deviceError}</p>}
    </section>
  )
  return <>
    <nav aria-label="App Backup sections" className="flex flex-wrap gap-2">
      {[{ id: "apps", label: "Intune apps" }, { id: "versions", label: "Saved installers" }].map(item => <Link key={item.id} to={item.id === "apps" ? "/portal/app-backup" : "/portal/app-backup/versions"} aria-current={tab === item.id ? "page" : undefined} className={cn("flex h-10 items-center rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", tab === item.id ? "bg-primary text-primary-foreground" : "bg-card text-gray-700 hover:bg-secondary")}>{item.label}</Link>)}
    </nav>
    {tab === "apps" && busy && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-secondary p-4 text-sm"><span>Saving installer…</span><Button variant="outline" onClick={() => { if (operation.current) void bridge.appSources.cancel(tenant, operation.current).catch(() => {}) }}>Cancel operation</Button></div>}
    {tab === "apps" && error && <p role="alert" className="rounded-2xl bg-red-50 p-4 text-sm text-red-900">{error}</p>}
    {tab === "apps" && <IntuneAppsView tenant={tenant} devicePanel={devicePanel} busy={busy} attach={label => { void run(id => bridge.appSources.attach(tenant, id, label), "Installer saved.").then(done => { if (done && alive.current) navigate("/portal/app-backup/versions") }) }} />}
    {tab === "versions" && <section aria-labelledby="stored-sources-heading" className="rounded-3xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 id="stored-sources-heading" className="text-lg font-semibold text-gray-900">Saved installers</h2><p className="mt-1 text-sm text-gray-600">{state ? `${state.sources.length} stored ${state.sources.length === 1 ? "package" : "packages"} · ${state.storeName}` : "Connect the source folder that holds this tenant's installers."}</p></div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || loading} onClick={() => void reload()}><RefreshCw className="mr-2 size-4" aria-hidden="true" />Refresh</Button><Button variant="outline" disabled={busy} onClick={() => void reconnect()}><FolderOpen className="mr-2 size-4" aria-hidden="true" />Reconnect source store</Button></div>
      </div>
      <details className="mt-5"><summary className="cursor-pointer text-sm font-medium">Add an installer file manually</summary>
      <form className="mt-6 flex flex-wrap items-end gap-3 rounded-2xl bg-secondary/50 p-4" onSubmit={event => { event.preventDefault(); void run(id => bridge.appSources.attach(tenant, id, name), "Original package stored. Keep your recovery key with the source folder backup.") }}>
        <div className="min-w-48 flex-1"><label htmlFor="source-app-name" className="mb-2 block text-sm font-medium text-gray-900">App name <span className="font-normal text-gray-600">(optional label)</span></label><Input id="source-app-name" name="appName" autoComplete="off" maxLength={200} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="For example, Finance desktop app…" /></div>
        <Button type="submit" disabled={busy}><Plus className="mr-2 size-4" aria-hidden="true" />Attach source</Button>
        <p className="basis-full text-xs text-gray-600">Choose an existing .intunewin package, up to 2 GiB. Its container is checked and the original bytes are encrypted in the source folder. Installation behavior is not tested.</p>
      </form></details>
      {busy && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-secondary p-4 text-sm"><span>Source operation in progress for this tenant…</span><Button variant="outline" onClick={() => { if (operation.current) void bridge.appSources.cancel(tenant, operation.current).catch(e => { if (alive.current) setError(e instanceof Error ? e.message : "Cancellation failed.") }) }}>Cancel operation</Button></div>}
      {error && <div role="alert" className="mt-4 rounded-2xl bg-red-50 p-4 text-sm text-red-900"><p>{error}</p><p className="mt-2">For a retained source folder, reconnect it and import its matching recovery key in Settings.</p></div>}
      {notice && <p role="status" className="mt-4 rounded-2xl bg-secondary p-4 text-sm text-gray-700">{notice}</p>}
      {state?.warnings.map(warning => <p role="status" key={warning} className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">{warning}</p>)}
      <div className="mt-6"><label htmlFor="source-search" className="mb-2 block text-sm font-medium text-gray-900">Search stored packages</label><Input id="source-search" name="sourceSearch" autoComplete="off" value={search} onChange={event => setSearch(event.target.value)} placeholder="App label or file name…" /></div>
      {loading ? <p role="status" className="py-8 text-sm text-gray-600">Reading the source store…</p> : sources.length ? <ul className="mt-4 divide-y">{sources.map(source => <li key={source.id} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 140px" }} className="flex flex-wrap items-start gap-4 py-5">
        <Package className="mt-1 size-5 shrink-0 text-gray-500" aria-hidden="true" /><div className="min-w-0 flex-1 basis-64"><h3 className="break-words font-medium text-gray-900">{source.appName}</h3><p className="mt-1 break-all text-sm text-gray-600">{source.fileName}</p><p className="mt-2 text-xs text-gray-600">Administrator selected · {size(source.bytes)} · {new Date(source.createdAt).toLocaleString()}</p><details className="mt-2 text-xs text-gray-600"><summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">File details</summary><p className="mt-2 break-all font-mono">SHA-256: {source.sha256}</p><p className="mt-1">Stored copy only. Intune content equivalence is unknown.</p></details></div>
        <Button variant="outline" disabled={busy} onClick={() => void run(id => bridge.appSources.export(tenant, id, source.id), "Original package exported. Existing destination files were preserved.")}><ArrowDownToLine className="mr-2 size-4" aria-hidden="true" />Export original</Button>
      </li>)}</ul> : <p className="py-8 text-sm text-gray-600">{!state ? "The source store is unavailable. Reconnect it and check the matching recovery key." : search ? "No stored packages match your search." : "No stored installers in this source folder yet. Attach a package to keep its original bytes."}</p>}
    </section>}

  </>
}
