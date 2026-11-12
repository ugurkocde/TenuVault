import { useEffect, useRef, useState } from "react"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { bridge } from "../../lib/bridge"
import { adminCenterLink } from "../../../shared/intune/admin-links"
import type { IntuneBackupApp } from "../../../shared/app-sources/types"

export function IntuneAppsView({ tenant, devicePanel, attach, busy }: { tenant: string; devicePanel: React.ReactNode; attach: (name: string) => void; busy: boolean }) {
  const [apps, setApps] = useState<IntuneBackupApp[]>([]), [selected, setSelected] = useState<IntuneBackupApp | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [fetchedAt, setFetchedAt] = useState(""), [search, setSearch] = useState("")
  const generation = useRef(0), alive = useRef(true), panel = useRef<HTMLElement>(null)
  async function load(signIn = false) {
    const current = ++generation.current; setLoading(true); setError("")
    try {
      if (signIn) await bridge.appSources.signIn(tenant)
      if (!alive.current || generation.current !== current) return
      const result = await bridge.appSources.apps(tenant)
      if (alive.current && generation.current === current) { setApps(result.apps); setFetchedAt(result.fetchedAt); setSelected(null) }
    } catch(e) { if (alive.current && generation.current === current) { setApps([]); setFetchedAt(""); setSelected(null); setError(e instanceof Error ? e.message : "The app list could not be loaded.") } }
    finally { if (alive.current && generation.current === current) setLoading(false) }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; generation.current++ } }, [tenant])
  const filtered = apps.filter(app => `${app.name} ${app.publisher}`.toLowerCase().includes(search.toLowerCase()))
  return <>
    <div className="rounded-3xl border bg-card p-6">
      <h2 className="text-lg font-semibold text-gray-900">Back up an Intune app</h2>
      <p className="mt-2 text-sm text-gray-600">Choose an app → check this PC and its targeting → save the installer. App Backup is completely free.</p>
      <p className="mt-2 text-sm text-gray-600">Installer capture from Intune is not available in this build. You can prepare an app below, or save an installer you already have in Saved installers.</p>
    </div>
    <section className="rounded-3xl border bg-card p-6" aria-labelledby="intune-apps-heading">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="intune-apps-heading" className="text-lg font-semibold text-gray-900">Your Win32 apps in Intune</h2><p className="mt-1 text-sm text-gray-600">{fetchedAt ? `${apps.length} apps · Refreshed ${new Date(fetchedAt).toLocaleString()}` : "Sign in to load the selected tenant’s apps. Saved installers remain available offline."}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={loading} onClick={() => void load(true)}>Sign in to Microsoft</Button><Button variant="outline" disabled={loading} onClick={() => void load()}>Refresh apps</Button></div></div>
      {error && <p role="alert" className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">{error}</p>}
      <label className="mb-2 mt-5 block text-sm font-medium" htmlFor="intune-app-search">Find an app</label><Input id="intune-app-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="App name or publisher…" />
      {loading ? <p role="status" className="py-6 text-sm text-gray-600">Loading your Intune apps…</p> : fetchedAt && !filtered.length ? <p className="py-6 text-sm text-gray-600">{search ? "No apps match your search." : "No Win32 apps were returned for this tenant."}</p> : <ul className="mt-3 divide-y">{filtered.map(app => <li key={app.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div className="min-w-0"><h3 className="break-words font-medium">{app.name}</h3><p className="text-sm text-gray-600">{app.publisher || "Publisher not specified"} · Installer access not checked</p></div><Button variant="outline" onClick={() => { setSelected(app); requestAnimationFrame(() => { panel.current?.focus(); panel.current?.scrollIntoView({ block: "nearest" }) }) }}>Prepare backup<span className="sr-only"> for {app.name}</span></Button></li>)}</ul>}
    </section>
    {selected && <section ref={panel} tabIndex={-1} className="rounded-3xl border bg-card p-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Prepare backup for ${selected.name}`}>
      <div className="flex items-start justify-between gap-3"><h2 className="text-lg font-semibold">Prepare backup: {selected.name}</h2><Button variant="ghost" onClick={() => setSelected(null)}>Close preparation</Button></div>
      <ol className="mt-5 space-y-5 text-sm">
        <li><h3 className="font-semibold">1. Use a Windows PC enrolled in this tenant</h3><p className="mt-1 text-gray-600">Check this PC before changing any assignments. A matching enrollment alone does not prove installer access.</p><div className="mt-3">{devicePanel}</div></li>
        <li><h3 className="font-semibold">2. Confirm that the app targets this PC</h3><p className="mt-1 text-gray-600">Review the app’s assignments in Intune. If you need a Required assignment, use a dedicated test-device group and check exclusions and filters first. Required can install the app automatically. Available targeting may also allow access; an assignment alone does not confirm this PC is included.</p><Button className="mt-3" variant="outline" onClick={() => { const link = adminCenterLink("Apps", selected.id); if (link) void bridge.app.openExternal(link.url) }}>Open app in Intune</Button></li>
        <li><h3 className="font-semibold">3. Capture and save the installer</h3><p className="mt-1 text-gray-600">Capture will retrieve the original package, check it, and save an encrypted copy. Installed program files are not a substitute for the original installer.</p><Button className="mt-3" disabled>Capture unavailable in this build</Button></li>
      </ol>
      <div className="mt-6 border-t pt-4"><p className="text-sm text-gray-600">Already have the original .intunewin file? Save it now. The app name is a label; its Intune version is not verified.</p><Button className="mt-3" disabled={busy} onClick={() => attach(selected.name.slice(0, 200))}>Save an installer I already have</Button></div>
    </section>}
  </>
}
