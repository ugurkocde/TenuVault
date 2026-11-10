import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { useTenantOperations, useTenants } from "~/contexts/TenantContext"
import type { TenantLicenseStatus } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { formatDate, useLicense } from "../lib/license"
import { openCheckout } from "../lib/purchase"
import { useTrialAction } from "../lib/trial-action"
import { SUPPORT_EMAIL, TRIAL_USED_MESSAGE, LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import { changeTenantStorage, LOCAL_SWITCH_CONFIRMATION } from "../lib/storage"
import { useConfirm } from "~/components/ConfirmDialog"
import { CommunityTenantChoiceButton } from "./CommunityTenantPicker"

export function TrialUsage({ tenant }: { tenant: TenantLicenseStatus }) {
  const [summary, setSummary] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setSummary(null)
    void Promise.resolve().then(() => bridge.license.trialUsage(tenant.tenantId)).then(value => { if (current) setSummary(value) }).catch(() => {})
    return () => { current = false }
  }, [tenant.tenantId, tenant.trialEndsAt, tenant.trialUsageRevision])
  return summary ? <p className="text-sm">{summary}</p> : null
}

export function TrialKeyRefusalActions({ message, tenant, source }: { message: string; tenant?: TenantLicenseStatus; source: string }) {
  return message.includes(TRIAL_USED_MESSAGE) ? <TrialActions tenant={tenant} source={source} /> : null
}

