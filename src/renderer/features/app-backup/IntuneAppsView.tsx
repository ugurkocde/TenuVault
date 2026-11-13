import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, HardDriveDownload, Info, RefreshCw } from "lucide-react"
import { AppDetailsDialog, AppIcon } from "./AppDetailsDialog"
import { Fragment } from "react"
import { Link } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { bridge } from "../../lib/bridge"
import { adminCenterLink } from "../../../shared/intune/admin-links"
import type { IntuneBackupApp } from "../../../shared/app-sources/types"

interface Props {
  tenant: string
  devicePanel: React.ReactNode
  busy: boolean
  feedback?: React.ReactNode
  active?: boolean
}

export function IntuneAppsView({ tenant, devicePanel, busy, feedback, active = true }: Props) {
  const [apps, setApps] = useState<IntuneBackupApp[]>([])
  const [detailsApp, setDetailsApp] = useState<IntuneBackupApp | null>(null)
  const [page,setPage] = useState(0)
  const detailsTrigger = useRef<HTMLButtonElement | null>(null), focusBackupOnClose = useRef(false)
  const [selected, setSelected] = useState<IntuneBackupApp | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState("")
  const [fetchedAt, setFetchedAt] = useState(""), [search, setSearch] = useState("")
  const generation = useRef(0), alive = useRef(true)
  const panel = useRef<HTMLHeadingElement>(null), trigger = useRef<HTMLButtonElement | null>(null)
  async function load(signIn = false) {
    const current = ++generation.current
    setLoading(true); setError("")
    try {
      if (signIn) await bridge.appSources.signIn(tenant)
      const accounts = await bridge.auth.accounts()
      if (!alive.current || generation.current !== current) return
      if (!accounts.some(account => account.tenantId.toLowerCase() === tenant.toLowerCase())) {
        setApps([]); setFetchedAt(""); setSelected(null)
        return
      }
      const result = await bridge.appSources.apps(tenant)
      if (alive.current && generation.current === current) {
        setApps(result.apps); setFetchedAt(result.fetchedAt); setSelected(null); setPage(0)
      }
    } catch (e) {
      if (alive.current && generation.current === current) {
        setApps([]); setFetchedAt(""); setSelected(null)
        setError(e instanceof Error ? e.message : "The app list could not be loaded. Check Microsoft sign-in and refresh.")
      }
    } finally { if (alive.current && generation.current === current) setLoading(false) }
  }
  useEffect(() => { if (!active) setDetailsApp(null) }, [active])
  useEffect(() => {
    alive.current = true; void load()
    return () => { alive.current = false; generation.current++ }
  }, [tenant])
  const names=new Set<string>(), duplicateNames=new Set<string>()
  for(const app of apps){const name=app.name.toLowerCase();if(names.has(name))duplicateNames.add(name);names.add(name)}
  const filtered = apps.filter(app => `${app.name} ${app.publisher} ${app.version ?? ""}`.toLowerCase().includes(search.toLowerCase()))
  const pages = Math.max(1,Math.ceil(filtered.length/25)), currentPage = Math.min(page,pages-1)
  const visible = filtered.slice(currentPage*25,(currentPage+1)*25)
  function backup(app: IntuneBackupApp, button?: HTMLButtonElement) {
    trigger.current = button ?? document.getElementById(`backup-app-${app.id}`) as HTMLButtonElement | null
    setSelected(app)
    requestAnimationFrame(() => {panel.current?.focus();panel.current?.scrollIntoView({block:"nearest"})})
  }
  const selection = selected && <section className="rounded-2xl bg-secondary/40 p-5" aria-label={`Backup ${selected.name}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 ref={panel} tabIndex={-1} className="min-w-0 rounded break-words text-lg font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Back up {selected.name}</h3>
        <Button variant="ghost" disabled={busy} onClick={() => { setSelected(null); if (trigger.current?.isConnected) trigger.current.focus() }}>Close</Button>
      </div>
      <p className="mt-3 max-w-prose text-sm text-gray-600">App Backup retrieves installer content from Intune. Capture is not available in this build, so a backup cannot start yet.</p>
      <p className="mt-3 max-w-prose text-sm text-gray-600">No local installer file is needed. Changing assignments or installing this app will not enable capture in this build.</p>
      {feedback}
      <details className="mt-6 border-t pt-4">
        <summary className="cursor-pointer rounded text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Windows device information (optional)</summary>
        <p className="mt-3 max-w-prose text-sm text-gray-600">A matching enrollment alone does not prove installer access or enable capture. No assignment change is needed for this check.</p>
        <div className="mt-4">{devicePanel}</div>
      </details>
      <Button className="mt-4" variant="outline" onClick={() => { const link = adminCenterLink("Apps", selected.id); if (link) void bridge.app.openExternal(link.url) }}>View app in Intune</Button>
    </section>
  return <>
    <section className="min-w-0 rounded-3xl border bg-card" aria-labelledby="intune-apps-heading">
      <div className="space-y-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h2 id="intune-apps-heading" className="text-xl font-semibold text-gray-900">Your Win32 apps in Intune</h2>
            <p className="mt-1 text-sm text-gray-600">{fetchedAt ? `${apps.length} apps · Updated ${new Date(fetchedAt).toLocaleString()}` : "Your existing Microsoft session is used automatically."}</p></div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline"><Link to="/portal/app-backup/versions">View backups</Link></Button>
            <Button variant="outline" disabled={loading || busy || !fetchedAt} onClick={() => void load()}><RefreshCw className="mr-2 size-4" aria-hidden="true"/>Refresh apps</Button>
          </div>
        </div>
        {!fetchedAt&&!loading&&<div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-secondary/50 p-4 text-sm">
          <p className="max-w-prose">{error ? "The app list could not be refreshed. Check the message below or reconnect Microsoft if the session expired." : "No Microsoft session is available for this tenant. Reconnect to load its apps; existing backups and archives remain available offline."}</p>
          <Button disabled={busy} onClick={()=>void load(true)}>Reconnect Microsoft</Button>
        </div>}
        {error&&<p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{error}</p>}
        <div className="max-w-lg"><label className="mb-2 block text-sm font-medium" htmlFor="intune-app-search">Search apps</label><Input id="intune-app-search" name="intuneAppSearch" autoComplete="off" disabled={!apps.length||busy} value={search} onChange={event=>{setSearch(event.target.value);setPage(0);setSelected(null)}} placeholder="Name, publisher or version…"/></div>
        {!selected&&feedback}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-left text-sm">
          <caption className="sr-only">Win32 apps in the selected tenant, with details and backup actions.</caption>
          <thead className="border-y bg-secondary/40 text-xs text-muted-foreground"><tr><th scope="col" className="px-6 py-3 font-medium">Application</th><th scope="col" className="px-3 py-3 font-medium">Version</th><th scope="col" className="px-3 py-3 font-medium">Last modified</th><th scope="col" className="px-6 py-3 text-right font-medium">Actions</th></tr></thead>
          <tbody>{visible.map(app=><Fragment key={app.id}>
            <tr className="border-b align-middle transition-colors hover:bg-secondary/25">
              <td className="max-w-sm px-6 py-4"><div className="flex min-w-0 items-center gap-3"><AppIcon app={app}/><div className="min-w-0"><button type="button" disabled={busy} className="rounded text-left font-medium [overflow-wrap:anywhere] text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" onClick={event=>{detailsTrigger.current=event.currentTarget;setDetailsApp(app)}}>{app.name}</button><p className="mt-1 break-words text-xs text-muted-foreground">{app.publisher||"Publisher not specified"}</p>{duplicateNames.has(app.name.toLowerCase())&&<p className="mt-1 break-all font-mono text-xs text-muted-foreground">{app.id}</p>}</div></div></td>
              <td className="max-w-36 break-words px-3 py-4 font-mono text-xs">{app.version||"Not specified"}</td>
              <td className="whitespace-nowrap px-3 py-4 text-xs text-muted-foreground">{app.modifiedAt?new Date(app.modifiedAt).toLocaleDateString():"Not specified"}</td>
              <td className="px-6 py-4"><div className="flex items-center justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={event=>{detailsTrigger.current=event.currentTarget;setDetailsApp(app)}}><Info className="mr-1.5 size-4" aria-hidden="true"/>Details<span className="sr-only"> for {app.name}</span></Button><Button id={`backup-app-${app.id}`} size="sm" disabled={busy} onClick={event=>backup(app,event.currentTarget)}><HardDriveDownload className="mr-1.5 size-4" aria-hidden="true"/>Backup<span className="sr-only"> for {app.name}</span></Button></div></td>
            </tr>
            {selected?.id===app.id&&<tr className="border-b"><td colSpan={4} className="p-4">{selection}</td></tr>}
          </Fragment>)}</tbody>
        </table>
      </div>
      {loading?<p role="status" className="p-8 text-sm text-muted-foreground">Loading your Intune apps…</p>:!visible.length&&<p className="p-8 text-sm text-muted-foreground">{fetchedAt?(search?"No apps match your search.":"No Win32 apps were returned for this tenant."):"Connect the tenant’s Microsoft session to view its current apps."}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 p-6 text-xs text-muted-foreground"><p>App Backup is completely free. Installer capture is not available in this build.</p>{pages>1&&<div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={!currentPage||busy} onClick={()=>{setPage(currentPage-1);setSelected(null)}}><ChevronLeft className="size-4" aria-hidden="true"/><span className="sr-only">Previous page</span></Button><span>Page {currentPage+1} of {pages}</span><Button variant="outline" size="sm" disabled={currentPage>=pages-1||busy} onClick={()=>{setPage(currentPage+1);setSelected(null)}}><ChevronRight className="size-4" aria-hidden="true"/><span className="sr-only">Next page</span></Button></div>}</div>
    </section>
    {active&&detailsApp&&<AppDetailsDialog key={`${tenant}/${detailsApp.id}`} tenant={tenant} app={detailsApp} onClose={()=>setDetailsApp(null)} returnFocus={()=>{if(focusBackupOnClose.current){focusBackupOnClose.current=false;requestAnimationFrame(()=>panel.current?.focus())}else if(detailsTrigger.current?.isConnected)detailsTrigger.current.focus()}} onBackup={app=>{focusBackupOnClose.current=true;setDetailsApp(null);backup(app)}}/>}
  </>
}
