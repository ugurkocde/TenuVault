import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { useTenantOperations, useTenants } from "~/contexts/TenantContext"
import type { TenantLicenseStatus } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { formatDate, useLicense } from "../lib/license"
import { openCheckout } from "../lib/purchase"
import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import { changeTenantStorage, LOCAL_SWITCH_CONFIRMATION } from "../lib/storage"
import { useConfirm } from "~/components/ConfirmDialog"
import { CommunityTenantChoiceButton } from "./CommunityTenantPicker"

export function TenantTrialOptions({ onStarted }: { onStarted?: () => void } = {}) {
  const { status, refresh } = useLicense()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  if (!status?.tenantTrialsEnabled || status.hasKey) return null
  return <div className="space-y-3">
    {status.tenants.filter(t => t.signedIn && !t.entitled).map(tenant => <div key={tenant.tenantId}>
      {tenant.trialRefusal ? <p role="status">{tenant.trialRefusal}</p> : <Button disabled={busy} onClick={async () => {
        setBusy(true); setError("")
        try { await bridge.license.startTenantTrial(tenant.tenantId); await refresh(); onStarted?.() }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); await refresh() }
        finally { setBusy(false) }
      }}>Try Pro free</Button>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </div>
}

export function TrialContact({ tenant, initialEmail }: { tenant: TenantLicenseStatus; initialEmail?: string }) {
  const { refresh } = useLicense()
  const [email, setEmail] = useState(tenant.trialEmail ?? initialEmail ?? "")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (tenant.trialEmail || initialEmail) return
    let current = true
    void bridge.auth.accounts().then(accounts => {
      const account = accounts.find(a => a.tenantId.toLowerCase() === tenant.tenantId)
      if (current && account?.username) setEmail(value => value || account.username)
    }).catch(() => {})
    return () => { current = false }
  }, [tenant.tenantId, tenant.trialEmail, initialEmail])
  const save = async (address?: string) => {
    setBusy(true); setMessage("")
    try {
      await bridge.license.tenantTrialAction(tenant.tenantId, "trial_contact", address)
      setMessage(address ? "Email address saved." : "Email address removed.")
      await refresh()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div className="space-y-2">
    <label className="block text-sm">Optional email
      <Input type="email" value={email} maxLength={254} onChange={event => setEmail(event.target.value)} />
    </label>
    <Button disabled={busy || !email.trim()} onClick={() => void save(email.trim())}>Email me setup tips and a reminder before the trial ends</Button>
    {tenant.trialEmail && <Button variant="ghost" disabled={busy} onClick={() => void save()}>Remove email address</Button>}
    <p className="text-xs text-gray-600">Your address is sent only when you press the button. <a href="https://www.tenuvault.com/privacy" target="_blank" rel="noreferrer">Privacy policy</a></p>
    {(message || tenant.trialEmail) && <p role="status">{message || "Email address saved."}</p>}
  </div>
}

export function TenantTrialCard({ tenant, initialEmail, welcome = false }: { tenant: TenantLicenseStatus; initialEmail?: string; welcome?: boolean }) {
  const { status, refresh } = useLicense()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const run = async (action: "acknowledge" | "end_trial" | "extend_trial") => {
    setBusy(true); setError("")
    try { await bridge.license.tenantTrialAction(tenant.tenantId, action); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); await refresh() }
    finally { setBusy(false) }
  }
  const days = Math.max(0, Math.ceil((Date.parse(tenant.trialEndsAt ?? "") - Date.now()) / 86400_000))
  return <section className="space-y-4 rounded-3xl bg-blue-50 p-6">
    <h2 className="text-xl font-medium">{welcome ? "Pro trial started" : tenant.trial ? "Pro trial" : "Pro trial ended"}</h2>
    <p>{days > 0 ? `${days} days left. Ends on ${formatDate(tenant.trialEndsAt!)}.` : `Ended on ${formatDate(tenant.trialEndsAt!)}.`}</p>
    <p>{(status?.tenants.filter(t => t.source === "trial" || t.trialEndsAt || t.plan === "community").length ?? 0) > 1
      ? `${tenant.trial ? "Afterwards, one" : "One"} tenant continues on Community Free. You choose which.`
      : `${tenant.trial ? "Afterwards, this" : "This"} tenant continues on Community Free.`} Backups and settings are kept. Community keeps 30 days of backup history. No payment is needed.</p>
    {tenant.trial && <TrialContact tenant={tenant} initialEmail={initialEmail} />}
    <div className="flex flex-wrap gap-2">
      {welcome && <Button disabled={busy} onClick={() => void run("acknowledge")}>Got it</Button>}
      {welcome && tenant.canEnd && <Button variant="outline" disabled={busy} onClick={() => void run("end_trial")}>Use Community instead</Button>}
      {tenant.trialCanExtend && <Button variant="outline" disabled={busy} onClick={() => void run("extend_trial")}>Need more time? Extend 14 days</Button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </section>
}

function TrialAzureChoice() {
  const tenants = useTenants()
  const { updateTenant } = useTenantOperations()
  const { confirm } = useConfirm()
  const { status } = useLicense()
  return <>{tenants.filter(t => t.credentials && t.resources?.storageAccountName && !t.resources.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX) && status?.tenants.some(licensed => licensed.trialEndsAt && !licensed.entitled && licensed.tenantId === t.credentials?.tenantId?.toLowerCase())).map(t => <Button key={t.id} variant="outline" onClick={async () => {
    if (await confirm(LOCAL_SWITCH_CONFIRMATION)) updateTenant(t.id, changeTenantStorage(t, { kind: "local" }))
  }}>Switch {t.name} to weekly local backups</Button>)}</>
}

