import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Bell, Check, CheckCircle2, ChevronLeft, Cloud, Copy, ExternalLink, Loader2, Mail, Monitor, TriangleAlert, WandSparkles } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip, Tile } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { LOCAL_STORAGE_PREFIX } from "../../../shared/constants"
import { buildSetupAlerts, DEFAULT_SETUP_CHOICES, parseWatcherSetup, setupState, setupWatchNeeds, watcherSetupCommand, WATCHER_GUIDE_URL, type SetupChoices } from "../../../shared/notifications/setup"
import { bridge } from "../../lib/bridge"
import { settingsHref } from "../../lib/settings-section"
import { toast } from "../../lib/toast"
import { CHANNEL_KIND_LABELS, notificationsApi, type NotificationsStatus } from "./api"
import { useOptionalPermission } from "./optional-permissions"

type Destination = "existing" | "local" | "teams" | "email"
type Phase = "idle" | "running" | "failed" | "done"

const STEPS = ["Where alerts go", "What alerts you", "While this computer is off", "Review and turn on"] as const
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const MISSING_LABELS: Record<string, string> = {
  destination: "No destination yet",
  alert: "No working alert yet",
  "intune-watching": "Intune change watching is off",
  "conditional-access-watching": "Conditional Access change watching is off",
}

/**
 * The first-run card on the Alerts tab: what is missing, in order, and one button that
 * fixes it. Shown only while the setup cannot send; a working setup needs no banner.
 */