export function TrialActions({ tenant, source, welcome = false }: { tenant?: TenantLicenseStatus; source: string; welcome?: boolean }) {
  const { status } = useLicense()
  const { busy, error, run } = useTrialAction()
  const [notice, setNotice] = useState("")
  const [action, setAction] = useState<"buy" | "extend" | null>(null)
  const [extended, setExtended] = useState(false)
  const days = status?.tenantTrialPolicy?.extensionDays
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("TenuVault Pro: quote or invoice")}`
  return <div className="min-w-0 space-y-2 text-sm font-normal">
    <div className="flex flex-wrap items-center gap-2">
      {!welcome && <Button type="button" size="sm" disabled={busy} onClick={() => { setAction("buy"); void run(() => openCheckout(source)).finally(() => setAction(null)) }}>Buy Pro</Button>}
      {!welcome && tenant?.trialCanExtend && !extended && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setAction("extend"); void run(async () => {
        const updated = await bridge.license.tenantTrialAction(tenant.tenantId, "extend_trial")
        const end = updated?.tenants.find(t => t.tenantId === tenant.tenantId)?.trialEndsAt
        setExtended(true)
        setNotice(end ? `Trial extended. Ends on ${formatDate(end)}.` : "Trial extended.")
      }).finally(() => setAction(null)) }}>{busy && action === "extend" ? "Extending trial..." : days ? `Extend trial by ${days} days` : "Extend your trial"}</Button>}
      {tenant?.trialExtensionAvailableAt && Date.parse(tenant.trialExtensionAvailableAt) > Date.now() && !extended && <p>You can extend once, from {formatDate(tenant.trialExtensionAvailableAt)}.</p>}
      {tenant && !tenant.trialCanExtend && !tenant.trialExtensionAvailableAt && !tenant.trialExtensionUnavailable && tenant.source === "trial" && !extended && <p>Check the License page for trial extension availability.</p>}
      {welcome && tenant?.trialCanExtend && <p>You can extend your trial once, from the License page.</p>}
    </div>
    <p>Questions, or need a quote or an invoice for your purchasing team? Write to <a className="text-blue-700 underline" href={mailto} onClick={event => { event.preventDefault(); void bridge.app.openExternal(mailto) }}>{SUPPORT_EMAIL}</a>.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}

export function TenantTrialOptions({ onStarted, tenantId, compact = false, variant, size }: { onStarted?: () => void; tenantId?: string; compact?: boolean; variant?: "default" | "outline"; size?: "default" | "sm" } = {}) {
  const { status } = useLicense()
  const { busy, error, run } = useTrialAction()
  if (!status || status.hasKey) return null
  const Container = compact ? "span" : "div"
  const Text = compact ? "span" : "p"
  return <Container className={compact ? "inline-flex flex-wrap items-center gap-3" : "space-y-3"}>
    {status.tenants.filter(t => (!status?.tenantTrialsEnabled || !tenantId || t.tenantId === tenantId) && t.signedIn && !t.entitled && t.message !== TRIAL_USED_MESSAGE && (status.tenantTrialsEnabled || t.trialRefusal)).map(tenant => <Container key={tenant.tenantId} className={compact ? "inline-flex flex-wrap items-center gap-3" : "flex flex-wrap items-center gap-3"}>
      {!compact && tenant.trialRefusal && <Text role="status">{tenant.trialRefusal}</Text>}
      {tenant.activated ? <Text className="text-sm text-gray-600">Check the saved activation before starting a trial.</Text> : status.tenantTrialsEnabled && !(tenant.trialRefusalPermanent ?? Boolean(tenant.trialRefusal)) && <><Button variant={variant} size={size} disabled={busy} onClick={() => void run(async () => {
        await bridge.license.startTenantTrial(tenant.tenantId)
        await onStarted?.()
      })}>Try Pro free</Button><Text className="text-sm text-gray-600">No card, no email. Starts right away, for this tenant.</Text></>}
    </Container>)}
    {error && <Text role="alert">{error}</Text>}
  </Container>
}

export function TrialContact({ tenant, initialEmail, allowUnknownRemoval = false }: { tenant: TenantLicenseStatus; initialEmail?: string; allowUnknownRemoval?: boolean }) {
  const { busy, error, run } = useTrialAction()
  const [email, setEmail] = useState(tenant.trialEmail ?? initialEmail ?? "")
  const [saved, setSaved] = useState(Boolean(tenant.trialEmail))
  useEffect(() => setSaved(Boolean(tenant.trialEmail)), [tenant.trialEmail])
  const [message, setMessage] = useState("")
  useEffect(() => {
    if (tenant.trialEmail || initialEmail) return
    let current = true
    void bridge.auth.accounts().then(accounts => {
      const account = accounts.find(a => a.tenantId.toLowerCase() === tenant.tenantId)
      if (current && account?.username) setEmail(value => value || account.username)
    }).catch(() => {})
    return () => { current = false }
  }, [tenant.tenantId, tenant.trialEmail, initialEmail])
  const save = (address?: string) => run(async () => {
    setMessage("")
    await bridge.license.tenantTrialAction(tenant.tenantId, "trial_contact", address)
    setSaved(Boolean(address))
    setMessage(address ? "Email address saved." : "Email address removed.")
  })
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
    {error && <p role="alert">{error}</p>}
  </div>
}

export function TenantTrialCard({ tenant, initialEmail, welcome = false, allowUnknownContactRemoval = false, children }: { tenant: TenantLicenseStatus; initialEmail?: string; welcome?: boolean; allowUnknownContactRemoval?: boolean; children?: ReactNode }) {
  const { status } = useLicense()
  const { busy, error, run: perform } = useTrialAction()
  const name = useTenants().find(t => t.credentials?.tenantId?.toLowerCase() === tenant.tenantId)?.name
  const [notice, setNotice] = useState("")
  const run = (action: "acknowledge" | "end_trial" | "extend_trial") => perform(async () => {
    const updated = await bridge.license.tenantTrialAction(tenant.tenantId, action)
    if (action === "extend_trial") {
      const end = updated?.tenants.find(t => t.tenantId === tenant.tenantId)?.trialEndsAt
      setNotice(end ? `Trial extended. Ends on ${formatDate(end)}.` : "Trial extended.")
    }
  })
  const days = Math.max(0, Math.ceil((Date.parse(tenant.trialEndsAt ?? "") - Date.now()) / 86400_000))
  return <section className="space-y-3 rounded-3xl bg-blue-50 p-6">
    <h2 className="text-xl font-medium">{welcome ? "Pro trial started" : tenant.trial ? "Pro trial" : "Pro trial ended"}{name && <span className="ml-2 text-sm font-normal text-gray-600">{name}</span>}</h2>
    <p>{days > 0 ? `${days} days left. Ends on ${formatDate(tenant.trialEndsAt!)}.` : `Ended on ${formatDate(tenant.trialEndsAt!)}.`}</p>
    {!welcome && status?.tenantTrialsEnabled && <TrialUsage tenant={tenant} />}
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
    {status?.tenantTrialsEnabled && <TrialActions tenant={tenant} source={tenant.trial ? "license-page-trial" : "trial-end"} welcome={welcome} />}
    {children}
    <div className="flex flex-wrap gap-2">
      {welcome && <Button disabled={busy} onClick={() => void run("acknowledge")}>Got it</Button>}
      {welcome && tenant.canEnd && <Button variant="ghost" disabled={busy} onClick={() => void run("end_trial")}>Use Community instead</Button>}
    </div>
    {!status?.tenantTrialsEnabled && tenant.trialCanExtend && <Button variant="outline" disabled={busy} onClick={() => void run("extend_trial")}>Need more time? Extend your trial</Button>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}

function TrialAzureChoice() {
  const tenants = useTenants()
  const { updateTenant } = useTenantOperations()
  const { confirm, confirmDialog } = useConfirm()
  const { busy, error, run } = useTrialAction()
  const { status } = useLicense()
  return <>{confirmDialog}{tenants.filter(t => t.credentials && t.resources?.storageAccountName && !t.resources.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX) && status?.tenants.some(licensed => licensed.trialEndsAt && !licensed.entitled && licensed.tenantId === t.credentials?.tenantId?.toLowerCase())).map(t => <Button key={t.credentials!.tenantId} variant="outline" disabled={busy} onClick={() => void run(async () => {
    if (await confirm(LOCAL_SWITCH_CONFIRMATION)) await updateTenant(t.id, changeTenantStorage(t, { kind: "local" }))
  })}>Switch {t.name} to weekly local backups</Button>)}{error && <p role="alert" className="basis-full text-sm">{error}</p>}</>
}

export function TrialChanges({ tenantId }: { tenantId?: string }) {
  const { status } = useLicense()
  const tenants = useTenants()
  const [daily, setDaily] = useState(false)
  const [workflows, setWorkflows] = useState(false)
  const [longHistory, setLongHistory] = useState(false)
  const trialIds = (status?.tenants.filter(t => t.trialEndsAt && (!tenantId || t.tenantId === tenantId)).map(t => t.tenantId) ?? []).sort().join(",")
  useEffect(() => {
    let active = true
    const ids = trialIds ? trialIds.split(",") : []
    setWorkflows(false)
    void Promise.resolve().then(() => Promise.all(ids.map(id => bridge.license.trialWorkflowsConfigured(id)))).then(values => { if (active) setWorkflows(values.some(Boolean)) }).catch(() => { if (active) setWorkflows(false) })
    return () => { active = false }
  }, [trialIds])
  useEffect(() => {
    void bridge.schedules.list().then(schedules => setDaily(schedules.some(s => s.enabled && s.frequency === "daily" && status?.tenants.some(t => t.trialEndsAt && (!status?.tenantTrialsEnabled || !tenantId || t.tenantId === tenantId) && t.tenantId === s.tenantId)))).catch(() => {})
    void bridge.preferences.get().then(prefs => setLongHistory(prefs.retentionDays > 30)).catch(() => {})
  }, [status, tenantId])
  const azure = tenants.some(t => t.resources?.storageAccountName && !t.resources.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX) && status?.tenants.some(licensed => licensed.trialEndsAt && (!status?.tenantTrialsEnabled || !tenantId || licensed.tenantId === tenantId) && licensed.tenantId === t.credentials?.tenantId?.toLowerCase()))
  return <ul className="list-disc space-y-1 pl-5 text-sm">
    {daily && <li>Your saved daily schedule runs weekly on Community.</li>}
    {azure && <li>Azure storage backups pause. <Link to="/portal/backup?tab=schedule">Switch to weekly local backups in Backup & Restore.</Link></li>}
    {workflows && <li>Alerts, health review and change reports pause.</li>}
    {longHistory && <li>Backup history returns to 30 days.</li>}
    {(status?.tenants.filter(t => t.trialEndsAt).length ?? 0) > 1 && <li>You choose which tenant continues on Community.</li>}
  </ul>
}

export function trialEndVisible(status: ReturnType<typeof useLicense>["status"]) {
  return Boolean(status?.tenants.some(t => t.trialEndsAt && !t.entitled && Date.parse(t.trialEndsAt) <= Date.now() && !t.trialAcknowledged))
}

export function TenantTrialNotices({ showWelcome = true }: { showWelcome?: boolean }) {
  const { status } = useLicense()
  const { busy, error, run } = useTrialAction()
  if (!status) return null
  const welcome = showWelcome && status.tenants.find(t => t.entitled && t.source === "trial" && !t.trialAcknowledged)
  const ended = status.tenants.find(t => t.trialEndsAt && !t.entitled && Date.parse(t.trialEndsAt) <= Date.now() && !t.trialAcknowledged)
  if (!welcome && !ended) return null
  return <div className="space-y-3 px-6 pt-5 lg:px-8">
    {welcome && <TenantTrialCard key={`started-${welcome.tenantId}`} tenant={welcome} welcome />}
    {ended && <TenantTrialCard key={`ended-${ended.tenantId}`} tenant={ended}>
      <TrialChanges tenantId={ended.tenantId} />
      <div className="flex flex-wrap items-center gap-2">
        {!status.tenantTrialsEnabled && <Button className="bg-coral-500 text-white hover:bg-coral-600" disabled={busy} onClick={() => void run(() => openCheckout("trial-end"))}>Buy Pro</Button>}
        <Button variant="outline" disabled={busy} onClick={() => void run(() => bridge.license.tenantTrialAction(ended.tenantId, "acknowledge"))}>Continue on Community</Button>
        <CommunityTenantChoiceButton />
        <TrialAzureChoice />
      </div>
      {error && <p role="alert">{error}</p>}
    </TenantTrialCard>}
  </div>
}
