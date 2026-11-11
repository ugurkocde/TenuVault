import { ORGANIZATION_LICENSE_GUIDANCE, ORGANIZATION_LICENSE_SETUP_GUIDANCE } from "../../shared/constants"
import { organizationLicenseRefusal } from "../../shared/trial-notices"
import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { CalendarClock, GitCompareArrows, History, Hourglass, Info, Mail, ShieldCheck, Sparkles, X } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
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

type LicenseStatusValue = ReturnType<typeof useLicense>["status"]

/** What happens when a running trial ends, for the card and the setup row. */
export function trialEndText(status: LicenseStatusValue, tenant: TenantLicenseStatus): string {
  // Community Free covers one tenant. Once another tenant holds it, the end of this trial
  // opens no choice: this tenant then needs a license.
  if (status?.communityTenantId && status.communityTenantId !== tenant.tenantId)
    return "When the trial ends, this tenant needs a license: Community Free covers one tenant and another tenant already uses it. Backups and settings are kept."
  return `${(status?.tenants.filter(t => t.source === "trial" || t.trialEndsAt || t.plan === "community").length ?? 0) > 1
    ? "When the trial ends, you choose which one tenant continues on Community Free."
    : "When the trial ends, this tenant continues on Community Free by itself."} Backups and settings are kept. Community keeps 30 days of backup history.`
}

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