export function TrialChanges() {
  const { status } = useLicense()
  const tenants = useTenants()
  const [daily, setDaily] = useState(false)
  const [longHistory, setLongHistory] = useState(false)
  useEffect(() => {
    void bridge.schedules.list().then(schedules => setDaily(schedules.some(s => s.enabled && s.frequency === "daily" && status?.tenants.some(t => t.trialEndsAt && t.tenantId === s.tenantId)))).catch(() => {})
    void bridge.preferences.get().then(prefs => setLongHistory(prefs.retentionDays > 30)).catch(() => {})
  }, [status])
  const azure = tenants.some(t => t.resources?.storageAccountName && !t.resources.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX) && status?.tenants.some(licensed => licensed.trialEndsAt && licensed.tenantId === t.credentials?.tenantId?.toLowerCase()))
  return <ul className="list-disc space-y-1 pl-5 text-sm">
    {daily && <li>Your saved daily schedule runs weekly on Community.</li>}
    {azure && <li>Azure storage backups pause. <Link to="/portal/backup?tab=schedule">Switch to weekly local backups in Backup & Restore.</Link></li>}
    <li>Alerts, health review and change reports pause.</li>
    {longHistory && <li>Backup history returns to 30 days.</li>}
    {(status?.tenants.filter(t => t.trialEndsAt).length ?? 0) > 1 && <li>You choose which tenant continues on Community.</li>}
  </ul>
}

export function TenantTrialNotices() {
  const { status, refresh } = useLicense()
  if (!status) return null
  const welcome = status.tenants.find(t => t.source === "trial" && !t.trialAcknowledged)
  const ended = status.tenants.find(t => t.trialEndsAt && !t.entitled && Date.parse(t.trialEndsAt) <= Date.now() && !t.trialAcknowledged)
  const tenant = welcome ?? ended
  if (!tenant) return null
  return <div className="px-6 pt-5 lg:px-8">
    <TenantTrialCard tenant={tenant} welcome={Boolean(welcome)} />
    {ended && <div className="space-y-3 rounded-3xl bg-blue-50 p-6">
      <TrialChanges />
      <CommunityTenantChoiceButton />
      <TrialAzureChoice />
      <Button onClick={() => void openCheckout("trial-end")}>Buy Pro</Button>
      <Button variant="outline" onClick={async () => { await bridge.license.tenantTrialAction(tenant.tenantId, "acknowledge"); await refresh() }}>Continue on Community</Button>
    </div>}
  </div>
}
