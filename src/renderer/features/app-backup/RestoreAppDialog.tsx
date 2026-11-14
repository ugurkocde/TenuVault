import { useEffect, useRef, useState } from "react"
import { CheckCircle2, ExternalLink } from "lucide-react"
import { useTenants } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { bridge } from "../../lib/bridge"
import { requestAcknowledgement } from "../../lib/disclaimer"
import { isAcknowledgementRequired } from "../../../shared/disclaimer"
import type { AppDeviceCode, AppRestoreProgress, AppRestoreResult, AppRestoreReview, CapturedAppSource } from "../../../shared/app-sources/types"

export function RestoreAppDialog({ tenant, source, onClose, onBusy }: { tenant: string; source: CapturedAppSource; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const tenants = useTenants()
  const [review, setReview] = useState<AppRestoreReview | null>(null)
  const [target, setTarget] = useState("")
  const [name, setName] = useState(`${source.appName} (restored)`.slice(0, 200))
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [deviceCode, setDeviceCode] = useState<AppDeviceCode | null>(null)
  const [deviceStarting, setDeviceStarting] = useState(false)
  const deviceTenant = useRef<string | null>(null), signInGeneration = useRef(0)
  const [signedIn, setSignedIn] = useState<string[]>([])
  const [error, setError] = useState("")
  const [progress, setProgress] = useState<AppRestoreProgress | null>(null)
  const [result, setResult] = useState<AppRestoreResult | null>(null)
  const alive = useRef(true), operation = useRef<string | null>(null)
  const stopped = useRef(false)
  const destination = tenants.find(t => t.credentials?.tenantId.toLowerCase() === target)
  const authenticated = signedIn.includes(target)
  const refreshAccounts = async () => {
    const accounts = await bridge.auth.accounts()
    if (alive.current) setSignedIn(accounts.map(a => a.tenantId.toLowerCase()))
  }
  useEffect(() => {
    alive.current = true
    void bridge.appSources.restoreReview(tenant, source.id).then(value => { if (alive.current) setReview(value) }).catch(e => { if (alive.current) setError(e instanceof Error ? e.message : "The backup could not be reviewed.") }).finally(() => { if (alive.current) setLoading(false) })
    void refreshAccounts().catch(() => {})
    return () => { alive.current = false; if (deviceTenant.current) void bridge.appSources.cancelDeviceSignIn(deviceTenant.current).catch(() => {}); if (operation.current) void bridge.appSources.cancel(tenant, operation.current).catch(() => {}); onBusy(false) }
  }, [tenant, source.id])
  useEffect(() => {
    if (!running) return
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!operation.current || disposed) return
      try { const value = await bridge.appSources.restoreProgress(tenant, operation.current); if (!disposed) setProgress(value) } catch { /* Final result reports failures. */ }
      if (!disposed) timer = setTimeout(() => void poll(), 500)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [running, tenant])
  useEffect(() => {
    if (!deviceCode || !deviceTenant.current) return
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const value = await bridge.appSources.deviceSignInStatus(deviceTenant.current!)
        if (disposed) return
        if (value?.status === "completed") { await refreshAccounts(); if (!disposed) { setDeviceCode(null); deviceTenant.current = null }; return }
        if (value?.status === "failed") { setError(value.error || "Microsoft device sign-in failed."); setDeviceCode(null); deviceTenant.current = null; return }
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "Microsoft sign-in status is unavailable.") }
      if (!disposed) timer = setTimeout(() => void poll(), 2000)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [deviceCode])
  async function startDeviceCode() {
    if (!target || deviceStarting) return
    signInGeneration.current++; setSigningIn(false); setDeviceStarting(true); setError("")
    deviceTenant.current = target
    try { const code = await bridge.appSources.deviceSignIn(target); if (alive.current) setDeviceCode(code) }
    catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : "A Microsoft device code could not be created."); deviceTenant.current = null } }
    finally { if (alive.current) setDeviceStarting(false) }
  }
  async function cancelCode() {
    const active = deviceTenant.current
    if (active) await bridge.appSources.cancelDeviceSignIn(active)
    if (alive.current) { setDeviceCode(null); deviceTenant.current = null }
  }
  async function loadSettings(reconnect = false) {
    setLoading(true); setError("")
    try {
      if (reconnect) { await bridge.appSources.signIn(tenant); await refreshAccounts() }
      if (!alive.current) return
      const value = await bridge.appSources.loadRestoreSettings(tenant, source.id); if (alive.current) setReview(value)
    }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Source settings could not be loaded.") }
    finally { if (alive.current) setLoading(false) }
  }
  async function signIn() {
    const generation = ++signInGeneration.current
    setSigningIn(true); setError("")
    try { await bridge.appSources.signIn(target); await refreshAccounts() }
    catch (e) { if (alive.current && generation === signInGeneration.current) setError(e instanceof Error ? e.message : "Microsoft sign-in failed.") }
    finally { if (alive.current && generation === signInGeneration.current) setSigningIn(false) }
  }
  async function restore() {
    if (operation.current || !review?.settingsHash || !confirmed || !target) return
    const id = crypto.randomUUID(); operation.current = id
    stopped.current = false
    setRunning(true); onBusy(true); setError(""); setProgress(null)
    try {
      let value = await bridge.appSources.restore(tenant, id, source.id, target, name, review.settingsHash)
      if (isAcknowledgementRequired(value)) {
        if (!await requestAcknowledgement(value.acknowledgement.tenantIds)) throw new Error("Restore cancelled. No changes were made.")
        if (!alive.current || stopped.current) return
        value = await bridge.appSources.restore(tenant, id, source.id, target, name, review.settingsHash)
      }
      if (isAcknowledgementRequired(value)) throw new Error(value.error)
      if (alive.current) setResult(value)
    } catch (e) {
      if (alive.current) {
        const message = e instanceof Error ? e.message : "Restore failed."
        setError(message.endsWith("Source operation cancelled.") ? "Restore stopped. An unassigned app may remain in the destination. Retry with the same destination and app name to continue it." : message)
      }
    } finally { operation.current = null; onBusy(false); if (alive.current) setRunning(false) }
  }
  const phase = progress?.phase === "uploading" ? `Uploading installer: ${Math.floor(progress.uploadedBytes / 1024 ** 2)} of ${Math.ceil(progress.totalBytes / 1024 ** 2)} MB` : progress?.phase === "creating" ? "Creating the unassigned app…" : progress?.phase === "committing" ? "Intune is verifying the uploaded installer…" : progress?.phase === "publishing" ? "Verifying the published app…" : "Verifying backup and destination access…"
  return <Dialog open onOpenChange={open => { if (!open && !running && !loading && !signingIn) onClose() }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" onInteractOutside={event => { if (running) event.preventDefault() }}>
      <DialogHeader><DialogTitle>Restore to tenant</DialogTitle><DialogDescription>Create a new Win32 app from {source.appName}’s captured installer. Existing destination apps stay unchanged.</DialogDescription></DialogHeader>
      {result ? <div className="space-y-4 py-4">
        <div role="status" className="flex items-start gap-3 rounded-2xl border p-4"><CheckCircle2 aria-hidden="true" className="size-6 shrink-0" /><div><p className="font-medium">{result.name} restored to {destination?.name || "the destination tenant"}.</p><p className="mt-2 text-sm text-muted-foreground">Intune confirmed the installer and published the app. No assignments were added. Review it before deploying.</p></div></div>
        <Button onClick={() => void bridge.app.openExternal(`https://intune.microsoft.com/#@${result.tenantId}/view/Microsoft_Intune_Apps/SettingsMenu/~/0/appId/${result.appId}`)}><ExternalLink className="mr-2 size-4" aria-hidden="true" />Open restored app</Button>
      </div> : <div className="space-y-5 py-3">
        {loading ? <p role="status">Reading backup settings…</p> : review && !review.settingsHash ? <div className="space-y-3 rounded-2xl border p-4"><p className="font-medium">This earlier backup contains the installer only.</p><p className="text-sm text-muted-foreground">Load the app’s current settings from the source tenant. They are accepted only if its content version still matches this installer. You can review them before restoring.</p><Button onClick={() => void loadSettings()}>Load current app settings</Button>{(!!error || !signedIn.includes(tenant)) && <Button variant="outline" onClick={() => void loadSettings(true)}>Reconnect source and load settings</Button>}</div> : review && <>
          <section aria-label="App settings" className="space-y-3 rounded-2xl border p-4">
            <p className="font-medium">{review.name} · {review.version || "Version not specified"}</p>
            <p className="text-sm text-muted-foreground">{review.publisher} · Install as {review.runAs || "unspecified"} · {review.detectionRules} detection and {review.requirementRules} requirement rules</p>
            <details><summary className="cursor-pointer text-sm">Review install and uninstall commands</summary><pre className="mt-3 whitespace-pre-wrap break-all rounded-xl bg-secondary p-3 text-xs">{review.installCommand}{"\n\n"}{review.uninstallCommand}</pre></details>
            <p className="text-xs text-muted-foreground">{review.currentSettings ? "Current source settings loaded" : "Settings captured with this backup"} {review.observedAt ? new Date(review.observedAt).toLocaleString() : ""}.</p>
          </section>
          {review.blocker ? <p role="alert" className="rounded-xl bg-secondary p-4 text-sm">{review.blocker}</p> : <>
            <div><label htmlFor="restore-target" className="mb-2 block text-sm font-medium">Destination tenant</label><select id="restore-target" name="restoreTarget" disabled={running || signingIn || deviceStarting || !!deviceCode} value={target} onChange={e => { setTarget(e.target.value); setConfirmed(false); setError("") }} className="h-11 w-full rounded-xl border bg-background px-3 text-sm"><option value="">Choose a connected tenant…</option>{tenants.filter(t => t.credentials?.tenantId).map(t => <option key={t.id} value={t.credentials!.tenantId.toLowerCase()}>{t.name}{t.credentials!.tenantId.toLowerCase() === tenant ? " (source tenant)" : ""}</option>)}</select></div>
            {target && (!authenticated || !!error) && <div className="space-y-2"><p className="text-sm text-muted-foreground">Use a destination account with permission to create Intune apps. Your source session stays connected.</p><Button variant="outline" disabled={signingIn || running || deviceStarting || !!deviceCode} onClick={() => void signIn()}>{signingIn ? "Signing in…" : authenticated ? "Reconnect destination" : "Sign in to destination"}</Button><Button variant="ghost" disabled={running || deviceStarting || !!deviceCode} onClick={() => void startDeviceCode()}>{deviceStarting ? "Getting Microsoft code…" : "Use a device code"}</Button></div>}
            {deviceCode && <div role="status" className="space-y-3 rounded-xl border p-4 text-sm"><p>On your Mac or another device, open <button type="button" className="underline underline-offset-4" onClick={() => void bridge.app.openExternal(deviceCode.verificationUri)}>{deviceCode.verificationUri}</button> and enter:</p><p className="font-mono text-2xl font-semibold tracking-widest select-all">{deviceCode.userCode}</p><p>Sign in to {destination?.name}. This authorizes TenuVault on this computer. The code expires at {new Date(deviceCode.expiresAt).toLocaleTimeString()}.</p><p className="text-xs text-muted-foreground">Microsoft MFA and Conditional Access still apply. If your organization blocks device codes, use browser sign-in on this computer.</p><Button variant="outline" onClick={() => void cancelCode().catch(e => setError(e instanceof Error ? e.message : "Sign-in cancellation failed."))}>Cancel device sign-in</Button></div>}
            <div><label htmlFor="restore-name" className="mb-2 block text-sm font-medium">New app name</label><Input id="restore-name" name="restoreName" autoComplete="off" maxLength={200} value={name} disabled={running} onChange={e => { setName(e.target.value); setConfirmed(false) }} /></div>
            <div className="rounded-xl bg-secondary p-4 text-sm"><p>The app will be unassigned. Groups, assignment filters, categories and custom scope tags are not copied. Review destination-specific URLs, commands and scripts before deploying. Apps needing dependency mapping or Intune-hosted install scripts are blocked before creation.</p></div>
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={running || !target} onChange={e => setConfirmed(e.target.checked)} /><span>Create this app in <strong>{destination?.name || "the selected tenant"}</strong>, with no assignments.</span></label>
          </>}
        </>}
        {running && <div role="status" className="space-y-3 rounded-xl bg-secondary p-4 text-sm"><p>{phase}</p><p>Leaving this page stops the upload. Retry with the same app name and destination to continue; an unassigned draft may remain.</p><Button variant="outline" onClick={() => { stopped.current = true; if (operation.current) void bridge.appSources.cancel(tenant, operation.current).catch(() => {}) }}>Stop restore</Button></div>}
        {error && <p role="alert" className="rounded-xl border p-4 text-sm">{error}</p>}
      </div>}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-4"><Button variant="outline" disabled={running || loading || signingIn} onClick={onClose}>{result ? "Done" : "Close"}</Button>{!result && <Button disabled={running || loading || signingIn || deviceStarting || !!deviceCode || !authenticated || !confirmed || !review?.settingsHash || !!review.blocker || !name.trim()} onClick={() => void restore()}>{running ? "Restoring…" : "Restore unassigned app"}</Button>}</div>
    </DialogContent>
  </Dialog>
}