export function TrialActions({ tenant, source }: { tenant?: TenantLicenseStatus; source: string }) {
  const { status } = useLicense()
  const { busy, error, run } = useTrialAction()
  const [notice, setNotice] = useState("")
  const [action, setAction] = useState<"buy" | "extend" | null>(null)
  const [extended, setExtended] = useState(false)
  const days = status?.tenantTrialPolicy?.extensionDays
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("TenuVault Pro: quote or invoice")}`
  return <div className="min-w-0 space-y-2 text-sm font-normal">
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" disabled={busy} onClick={() => { setAction("buy"); void run(() => openCheckout(source)).finally(() => setAction(null)) }}>Buy Pro</Button>
      {tenant?.trialCanExtend && !extended && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setAction("extend"); void run(async () => {
        const updated = await bridge.license.tenantTrialAction(tenant.tenantId, "extend_trial")
        const end = updated?.tenants.find(t => t.tenantId === tenant.tenantId)?.trialEndsAt
        setExtended(true)
        setNotice(end ? `Trial extended. Ends on ${formatDate(end)}.` : "Trial extended.")
      }).finally(() => setAction(null)) }}>{busy && action === "extend" ? "Extending trial..." : days ? `Extend trial by ${days} days` : "Extend your trial"}</Button>}
      {tenant?.trialExtensionAvailableAt && Date.parse(tenant.trialExtensionAvailableAt) > Date.now() && !extended && <p className="text-gray-600">You can extend once, from {formatDate(tenant.trialExtensionAvailableAt)}.</p>}
      {tenant && !tenant.trialCanExtend && !tenant.trialExtensionAvailableAt && !tenant.trialExtensionUnavailable && tenant.source === "trial" && !extended && <p className="text-gray-600">Check the License page for trial extension availability.</p>}
    </div>
    <p className="text-gray-600">Questions, or need a quote or an invoice for your purchasing team? Write to <a className="font-medium text-blue-700 underline underline-offset-2" href={mailto} onClick={event => { event.preventDefault(); void bridge.app.openExternal(mailto) }}>{SUPPORT_EMAIL}</a>.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}

/** Switches back to a trial this installation ended early. Offered until the trial's original end; resuming adds no time. */
export function TrialResume({ tenant, compact = false, variant, size, onResumed, action }: {
  tenant: TenantLicenseStatus; compact?: boolean; variant?: "default" | "outline"; size?: "default" | "sm"; onResumed?: () => void
  /** The caller's action state. A caller that outlives this offer passes it and shows the error itself: a refusal removes the offer. */
  action?: ReturnType<typeof useTrialAction>
}) {
  const own = useTrialAction()
  const { busy, run } = action ?? own
  const error = action ? "" : own.error
  if (!tenant.trialCanResume || !tenant.trialResumeUntil) return null
  const days = Math.max(1, Math.ceil((Date.parse(tenant.trialResumeUntil) - Date.now()) / 86400_000))
  const left = `${days} ${days === 1 ? "day" : "days"} left`
  const Container = compact ? "span" : "div"
  const Text = compact ? "span" : "p"
  return <Container className={compact ? "inline-flex flex-wrap items-center gap-3" : "flex flex-wrap items-center gap-3"}>
    <Button type="button" variant={variant} size={size} disabled={busy} onClick={() => void run(async () => {
      await bridge.license.tenantTrialAction(tenant.tenantId, "resume_trial")
      await onResumed?.()
    })}>{busy ? "Resuming trial..." : "Resume Pro trial"}</Button>
    <Text className="text-sm text-gray-600">{compact
      ? `${left}, until ${formatDate(tenant.trialResumeUntil)}.`
      : `You ended the Pro trial for this tenant early. You can switch back until ${formatDate(tenant.trialResumeUntil)} (${left}). No card, no email.`}</Text>
    {error && <Text role="alert">{error}</Text>}
  </Container>
}

/**
 * The tenant trial per signed-in tenant without a license. `setupTenantId` is the tenant the setup
 * wizard is connecting, which is not saved yet. `guidanceInRows` is for a page whose tenant rows
 * already explain a license that was shared through another app registration.
 */
export function TenantTrialOptions({ onStarted, tenantId, setupTenantId, guidanceInRows = false, compact = false, variant, size }: { onStarted?: () => void; tenantId?: string; setupTenantId?: string; guidanceInRows?: boolean; compact?: boolean; variant?: "default" | "outline"; size?: "default" | "sm" } = {}) {
  const { status } = useLicense()
  const { busy, error, run } = useTrialAction()
  // Kept here and not in the offer: a resume the service refuses for good removes the offer,
  // and the reason has to stay on screen.
  const resume = useTrialAction()
  if (!status || status.hasKey) return null
  const Container = compact ? "span" : "div"
  const Text = compact ? "span" : "p"
  return <Container className={compact ? "inline-flex flex-wrap items-center gap-3" : "space-y-3"}>
    {status.tenants.filter(t => t.signedIn && !t.entitled && t.message !== TRIAL_USED_MESSAGE
      // A caller that asks for one tenant, a plan prompt, gets that tenant only.
      && (!tenantId || t.tenantId === tenantId)
      // A resume is offered whether or not the trial switch is known.
      && (t.trialCanResume || status.tenantTrialsEnabled || t.trialRefusal)).map(tenant => <Container key={tenant.tenantId} className={compact ? "inline-flex flex-wrap items-center gap-3" : "flex flex-wrap items-center gap-3"}>
      {tenant.trialCanResume ? <TrialResume tenant={tenant} compact={compact} variant={variant} size={size} onResumed={onStarted} action={resume} /> : <>
        {(!compact || organizationLicenseRefusal(tenant)) && tenant.trialRefusal && !(guidanceInRows && organizationLicenseRefusal(tenant)) && <Text role="status" className={organizationLicenseRefusal(tenant) ? "text-sm text-gray-700" : undefined}>{organizationLicenseRefusal(tenant) ? (tenant.tenantId === setupTenantId ? ORGANIZATION_LICENSE_SETUP_GUIDANCE : ORGANIZATION_LICENSE_GUIDANCE) : tenant.trialRefusal}</Text>}
        {tenant.activated ? <Text className="text-sm text-gray-600">Check the saved activation before starting a trial.</Text> : status.tenantTrialsEnabled && !organizationLicenseRefusal(tenant) && !(tenant.trialRefusalPermanent ?? Boolean(tenant.trialRefusal)) && <><Button variant={variant} size={size} disabled={busy} onClick={() => void run(async () => {
          await bridge.license.startTenantTrial(tenant.tenantId)
          await onStarted?.()
        })}>Try Pro free</Button><Text className="text-sm text-gray-600">No card, no email. Starts right away, for this tenant.</Text></>}
      </>}
    </Container>)}
    {error && <Text role="alert">{error}</Text>}
    {resume.error && <Text role="alert">{resume.error}</Text>}
  </Container>
}

export function TrialContact({ tenant, initialEmail, allowUnknownRemoval = false, stacked = false }: { tenant: TenantLicenseStatus; initialEmail?: string; allowUnknownRemoval?: boolean; /** For a narrow column: the button goes under the field. */ stacked?: boolean }) {
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
  return <div className="space-y-3 rounded-2xl bg-gray-50 p-4">
    <div className={stacked ? "flex flex-col items-start gap-2" : "flex flex-col items-stretch gap-2 xl:flex-row xl:items-end"}>
      <label className="flex w-full min-w-0 flex-1 flex-col gap-1.5 text-sm font-medium">Optional email
        <Input type="email" className="font-normal" value={email} maxLength={254} onChange={event => setEmail(event.target.value)} />
      </label>
      <Button variant="outline" className="h-auto min-h-10 max-w-full whitespace-normal text-left" disabled={busy || !email.trim()} onClick={() => void save(email.trim())}><Mail />Email me setup tips and a reminder before the trial ends</Button>
    </div>
    {(saved || allowUnknownRemoval) && <Button variant="ghost" size="sm" className="h-auto px-0 text-gray-600 underline-offset-4 hover:bg-transparent hover:underline dark:hover:bg-transparent" disabled={busy} onClick={() => void save()}>Remove the saved email address for this trial</Button>}
    <p className="text-xs text-gray-500">Your address is sent only when you press the button. <a className="underline underline-offset-2" href="https://www.tenuvault.com/privacy" target="_blank" rel="noreferrer">Privacy policy</a></p>
    {(message || tenant.trialEmail) && <p role="status">{message || "Email address saved."}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}

export function TenantTrialCard({ tenant, initialEmail, welcome = false, allowUnknownContactRemoval = false, children }: { tenant: TenantLicenseStatus; initialEmail?: string; welcome?: boolean; allowUnknownContactRemoval?: boolean; children?: ReactNode }) {
  const { status } = useLicense()
  const { busy, error, run: perform } = useTrialAction()
  const name = useTenants().find(t => t.credentials?.tenantId?.toLowerCase() === tenant.tenantId)?.name
  const [notice, setNotice] = useState("")
  const run = (action: "acknowledge" | "extend_trial") => perform(async () => {
    const updated = await bridge.license.tenantTrialAction(tenant.tenantId, action)
    if (action === "extend_trial") {
      const end = updated?.tenants.find(t => t.tenantId === tenant.tenantId)?.trialEndsAt
      setNotice(end ? `Trial extended. Ends on ${formatDate(end)}.` : "Trial extended.")
    }
  })
  // Ending moves the tenant to Community at once, so the admin confirms it first. Until the
  // trial's own end this installation can switch back on the License page.
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [endError, setEndError] = useState("")
  const endTrial = () => perform(async () => {
    setEndError("")
    try {
      await bridge.license.tenantTrialAction(tenant.tenantId, "end_trial")
      setConfirmEnd(false)
    } catch (error) {
      setEndError(error instanceof Error ? error.message : String(error))
    }
  })
  const days = Math.max(0, Math.ceil((Date.parse(tenant.trialEndsAt ?? "") - Date.now()) / 86400_000))
  // The welcome asks for no decision: it can only be hidden. Ending the trial early is offered on
  // the License page, where the card is shown without the welcome.
  const canEnd = !welcome && tenant.trial && tenant.canEnd
  const footer = canEnd || (!status?.tenantTrialsEnabled && tenant.trialCanExtend)
  const shortcut = "inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 [&_svg]:size-4 [&_svg]:text-blue-700"
  return <section className="overflow-hidden rounded-3xl border border-gray-200 bg-white">
    <header className="tv-trial-header flex flex-wrap items-center justify-between gap-4 px-6 py-5">
      <div className="flex min-w-0 items-center gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-blue-100 bg-white text-blue-700">{days > 0 ? <Sparkles className="size-5" /> : <Hourglass className="size-5" />}</span>
        <div className="min-w-0">
          <h2 className="text-xl font-medium">{welcome ? "Pro trial started" : tenant.trial ? "Pro trial" : "Pro trial ended"}{name && <span className="ml-2 text-sm font-normal text-gray-600">{name}</span>}</h2>
          <p className="text-sm text-gray-600">{days > 0 ? `Ends on ${formatDate(tenant.trialEndsAt!)}.` : `Ended on ${formatDate(tenant.trialEndsAt!)}.`}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {days > 0 && <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-100 bg-white px-3 py-1 text-sm font-medium text-blue-700"><CalendarClock className="size-4" /><span><span className="tabular-nums">{days}</span> {days === 1 ? "day" : "days"} left</span></span>}
        {welcome && <Button type="button" variant="ghost" size="icon" className="size-9 rounded-full" disabled={busy} onClick={() => void run("acknowledge")}><X aria-hidden="true" /><span className="sr-only">Dismiss Pro trial message</span></Button>}
      </div>
    </header>
    <div className="space-y-5 px-6 py-5">
      {!welcome && status?.tenantTrialsEnabled && <TrialUsage tenant={tenant} />}
      {!tenant.trial && <p className="text-sm text-gray-600">{(status?.tenants.filter(t => !t.entitled && t.trialEndsAt).length ?? 0) > 1 ? "One tenant continues on Community Free. You choose which." : "This tenant continues on Community Free."} Backups and settings are kept. Community keeps 30 days of backup history.</p>}
      {welcome && <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Try these first</div>
        <div className="flex flex-wrap gap-2">
          <Link className={shortcut} to="/portal/backup?tab=schedule"><CalendarClock />Daily backup schedule</Link>
          <Link className={shortcut} to="/portal/backup?tab=restore"><History />Full restore</Link>
          <Link className={shortcut} to="/portal/drift"><GitCompareArrows />Drift revert</Link>
          <Link className={shortcut} to="/portal/frameworks/cis-benchmarks"><ShieldCheck />CIS Benchmarks</Link>
        </div>
      </div>}
      {tenant.trial && <p className="flex gap-2 text-sm text-gray-600"><Info className="mt-0.5 size-4 shrink-0 text-gray-500" /><span>Nothing is charged and no card is on file. {trialEndText(status, tenant)}</span></p>}
      {tenant.trial && <TrialContact tenant={tenant} initialEmail={initialEmail} allowUnknownRemoval={allowUnknownContactRemoval && !welcome} />}
      {!welcome && status?.tenantTrialsEnabled && <TrialActions tenant={tenant} source={tenant.trial ? "license-page-trial" : "trial-end"} />}
      {children}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {error && <p role="alert" className="text-sm">{error}</p>}
    </div>
    {footer && <footer className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-6 py-4">
      {canEnd && <Button variant="ghost" disabled={busy} onClick={() => { setEndError(""); setConfirmEnd(true) }}>Use Community instead</Button>}
      {!status?.tenantTrialsEnabled && tenant.trialCanExtend && <Button variant="outline" disabled={busy} onClick={() => void run("extend_trial")}>Need more time? Extend your trial</Button>}
    </footer>}
    <Dialog open={confirmEnd} onOpenChange={open => { if (!open && !busy) setConfirmEnd(false) }}>
      <DialogContent hideClose={busy}>
        <DialogHeader>
          <DialogTitle>End the Pro trial now?</DialogTitle>
          <DialogDescription>This tenant moves to Community Free right away. {tenant.trialEndsAt ? `You can switch back to the Pro trial on the License page until ${formatDate(tenant.trialEndsAt)}. After that it cannot be started again.` : "The trial cannot be started again for this tenant."} Backups and settings are kept. Community keeps 30 days of backup history.</DialogDescription>
        </DialogHeader>
        {(endError || error) && <p role="alert" className="text-sm text-red-700">{endError ? `${endError} The trial is still running.` : error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmEnd(false)}>Keep the trial</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void endTrial()}>{busy ? "Ending trial..." : "End trial and use Community"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </section>
}

/**
 * The trial in the setup's Storage step: one compact row above the storage choice, with the
 * optional email. It asks for no decision; the full card with its shortcuts follows the first
 * backup, and ending the trial early is offered on the License page.
 */
export function TrialStartedRow({ tenant, initialEmail }: { tenant: TenantLicenseStatus; initialEmail?: string }) {
  const { status } = useLicense()
  const days = Math.max(1, Math.ceil((Date.parse(tenant.trialEndsAt ?? "") - Date.now()) / 86400_000))
  return <section aria-label="Pro trial" className="space-y-3 rounded-3xl border border-gray-200 p-5">
    <p className="flex items-start gap-3 text-sm text-gray-700">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-700" aria-hidden="true"><Sparkles className="size-4" /></span>
      <span>
        <span className="block font-medium text-gray-900">Pro trial started: {days} {days === 1 ? "day" : "days"}, until {formatDate(tenant.trialEndsAt!)}</span>
        Nothing is charged and no card is on file. {trialEndText(status, tenant)}
      </span>
    </p>
    <TrialContact tenant={tenant} initialEmail={initialEmail} stacked />
  </section>
}

/** What the Pro trial adds, offered once the first backup is done. */
export function TrialShortcuts({ tenantId }: { tenantId: string }) {
  const { status } = useLicense()
  const tenant = status?.tenants.find(t => t.tenantId === tenantId.toLowerCase())
  if (!tenant?.trial || tenant.source !== "trial") return null
  const shortcut = "inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 [&_svg]:size-4 [&_svg]:text-blue-700"
  return <div className="space-y-2">
    <p className="text-sm font-medium text-gray-900">Also in your Pro trial</p>
    <div className="flex flex-wrap gap-2">
      <Link className={shortcut} to="/portal/backup?tab=restore"><History />Full restore</Link>
      <Link className={shortcut} to="/portal/drift"><GitCompareArrows />Drift revert</Link>
      <Link className={shortcut} to="/portal/frameworks/cis-benchmarks"><ShieldCheck />CIS Benchmarks</Link>
    </div>
  </div>
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