export function SetupStatusCard({ tenant, data, onChanged }: { tenant: Tenant; data: NotificationsStatus; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const state = setupState(data)
  if (!data.licensed || state.complete) return null
  const started = data.channels.length > 0 || data.rules.length > 0
  return (
    <Tile aria-labelledby="alerts-setup-heading" className="gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id="alerts-setup-heading" className="text-lg font-medium text-gray-900">
            {started ? "Finish setting up alerts" : "Set up alerts in about a minute"}
          </h3>
          <p className="max-w-2xl text-sm text-gray-700">
            Pick where alerts go and what should alert you. TenuVault creates the alerts, turns on change watching and
            sends a test. Every option stays editable afterwards in the tabs below.
          </p>
        </div>
        <Button type="button" onClick={() => setOpen(true)}>
          <WandSparkles className="h-4 w-4" aria-hidden="true" />
          {started ? "Finish setup" : "Set up alerts"}
        </Button>
      </div>
      <ul className="space-y-1.5 text-sm" aria-label="What is still missing">
        <StatusLine done={state.hasDestination} label={state.hasDestination ? "Destination ready" : MISSING_LABELS.destination!} />
        <StatusLine done={state.hasWorkingAlert} label={state.hasWorkingAlert ? "An alert can send" : MISSING_LABELS.alert!} />
        {state.watching.intune !== null && <StatusLine done={state.watching.intune} label={state.watching.intune ? "Intune changes are watched" : MISSING_LABELS["intune-watching"]!} />}
        {state.watching.conditionalAccess !== null && (
          <StatusLine done={state.watching.conditionalAccess} label={state.watching.conditionalAccess ? "Conditional Access changes are watched" : MISSING_LABELS["conditional-access-watching"]!} />
        )}
      </ul>
      {open && <SetupWizard tenant={tenant} data={data} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </Tile>
  )
}

function StatusLine({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      {done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-700" aria-hidden="true" /> : <span className="size-4 shrink-0 rounded-full border border-gray-300" aria-hidden="true" />}
      <span className={done ? "text-gray-700" : "font-medium text-gray-900"}>{label}</span>
    </li>
  )
}

function OptionCard({ selected, disabled, onSelect, icon, title, description, children }: {
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  icon: React.ReactNode
  title: string
  description: string
  children?: React.ReactNode
}) {
  return (
    <div className={`rounded-lg border p-4 ${selected ? "border-gray-900 dark:border-gray-200" : "border-gray-200 dark:border-gray-800"} ${disabled ? "opacity-60" : ""}`}>
      <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect} className="flex w-full items-start gap-3 rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed">
        <span aria-hidden="true" className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-gray-400">
          {selected && <span className="size-2.5 rounded-full bg-gray-900 dark:bg-gray-100" />}
        </span>
        <span className="space-y-0.5">
          <span className="flex items-center gap-2 text-sm font-medium text-gray-900">{icon}{title}</span>
          <span className="block text-sm text-gray-700">{description}</span>
        </span>
      </button>
      {selected && children}
    </div>
  )
}

/** The guided first setup. Advanced options stay in the tabs; this only makes the calls they make, in order. */
export function SetupWizard({ tenant, data, onClose, onChanged }: { tenant: Tenant; data: NotificationsStatus; onClose: () => void; onChanged: () => void }) {
  const enabledChannels = data.channels.filter((channel) => channel.enabled)
  const [step, setStep] = useState(0)
  const [destination, setDestination] = useState<Destination>(enabledChannels.length ? "existing" : "local")
  const [existingId, setExistingId] = useState(enabledChannels[0]?.id ?? "")
  const [teamsUrl, setTeamsUrl] = useState("")
  const [email, setEmail] = useState("")
  const [choices, setChoices] = useState<SetupChoices>(DEFAULT_SETUP_CHOICES)
  const [azure, setAzure] = useState<"later" | "guided">("later")
  const [alertEmail, setAlertEmail] = useState("")
  const [pasted, setPasted] = useState("")
  const [phase, setPhase] = useState<Phase>("idle")
  const [progress, setProgress] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [testWarning, setTestWarning] = useState<string | null>(null)
  const [createdChannelId, setCreatedChannelId] = useState<string | null>(null)
  const [createdTitles, setCreatedTitles] = useState<string[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const mailPermission = useOptionalPermission(tenant, "notificationEmail")

  const tenantId = tenant.credentials?.tenantId ?? ""
  const storageAccount = tenant.resources?.storageAccountName ?? ""
  const localStorage = !storageAccount || storageAccount.startsWith(LOCAL_STORAGE_PREFIX) || storageAccount === "local"
  const alerts = useMemo(() => buildSetupAlerts(choices), [choices])
  const needs = setupWatchNeeds(choices)
  const watcherSetup = pasted.trim() ? parseWatcherSetup(pasted) : null
  const pasteError = !pasted.trim()
    ? null
    : !watcherSetup
      ? "That does not look like the watcher setup output. Copy the whole block between the two marker lines."
      : watcherSetup.tenantId !== tenantId.toLowerCase()
        ? `That setup is for another tenant (${watcherSetup.tenantId}), not ${tenant.name}.`
        : storageAccount && watcherSetup.storageAccount.toLowerCase() !== storageAccount.toLowerCase()
          ? `That watcher uses storage account ${watcherSetup.storageAccount}, but this tenant's backups are in ${storageAccount}. Run its setup again for ${storageAccount}.`
          : null
  const handOver = azure === "guided" && watcherSetup !== null && !pasteError && watcherSetup.graphRolesGranted
  const command = useMemo(
    () => watcherSetupCommand({
      tenantId,
      storageAccount,
      resourceGroup: tenant.resources?.resourceGroupName && tenant.resources.resourceGroupName !== "local" ? tenant.resources.resourceGroupName : undefined,
      location: tenant.resources?.resourceGroupLocation || undefined,
      subscriptionId: tenant.resources?.subscriptionId && tenant.resources.subscriptionId !== "local" ? tenant.resources.subscriptionId : undefined,
      alertEmail: (alertEmail || (destination === "email" ? email : "")).trim() || undefined,
      includeConditionalAccess: needs.conditionalAccess,
    }),
    [tenantId, storageAccount, tenant.resources, alertEmail, destination, email, needs.conditionalAccess],
  )

  const destinationValid =
    destination === "local" ? true
    : destination === "existing" ? Boolean(existingId)
    : destination === "teams" ? /^https:\/\/.+/.test(teamsUrl.trim())
    : EMAIL.test(email.trim())
  const stepValid = [destinationValid, alerts.length > 0, azure === "later" || !pasteError, true][step] ?? true

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000)
    } catch (copyError) {
      toast(`Copying failed: ${copyError instanceof Error ? copyError.message : String(copyError)}`, "error")
    }
  }
  const copyButton = (key: string, label: string, text: string) => (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy(key, text)}>
      {copied === key ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      {copied === key ? "Copied" : label}
    </Button>
  )
  // The two PowerShell scripts load only when someone copies them, so the Alerts page stays light.
  const copyScriptButton = (key: string, label: string, header: string, load: () => Promise<string>) => (
    <Button type="button" variant="outline" size="sm" onClick={() => void load().then((script) => copy(key, `${header}\n\n${script}`)).catch(() => toast("The script could not be loaded.", "error"))}>
      {copied === key ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      {copied === key ? "Copied" : label}
    </Button>
  )

  const run = async () => {
    setPhase("running")
    setError(null)
    setTestWarning(null)
    const done: string[] = []
    const mark = (label: string) => { done.push(label); setProgress([...done]) }
    try {
      let channelId = createdChannelId
      if (destination === "existing") channelId = existingId
      if (!channelId) {
        if (destination === "local") {
          const local = data.channels.find((channel) => channel.kind === "local")
          channelId = local ? local.id : (await notificationsApi.addChannel(tenant, { kind: "local" })).channel.id
        } else if (destination === "teams") {
          channelId = (await notificationsApi.addChannel(tenant, { kind: "teams", url: teamsUrl.trim() })).channel.id
        } else if (destination === "email") {
          const address = email.trim()
          const same = data.channels.find((channel) => channel.kind === "email" && channel.recipients.some((recipient) => recipient.type === "address" && recipient.address.toLowerCase() === address.toLowerCase()))
          channelId = same ? same.id : (await notificationsApi.addChannel(tenant, { kind: "email", recipients: [{ type: "address", address }] })).channel.id
        }
        if (!channelId) throw new Error("No destination was created.")
        setCreatedChannelId(channelId)
      }
      mark("Destination ready")

      const knownTitles = new Set([...data.rules.map((rule) => rule.title.toLowerCase()), ...createdTitles.map((title) => title.toLowerCase())])
      for (const alert of alerts) {
        if (knownTitles.has(alert.title.toLowerCase())) continue
        await notificationsApi.addRule(tenant, { ...alert, channelIds: [channelId], mode: "immediate" })
        knownTitles.add(alert.title.toLowerCase())
        setCreatedTitles((current) => [...current, alert.title])
      }
      mark(alerts.length === 1 ? "Alert created" : `${alerts.length} alerts created`)

      if ((needs.intune || needs.conditionalAccess) && !data.auditWatch?.externalWatcher) {
        await notificationsApi.updateAuditWatch(tenant, {
          enabled: needs.intune || Boolean(data.auditWatch?.enabled),
          conditionalAccessEnabled: needs.conditionalAccess || Boolean(data.auditWatch?.conditionalAccess?.enabled),
          intervalMinutes: data.auditWatch?.intervalMinutes ?? 15,
        })
        mark("Change watching on")
      }

      if (handOver) {
        await notificationsApi.updateAuditWatch(tenant, { externalWatcher: true })
        await notificationsApi.pushWatcherAlerts(tenant, { auto: true, write: true })
        mark("Azure watcher takes over while this computer is off")
      }

      // A failed test (for example a missing Mail.Send permission) must not undo a working setup.
      try {
        const test = await notificationsApi.testChannel(tenant, channelId)
        if (test.delivery.ok) mark("Test delivered")
        else setTestWarning(`The setup is saved, but the test could not be delivered: ${test.delivery.error ?? "unknown error"}. The channel on the Channels tab shows the same error.`)
      } catch (testError) {
        setTestWarning(`The setup is saved, but the test could not be sent: ${testError instanceof Error ? testError.message : String(testError)}`)
      }
      setPhase("done")
      setStep(4)
      onChanged()
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "The setup could not be finished.")
      setPhase("failed")
      onChanged()
    }
  }

  const destinationLabel =
    destination === "existing" ? data.channels.find((channel) => channel.id === existingId)?.title ?? "Existing destination"
    : destination === "local" ? "This computer"
    : destination === "teams" ? "A Teams channel"
    : `Email to ${email.trim() || "..."}`

  return (
    <Dialog open onOpenChange={(next) => !next && phase !== "running" && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Set up alerts</DialogTitle>
          <DialogDescription>For {tenant.name}. You can change or remove everything this creates later.</DialogDescription>
        </DialogHeader>
        {step < 4 && (
          <ol className="flex flex-wrap gap-2" aria-label="Setup steps">
            {STEPS.map((label, index) => (
              <li key={label} aria-current={index === step ? "step" : undefined} className={`rounded-full px-3 py-1.5 text-xs font-medium ${index === step ? "bg-primary text-primary-foreground" : index < step ? "bg-gray-200 text-gray-800 dark:bg-gray-800 dark:text-gray-100" : "bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400"}`}>
                {index + 1}. {label}
              </li>
            ))}
          </ol>
        )}

        {step === 0 && (
          <div className="space-y-3" role="radiogroup" aria-label="Where alerts go">
            {enabledChannels.length > 0 && (
              <OptionCard selected={destination === "existing"} onSelect={() => setDestination("existing")} icon={<Bell className="h-4 w-4" aria-hidden="true" />} title="Use a destination you already have" description="Nothing new to create.">
                <div className="mt-3 space-y-1.5 pl-8">
                  {enabledChannels.map((channel) => (
                    <label key={channel.id} className="flex items-center gap-2 text-sm text-gray-800">
                      <input type="radio" name="existing-channel" className="size-4" checked={existingId === channel.id} onChange={() => setExistingId(channel.id)} />
                      {channel.title} <span className="text-gray-600">({CHANNEL_KIND_LABELS[channel.kind]})</span>
                    </label>
                  ))}
                </div>
              </OptionCard>
            )}
            <OptionCard selected={destination === "local"} onSelect={() => setDestination("local")} icon={<Monitor className="h-4 w-4" aria-hidden="true" />} title="This computer" description="A system notification while TenuVault runs. Nothing to configure, a good way to start." />
            <OptionCard selected={destination === "teams"} onSelect={() => setDestination("teams")} icon={<Bell className="h-4 w-4" aria-hidden="true" />} title="A Teams channel" description="Alerts as cards in a channel your team already reads.">
              <div className="mt-3 space-y-2 pl-8">
                <label className="block text-sm text-gray-800">
                  Workflows URL
                  <Input className="mt-1" type="url" autoComplete="off" spellCheck={false} placeholder="https://" value={teamsUrl} onChange={(event) => setTeamsUrl(event.target.value)} aria-describedby="teams-url-help" />
                </label>
                <details id="teams-url-help" className="text-sm text-gray-700">
                  <summary className="cursor-pointer font-medium text-gray-900">How to get this URL (2 minutes, in Teams)</summary>
                  <ol className="mt-2 list-decimal space-y-1 pl-5">
                    <li>In Teams, open the channel menu (the three dots next to the channel name) and choose Workflows.</li>
                    <li>Choose "Post to a channel when a webhook request is received".</li>
                    <li>Name the flow, pick the team and channel, and create it.</li>
                    <li>Copy the URL it shows and paste it above. Anyone with that URL can post to the channel, so treat it as a secret.</li>
                  </ol>
                </details>
              </div>
            </OptionCard>
            <OptionCard selected={destination === "email"} onSelect={() => setDestination("email")} icon={<Mail className="h-4 w-4" aria-hidden="true" />} title="Email" description="Sent through Microsoft Graph as the account you are signed in with.">
              <div className="mt-3 space-y-2 pl-8">
                <label className="block text-sm text-gray-800">
                  Send to
                  <Input className="mt-1" type="email" autoComplete="email" spellCheck={false} placeholder="name@contoso.com" value={email} onChange={(event) => setEmail(event.target.value)} />
                </label>
                {mailPermission?.granted === false && (
                  <p className="flex gap-2 text-sm text-amber-800 dark:text-amber-200" role="status">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Your sign-in does not carry {mailPermission.missing.join(", ")} yet, so mail would fail. You can finish the setup now and fix this after: add the permission to the app registration in Entra, grant admin consent and sign in again.</span>
                  </p>
                )}
              </div>
            </OptionCard>
            <p className="text-sm text-gray-600">Need a webhook, a group of recipients or several destinations? Finish here first, then add them on the Channels tab.</p>
          </div>
        )}

        {step === 1 && (
          <fieldset className="space-y-3">
            <legend className="text-sm text-gray-700">The recommended set is ticked. Successful backups are left out on purpose, they get noisy fast.</legend>
            {([
              ["backups", "Backup and restore problems", "A backup fails, finishes with warnings or misses its time, or a restore fails or only partly succeeds."],
              ["riskyChanges", "Policies deleted or unassigned", "Something in Intune or Conditional Access is deleted, or an assignment is removed. Each one in its own message."],
              ["conditionalAccess", "Conditional Access changes", "A Conditional Access policy, named location or authentication strength changes. Needs the AuditLog.Read.All permission; if it is missing, the alert's row will say so."],
            ] as const).map(([key, title, description]) => (
              <label key={key} className="flex gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
                <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={choices[key]} onChange={(event) => setChoices((current) => ({ ...current, [key]: event.target.checked }))} />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium text-gray-900">{title}</span>
                  <span className="block text-sm text-gray-700">{description}</span>
                </span>
              </label>
            ))}
            {alerts.length === 0 && <p className="text-sm text-gray-700" role="status">Tick at least one, or close the setup.</p>}
            <p className="text-sm text-gray-600">One policy, one setting or every single change instead? That stays one click deeper: Add alert on the Alerts tab.</p>
          </fieldset>
        )}

        {step === 2 && (
          <div className="space-y-3" role="radiogroup" aria-label="While this computer is off">
            <OptionCard selected={azure === "later"} onSelect={() => setAzure("later")} icon={<Monitor className="h-4 w-4" aria-hidden="true" />} title="Only while TenuVault is running" description="Alerts stop when this computer is off, asleep or signed out. You can add the Azure watcher later without redoing this setup." />
            <OptionCard selected={azure === "guided"} disabled={localStorage} onSelect={() => setAzure("guided")} icon={<Cloud className="h-4 w-4" aria-hidden="true" />} title="Also from Azure, in your own subscription" description={localStorage ? "Needs backups in your Azure storage account first." : "A small runbook in your Automation account sends the same alerts when this computer is off. Whoever owns Azure runs one prepared command."}>
              <div className="mt-3 space-y-3 pl-8">
                <label className="block text-sm text-gray-800">
                  If the watcher itself breaks, email
                  <Input className="mt-1" type="email" autoComplete="email" spellCheck={false} placeholder={destination === "email" && email.trim() ? email.trim() : "name@contoso.com"} value={alertEmail} onChange={(event) => setAlertEmail(event.target.value)} />
                  <span className="mt-1 block text-xs text-gray-600">Azure Monitor mails this address when a watcher run fails. Without one, replace the placeholder in the command before running it.</span>
                </label>
                <div className="space-y-2">
                  <p className="text-sm text-gray-800">1. Whoever can create Azure resources runs this in PowerShell, next to the two scripts. It needs a Global Administrator for the Graph roles ({needs.conditionalAccess ? "including AuditLog.Read.All for Conditional Access" : "DeviceManagementApps.Read.All"}).</p>
                  <code className="block break-all rounded-lg bg-secondary px-3 py-2 font-mono text-xs">{command}</code>
                  <div className="flex flex-wrap gap-2">
                    {copyButton("command", "Copy setup command", command)}
                    {copyScriptButton("setup", "Copy setup script", `# Save as New-TenuVaultNotificationWatcher.ps1, next to a runbooks folder holding Invoke-TenuVaultNotificationCheck.ps1\n# Guide: ${WATCHER_GUIDE_URL}`, () => import("../../../../resources/New-TenuVaultNotificationWatcher.ps1?raw").then((module) => module.default))}
                    {copyScriptButton("runbook", "Copy runbook", `# Save as runbooks/Invoke-TenuVaultNotificationCheck.ps1 next to New-TenuVaultNotificationWatcher.ps1`, () => import("../../../../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1?raw").then((module) => module.default))}
                    <Button type="button" variant="ghost" size="sm" onClick={() => void bridge.app.openExternal(WATCHER_GUIDE_URL)}>
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />Watcher guide
                    </Button>
                  </div>
                  <p className="text-xs text-gray-600">The command carries no secret. The watcher sends to the destinations set in its setup; these alerts are pushed to it from here after setup.</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm text-gray-800">2. Paste the block the setup prints at the end. You can also finish now and paste it later from this setup.</p>
                  <textarea className="w-full rounded-lg border border-gray-300 bg-white p-3 font-mono text-xs dark:bg-input/30" rows={6} spellCheck={false} value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder={"--- TenuVault notification watcher setup (paste into TenuVault) ---\ntenantId=...\n..."} aria-label="Watcher setup output" aria-invalid={Boolean(pasteError)} />
                  {pasteError && <p className="text-sm text-red-700" role="alert">{pasteError}</p>}
                  {watcherSetup && !pasteError && !watcherSetup.graphRolesGranted && (
                    <p className="flex gap-2 text-sm text-amber-800 dark:text-amber-200" role="status">
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>The Azure resources exist, but this setup run did not grant the Microsoft Graph roles, so the watcher may not be able to read changes yet. TenuVault will keep watching from this computer and will not hand over. Run the setup once with -GrantGraphRoles as a Global Administrator (roles already assigned are detected), then paste its new output here.</span>
                    </p>
                  )}
                  {watcherSetup && !pasteError && watcherSetup.graphRolesGranted && <p className="text-sm text-green-800 dark:text-green-200" role="status">Watcher found in {watcherSetup.automationAccount} ({watcherSetup.resourceGroup}). Turning alerts on will hand change alerts to it.</p>}
                </div>
              </div>
            </OptionCard>
            {localStorage && (
              <p className="text-sm text-gray-700">
                This tenant keeps backups on this device, so there is no storage account for the watcher to read. Choose your Azure storage account in <Link className="font-medium underline underline-offset-2" to={settingsHref("storage")} onClick={onClose}>Settings, Storage</Link> first.
              </p>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="text-sm text-gray-800">Turning alerts on will:</p>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-800">
              <li>Send to <strong>{destinationLabel}</strong>{destination === "existing" ? "" : " (created now, stored only on this computer)"}.</li>
              <li>Create {alerts.length === 1 ? "one alert" : `${alerts.length} alerts`}: {alerts.map((alert) => alert.title).join("; ")}. Alerts with these names that already exist are kept, not duplicated.</li>
              {(needs.intune || needs.conditionalAccess) && (
                <li>Turn on {[needs.intune ? "Intune" : null, needs.conditionalAccess ? "Conditional Access" : null].filter(Boolean).join(" and ")} change watching, checked every {data.auditWatch?.intervalMinutes ?? 15} minutes while TenuVault runs. Changes made through TenuVault itself stay ignored. Who made a change is not included.</li>
              )}
              {handOver && <li>Hand change alerts to the Azure watcher in {watcherSetup!.automationAccount}, and keep it updated whenever an alert or channel changes.</li>}
              {azure === "guided" && !handOver && <li>Keep watching from this computer for now. The Azure hand-over happens when you paste a finished watcher setup in the step before.</li>}
              <li>Send one test message, so you see it arrive.</li>
            </ul>
            <p className="text-sm text-gray-600">Messages carry names, counts, statuses and the names of changed settings, never setting values, policy content or credentials.</p>
            {phase === "running" && (
              <ul className="space-y-1.5 text-sm" aria-live="polite">
                {progress.map((label) => <StatusLine key={label} done label={label} />)}
                <li className="flex items-center gap-2 text-gray-800"><Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />Working...</li>
              </ul>
            )}
            {phase === "failed" && error && (
              <div className="space-y-2" role="alert">
                <p className="text-sm text-red-700">Setup stopped: {error}</p>
                {progress.length > 0 && <p className="text-sm text-gray-700">Already saved: {progress.join(", ").toLowerCase()}. Trying again continues from there and does not create duplicates.</p>}
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-base font-medium text-gray-900"><CheckCircle2 className="h-5 w-5 text-green-700" aria-hidden="true" />Alerts are on</p>
            <ul className="space-y-1.5 text-sm" aria-label="What was set up">
              {progress.map((label) => <StatusLine key={label} done label={label} />)}
            </ul>
            {testWarning && <p className="flex gap-2 text-sm text-amber-800 dark:text-amber-200" role="status"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{testWarning}</span></p>}
            {azure === "guided" && !handOver && (
              <p className="text-sm text-gray-700">The Azure part is still open: run the prepared command in Azure, then open this setup again and paste its output. Until then, alerts run while TenuVault runs.</p>
            )}
            {handOver && <p className="text-sm text-gray-700">The Azure watcher uses these alerts from its next run. Its card on the Alerts tab shows when it last ran.</p>}
            <p className="text-sm text-gray-600">Want one specific policy, a webhook, or a custom Teams card? Everything is in the tabs behind this dialog.</p>
            <div className="flex flex-wrap gap-2">
              <Chip tone="success">{alerts.length} {alerts.length === 1 ? "alert" : "alerts"} on</Chip>
              <Chip tone="neutral">{destinationLabel}</Chip>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <div>
            {step > 0 && step < 4 && (
              <Button type="button" variant="ghost" disabled={phase === "running"} onClick={() => setStep(step - 1)}>
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />Back
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={phase === "running"} onClick={onClose}>{step === 4 ? "Close" : "Cancel"}</Button>
            {step < 3 && <Button type="button" disabled={!stepValid} onClick={() => setStep(step + 1)}>Continue</Button>}
            {step === 3 && <Button type="button" disabled={phase === "running"} onClick={() => void run()}>{phase === "running" ? "Turning on" : phase === "failed" ? "Try again" : "Turn on alerts"}</Button>}
            {step === 4 && <Button type="button" autoFocus onClick={onClose}>View alerts</Button>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
