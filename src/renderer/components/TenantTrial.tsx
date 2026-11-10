import { useEffect, useState, type ReactNode } from "react"
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

export function TenantTrialOptions({ onStarted, tenantId, compact = false, variant, size }: { onStarted?: () => void; tenantId?: string; compact?: boolean; variant?: "default" | "outline"; size?: "default" | "sm" } = {}) {
  const { status, refresh } = useLicense()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  if (!status || status.hasKey) return null
  const Container = compact ? "span" : "div"
  const Text = compact ? "span" : "p"
  return <Container className={compact ? "inline-flex flex-wrap items-center gap-3" : "space-y-3"}>
    {status.tenants.filter(t => (!tenantId || t.tenantId === tenantId) && t.signedIn && !t.entitled && (status.tenantTrialsEnabled || t.trialRefusal)).map(tenant => <Container key={tenant.tenantId} className={compact ? "inline-flex flex-wrap items-center gap-3" : "flex flex-wrap items-center gap-3"}>
      {!compact && tenant.trialRefusal && <Text role="status">{tenant.trialRefusal}</Text>}
      {tenant.activated ? <Text className="text-sm text-gray-600">Check the saved activation before starting a trial.</Text> : status.tenantTrialsEnabled && !(tenant.trialRefusalPermanent ?? Boolean(tenant.trialRefusal)) && <><Button variant={variant} size={size} disabled={busy} onClick={async () => {
        setBusy(true); setError("")
        try { await bridge.license.startTenantTrial(tenant.tenantId); await refresh(); onStarted?.() }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); await refresh() }
        finally { setBusy(false) }
      }}>Try Pro free</Button><Text className="text-sm text-gray-600">No card, no email. Starts right away, for this tenant.</Text></>}
    </Container>)}
    {error && <Text role="alert">{error}</Text>}
  </Container>
}

export function TrialContact({ tenant, initialEmail, allowUnknownRemoval = false }: { tenant: TenantLicenseStatus; initialEmail?: string; allowUnknownRemoval?: boolean }) {
  const { refresh } = useLicense()
  const [email, setEmail] = useState(tenant.trialEmail ?? initialEmail ?? "")
  const [saved, setSaved] = useState(Boolean(tenant.trialEmail))
  useEffect(() => setSaved(Boolean(tenant.trialEmail)), [tenant.trialEmail])
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
      setSaved(Boolean(address))
      setMessage(address ? "Email address saved." : "Email address removed.")
      await refresh()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div className="space-y-2">
    <div className="flex flex-col items-start gap-2 xl:flex-row xl:items-end">
      <label className="w-full min-w-0 flex-1 text-sm">Optional email
        <Input type="email" value={email} maxLength={254} onChange={event => setEmail(event.target.value)} />
      </label>
      <Button variant="outline" className="h-auto max-w-full whitespace-normal text-left" disabled={busy || !email.trim()} onClick={() => void save(email.trim())}>Email me setup tips and a reminder before the trial ends</Button>
    </div>
    {(saved || allowUnknownRemoval) && <Button variant="ghost" disabled={busy} onClick={() => void save()}>Remove the saved email address for this trial</Button>}
    <p className="text-xs text-gray-600">Your address is sent only when you press the button. <a href="https://www.tenuvault.com/privacy" target="_blank" rel="noreferrer">Privacy policy</a></p>
    {(message || tenant.trialEmail) && <p role="status">{message || "Email address saved."}</p>}
  </div>
}

export function TenantTrialCard({ tenant, initialEmail, welcome = false, allowUnknownContactRemoval = false, children }: { tenant: TenantLicenseStatus; initialEmail?: string; welcome?: boolean; allowUnknownContactRemoval?: boolean; children?: ReactNode }) {
  const { status, refresh } = useLicense()
  const name = useTenants().find(t => t.credentials?.tenantId?.toLowerCase() === tenant.tenantId)?.name
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const run = async (action: "acknowledge" | "end_trial" | "extend_trial") => {
    setBusy(true); setError(""); setNotice("")
    try {
      const updated = await bridge.license.tenantTrialAction(tenant.tenantId, action)
      if (action === "extend_trial") {
        const end = updated?.tenants.find(t => t.tenantId === tenant.tenantId)?.trialEndsAt
        setNotice(end ? `Trial extended. Ends on ${formatDate(end)}.` : "Trial extended.")
      }
      await refresh()
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); await refresh() }
    finally { setBusy(false) }
  }
  const days = Math.max(0, Math.ceil((Date.parse(tenant.trialEndsAt ?? "") - Date.now()) / 86400_000))
  return <section className="space-y-3 rounded-3xl bg-blue-50 p-6">
    <h2 className="text-xl font-medium">{welcome ? "Pro trial started" : tenant.trial ? "Pro trial" : "Pro trial ended"}{name && <span className="ml-2 text-sm font-normal text-gray-600">{name}</span>}</h2>
    <p>{days > 0 ? `${days} days left. Ends on ${formatDate(tenant.trialEndsAt!)}.` : `Ended on ${formatDate(tenant.trialEndsAt!)}.`}</p>
    {!tenant.trial && <p className="text-sm">{(status?.tenants.filter(t => !t.entitled && t.trialEndsAt).length ?? 0) > 1 ? "One tenant continues on Community Free. You choose which." : "This tenant continues on Community Free."} Backups and settings are kept. Community keeps 30 days of backup history.</p>}
    {welcome && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span className="font-medium">Try these first</span>
      <Link className="text-blue-700 underline-offset-4 hover:underline" to="/portal/backup?tab=schedule">Daily backup schedule</Link>
      <Link className="text-blue-700 underline-offset-4 hover:underline" to="/portal/backup?tab=restore">Full restore</Link>
      <Link className="text-blue-700 underline-offset-4 hover:underline" to="/portal/drift">Drift revert</Link>
      <Link className="text-blue-700 underline-offset-4 hover:underline" to="/portal/frameworks/cis-benchmarks">CIS Benchmarks</Link>
    </div>}
    {tenant.trial && <p className="text-sm">{(status?.tenants.filter(t => t.source === "trial" || t.trialEndsAt || t.plan === "community").length ?? 0) > 1
      ? `${tenant.trial ? "Afterwards, one" : "One"} tenant continues on Community Free. You choose which.`
      : `${tenant.trial ? "Afterwards, this" : "This"} tenant continues on Community Free.`} Backups and settings are kept. Community keeps 30 days of backup history. No payment is needed.</p>}
    {tenant.trial && <TrialContact tenant={tenant} initialEmail={initialEmail} allowUnknownRemoval={allowUnknownContactRemoval && !welcome} />}
    {children}
    <div className="flex flex-wrap gap-2">
      {welcome && <Button disabled={busy} onClick={() => void run("acknowledge")}>Got it</Button>}
      {welcome && tenant.canEnd && <Button variant="ghost" disabled={busy} onClick={() => void run("end_trial")}>Use Community instead</Button>}
      {tenant.trialCanExtend && <Button variant="outline" disabled={busy} onClick={() => void run("extend_trial")}>Need more time? Extend your trial</Button>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

function TrialAzureChoice() {
  const tenants = useTenants()
  const { updateTenant } = useTenantOperations()
  const { confirm, confirmDialog } = useConfirm()
  const { status } = useLicense()
  return <>{confirmDialog}{tenants.filter(t => t.credentials && t.resources?.storageAccountName && !t.resources.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX) && status?.tenants.some(licensed => licensed.trialEndsAt && !licensed.entitled && licensed.tenantId === t.credentials?.tenantId?.toLowerCase())).map(t => <Button key={t.credentials!.tenantId} variant="outline" onClick={async () => {
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

export function trialEndVisible(status: ReturnType<typeof useLicense>["status"]) {
  return Boolean(status?.tenants.some(t => t.trialEndsAt && !t.entitled && Date.parse(t.trialEndsAt) <= Date.now() && !t.trialAcknowledged))
}

export function TenantTrialNotices({ showWelcome = true }: { showWelcome?: boolean }) {
  const { status, refresh } = useLicense()
  if (!status) return null
  const welcome = showWelcome && status.tenants.find(t => t.entitled && t.source === "trial" && !t.trialAcknowledged)
  const ended = status.tenants.find(t => t.trialEndsAt && !t.entitled && Date.parse(t.trialEndsAt) <= Date.now() && !t.trialAcknowledged)
  if (!welcome && !ended) return null
  return <div className="space-y-3 px-6 pt-5 lg:px-8">
    {welcome && <TenantTrialCard key={`started-${welcome.tenantId}`} tenant={welcome} welcome />}
    {ended && <TenantTrialCard key={`ended-${ended.tenantId}`} tenant={ended}>
      <TrialChanges />
      <div className="flex flex-wrap items-center gap-2">
        <Button className="bg-coral-500 text-white hover:bg-coral-600" onClick={() => void openCheckout("trial-end")}>Buy Pro</Button>
        <Button variant="outline" onClick={async () => { await bridge.license.tenantTrialAction(ended.tenantId, "acknowledge"); await refresh() }}>Continue on Community</Button>
        <CommunityTenantChoiceButton />
        <TrialAzureChoice />
      </div>
    </TenantTrialCard>}
  </div>
}
