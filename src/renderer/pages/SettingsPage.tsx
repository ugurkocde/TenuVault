import type { WriteRecord } from "../../main/storage/restore-journal"
import { getAppearance, setAppearance, type Appearance } from "../lib/appearance"
import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Bell, Download, FolderOpen, HardDrive, Info, KeyRound, Loader2, Lock, MonitorCog, Palette, RefreshCw, Save, SunMoon, Upload, type LucideIcon } from "lucide-react"
import { cn } from "~/lib/utils"
import { useTenantOperations, useTenants, type Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { storageLabel } from "~/lib/storage-label"
import type { AppInfo, AppPreferences, SignedInAccount, UpdateStatus } from "../../shared/ipc"
import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import { allows, COMMUNITY_RETENTION_DAYS, effectiveRetentionDays } from "../../shared/plans"
import { isGuid } from "../../shared/security"
import { LicenseAgreementLink } from "../components/LicenseAgreementDialog"
import { StorageChooser, type StorageChooserDraft } from "../components/StorageChooser"
import { UnreadableBackupsNotice } from "../components/UnreadableBackupsNotice"
import { RecoveryKeyImport } from "../components/RecoveryKeyImport"
import { RecoveryKeyNotice } from "../components/RecoveryKeyNotice"
import { bridge } from "../lib/bridge"
import { localTenantIds, useBackupSettings, useLocalInventoryProblems } from "../lib/local-inventory"
import { storageResources, type StorageChoice } from "../lib/storage"
import { toast } from "../lib/toast"
import { tenantPlan, useLicense } from "../lib/license"
import { parseSettingsSection, settingsHref, type SettingsSectionId } from "../lib/settings-section"
import { PlanBadge } from "../components/UpgradeNote"
import { PdfBrandingSettings } from "../components/PdfBrandingSettings"
import { BackupReaderSettings } from "../components/BackupReaderSettings"
import { NotificationsPanel } from "../features/notifications/NotificationsPanel"
import { useConfirm } from "~/components/ConfirmDialog"

function RestoreWrites({ active }: { active: boolean }) {
  const tenants = useTenants().filter(tenant => tenant.credentials?.tenantId)
  const [selected, setSelected] = useState("")
  const tenantId = tenants.some(tenant => tenant.credentials?.tenantId === selected) ? selected : tenants[0]?.credentials?.tenantId
  if (!tenantId) {
    return (
      <Card>
        <CardContent className="pt-6">Connect and sign in to a tenant to view restore write history.</CardContent>
      </Card>
    )
  }
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        Restore history tenant
        <select className="ml-3 rounded border bg-background p-2" value={tenantId} onChange={event => setSelected(event.target.value)}>
          {tenants.map(tenant => <option key={tenant.id} value={tenant.credentials!.tenantId}>{tenant.name}</option>)}
        </select>
      </label>
      <TenantRestoreWrites key={tenantId} tenantId={tenantId} active={active} />
    </div>
  )
}

function RestoreAppliedInput({ record, request, onClose }: { record: WriteRecord; request: (body: object) => Promise<void>; onClose: () => void }) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const inputContainer = useRef<HTMLDivElement>(null)
  const [objectId, setObjectId] = useState(record.state === "reconciled" ? record.objectId ?? "" : "")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const description = record.state === "reconciled"
    ? "After checking the original policy name and tenant in Intune, enter the corrected object ID. The next retry will read and verify its creation fields before any follow-up writes."
    : "After checking Intune, enter the ID of the object this request applied to. A retry will reuse this result instead of repeating the write."

  useEffect(() => {
    if (saving) inputContainer.current?.focus()
    else if (error) input.current?.focus()
  }, [error, saving])

  const submit = async () => {
    if (saving) return
    const value = objectId.trim()
    if (!isGuid(value)) {
      setError("Enter a valid object ID (GUID).")
      return
    }
    setError("")
    setSaving(true)
    try {
      await request({ action: "applied", key: record.key, objectId: value, confirmed: true })
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="mt-3 space-y-3" aria-label={record.state === "reconciled" ? "Correct applied ID" : "Confirm applied"} onSubmit={event => { event.preventDefault(); void submit() }} onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        if (!saving) onClose()
      }
    }}>
      <div ref={inputContainer} tabIndex={-1} className="space-y-1">
        <label htmlFor={id} className="block font-medium">Object ID</label>
        <p id={`${id}-description`} className="text-sm text-gray-500">{description}</p>
        <input
          id={id}
          ref={input}
          className="w-full rounded border bg-background p-2 font-mono text-sm"
          value={objectId}
          onChange={event => { setObjectId(event.target.value); setError("") }}
          aria-describedby={`${id}-description${error ? ` ${id}-error` : ""}`}
          aria-invalid={!!error}
          autoFocus
          spellCheck={false}
          disabled={saving}
        />
      </div>
      {error && <p id={`${id}-error`} role="alert" className="text-red-700">{error}</p>}
      <div className="flex gap-3">
        <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save applied ID"}</Button>
        <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
      </div>
    </form>
  )
}

function TenantRestoreWrites({ tenantId, active }: { tenantId: string; active: boolean }) {
  const { confirm, confirmDialog } = useConfirm()
  const [records, setRecords] = useState<WriteRecord[]>([])
  const [error, setError] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const recoveryButton = useRef<{ key: string; button: HTMLButtonElement } | null>(null)
  const refreshButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (editing !== null && !records.some(record => record.key === editing)) setEditing(null)
  }, [editing, records])
  useEffect(() => {
    if (editing === null && recoveryButton.current) {
      const button = recoveryButton.current.button
      if (button.isConnected) button.focus()
      else refreshButton.current?.focus()
      recoveryButton.current = null
    }
  }, [editing])
  const trackRecoveryButton = (key: string, button: HTMLButtonElement | null) => {
    if (button && recoveryButton.current?.key === key) recoveryButton.current.button = button
  }
  const request = async (body: object) => {
    const response = await fetch("/api/restore-journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, tenantId }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    if (!Array.isArray(data.records)) throw new Error("Invalid restore history response")
    setError("")
    setRecords(data.records)
  }
  useEffect(() => { void request({ action: "list" }).catch(e => setError(String(e))) }, [])
  return (
    <Card>
      {/* Portaled dialogs render outside the hidden panel, so a hidden panel must not keep one open. Holding the element back keeps the pending confirmation for the return. */}
      {active ? confirmDialog : null}
      <CardHeader>
        <CardTitle>Restore write history</CardTitle>
        <Button ref={refreshButton} variant="outline" onClick={() => void request({ action: "list" }).catch(e => setError(String(e)))}>Refresh history</Button>
        <CardDescription>Interrupted writes stay blocked across restarts. Check the target tenant in Intune before resolving an uncertain result. Request payloads and tokens are not stored here.</CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {!records.length && <p>No restore writes recorded.</p>}
        {records.slice().reverse().map(record => (
          <div key={record.key} className="border-t py-3 text-sm">
            <p className="font-medium">{record.label ?? "Object name unavailable"}</p>
            <p>{record.at} · {record.state} · Tenant {record.tenant}</p>
            <p className="break-all">{record.method} {record.path}{record.objectId ? ` · Object ${record.objectId}` : ""}</p>
            {record.state === "reconciled" && (
              <>
                <Button ref={button => trackRecoveryButton(record.key, button)} className="mt-2 mr-2" variant="outline" aria-expanded={editing === record.key} onClick={event => {
                  recoveryButton.current = { key: record.key, button: event.currentTarget }
                  setEditing(record.key)
                }}>Correct applied ID</Button>
                <Button className="mt-2" variant="outline" onClick={async () => {
                  if (await confirm({ title: "Start a new operation?", description: "Start a new operation with this request? Future attempts will send the write again and may create another object. Do not clear this while resuming a repair.", confirmLabel: "Allow a new operation" })) {
                    void request({ action: "new-operation", key: record.key, confirmed: true }).catch(e => setError(String(e)))
                  }
                }}>Allow a new operation</Button>
              </>
            )}
            {record.state === "uncertain" && (
              <div className="mt-2 flex gap-3">
                <Button ref={button => trackRecoveryButton(record.key, button)} variant="outline" aria-expanded={editing === record.key} onClick={event => {
                  recoveryButton.current = { key: record.key, button: event.currentTarget }
                  setEditing(record.key)
                }}>Confirm applied</Button>
                <Button variant="outline" onClick={async () => {
                  if (await confirm({ title: "Allow another attempt?", description: "I checked the target tenant in Intune and confirmed this request was NOT applied. Allow another attempt?", confirmLabel: "Allow another attempt" })) {
                    void request({ action: "not-applied", key: record.key, confirmed: true }).catch(e => setError(String(e)))
                  }
                }}>Confirm not applied</Button>
              </div>
            )}
            {editing === record.key && <RestoreAppliedInput record={record} request={request} onClose={() => setEditing(current => current === record.key ? null : current)} />}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function NotificationSettings({ active }: { active: boolean }) {
  const tenants = useTenants().filter(tenant => tenant.credentials?.tenantId)
  const { status: licenseStatus } = useLicense()
  const [selected, setSelected] = useState("")
  const tenant = tenants.find(candidate => candidate.credentials?.tenantId === selected) ?? tenants[0]
  if (!tenant?.credentials) {
    return (
      <Card>
        <CardContent className="pt-6">Connect and sign in to a tenant to set up notifications.</CardContent>
      </Card>
    )
  }
  const tenantId = tenant.credentials.tenantId
  const plan = tenantPlan(licenseStatus?.tenants.find(entry => entry.tenantId.toLowerCase() === tenantId.toLowerCase()))
  const locked = plan !== null && !allows(plan, "notifications")
  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-3 text-xl font-medium text-gray-900">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><Bell className="h-[18px] w-[18px]" /></span> Notifications
          {locked && <PlanBadge feature="notifications" />}
        </h2>
        <p className="mt-2 text-sm text-gray-500">Backup, restore, drift and Intune change alerts to this computer, a webhook, a Teams channel or email. Settings are kept per tenant.</p>
      </div>
      <label className="block text-sm">
        Notifications tenant
        <select className="ml-3 rounded border bg-background p-2" value={tenantId} onChange={event => setSelected(event.target.value)}>
          {tenants.map(candidate => <option key={candidate.id} value={candidate.credentials!.tenantId}>{candidate.name}</option>)}
        </select>
      </label>
      <NotificationsPanel key={tenantId} tenant={tenant} active={active} />
    </div>
  )
}

function BackupsOnDevice() {
  // The Change storage dialog can fix the folder too; its changes reach this card.
  const [settings, setSettings] = useBackupSettings((error) => toast(String(error), "error"))
  const [importing, setImporting] = useState(false)
  const { hash } = useLocation()
  const tenants = useTenants()
  // A shared folder can hold tenants another device backs up with its own key; only this device's tenants matter.
  const inventory = useLocalInventoryProblems(settings, localTenantIds(tenants))

  useEffect(() => {
    if (hash !== "#recovery-key") return
    const button = document.getElementById("save-recovery-key")
    button?.scrollIntoView({ block: "center" })
    button?.focus({ preventScroll: true })
  }, [hash])

  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><HardDrive className="h-[18px] w-[18px]" /></span> Backups on this device
        </CardTitle>
        <CardDescription>
          For tenants that keep backups on this device. Every backup file is encrypted with AES-256-GCM; file names reveal
          nothing about your policies.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-7 pb-7">
        <Button variant="outline" onClick={() => void run(async () => {
          const result = await bridge.backups.importArchive()
          if (result.imported) {
            setSettings(await bridge.backups.settings())
            toast(`Imported ${result.backupId}. Select this device as storage for tenant ${result.tenantId} to preview and restore it.`, "success")
          }
        })}><Upload className="mr-2 h-4 w-4" /> Import backup ZIP</Button>
        <UnreadableBackupsNotice settings={settings} affected={inventory.affected.length > 0} checking={inventory.checking} onChange={setSettings} />
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500">Folder</p>
          <p className="break-all rounded-2xl bg-gray-50 px-4 py-3 font-mono text-xs text-gray-700">{settings?.localFolder ?? "..."}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void run(async () => setSettings(await bridge.backups.chooseFolder()))}>
              <FolderOpen className="mr-2 h-4 w-4" /> Change folder
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void run(() => bridge.backups.openFolder())}>
              Open folder
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            Changing the folder does not move existing backups. Move the folder's contents yourself to keep them visible.
            A network share works, since the files are encrypted.
          </p>
        </div>

        <div className="space-y-2 border-t border-gray-100 pt-5">
          <RecoveryKeyNotice settings={settings} />
          <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
            <Lock className="h-4 w-4" /> Encryption key
          </p>
          <p className="text-sm text-gray-600">
            The key is protected by your {navigator.platform.startsWith("Mac") ? "macOS Keychain" : "Windows account"}. Save
            the recovery key somewhere safe, such as your password manager: you need it to read these backups on another
            device or after reinstalling. The saved bundle includes all previous keys on this device.
            Save a new bundle after importing keys.
          </p>
          <p className="text-xs text-gray-500">
            Key fingerprint: <span className="font-mono">{settings?.keyFingerprint ?? "..."}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              id="save-recovery-key"
              variant="outline"
              size="sm"
              onClick={() =>
                void run(async () => {
                  const result = await bridge.backups.exportRecoveryKey()
                  if (result.saved) {
                    setSettings(await bridge.backups.settings())
                    toast(`Recovery key saved to ${result.path}. Move it to a safe place.`, "success")
                  }
                })
              }
            >
              <Save className="mr-2 h-4 w-4" /> Save recovery key
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setImporting((v) => !v)}>
              <Upload className="mr-2 h-4 w-4" /> Import a recovery key
            </Button>
          </div>
          {importing && (
            <RecoveryKeyImport
              onImported={(imported) => {
                setSettings(imported)
                setImporting(false)
                toast("Recovery key imported.", "success")
              }}
              onError={(message) => toast(message, "error")}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function currentChoice(tenant: Tenant): StorageChoice | undefined {
  const resources = tenant.resources
  if (!resources?.storageAccountName) return undefined
  if (resources.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)) return { kind: "local" }
  return {
    kind: "azure",
    storageAccountName: resources.storageAccountName,
    subscriptionId: resources.subscriptionId,
    resourceGroupName: resources.resourceGroupName,
    location: resources.resourceGroupLocation ?? "",
  }
}

function TenantSettings({ active }: { active: boolean }) {
  const tenants = useTenants()
  const { updateTenant } = useTenantOperations()
  const [accounts, setAccounts] = useState<SignedInAccount[]>([])
  const [editing, setEditing] = useState<Tenant | null>(null)
  const [choice, setChoice] = useState<StorageChoice | null>(null)
  // The Change storage dialog closes while its section is hidden; its chooser draft lives here so the reopened dialog picks up where the admin left off.
  const [storageDraft, setStorageDraft] = useState<StorageChooserDraft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = () => void bridge.auth.accounts().then(setAccounts)
  useEffect(refresh, [])

  const signIn = async (tenant: Tenant) => {
    const { tenantId, appId } = tenant.credentials!
    setBusy(tenantId)
    try {
      const account = await bridge.auth.reauthenticate(tenantId, appId)
      toast(`Signed in as ${account.username}.`, "success")
      refresh()
    } catch (error) {
      toast(error instanceof Error ? error.message : "Sign-in failed.", "error")
    } finally {
      setBusy(null)
    }
  }

  const saveStorage = () => {
    if (!editing?.credentials || !choice) return
    const current = editing.resources
    const storage = storageResources(editing.credentials.tenantId, choice)
    updateTenant(editing.id, {
      resources: { ...current, ...storage, subscriptionName: current?.subscriptionName ?? "", automationAccountName: "" },
    })
    toast(`Backups for ${editing.name} now go to ${choice.kind === "local" ? "this device" : choice.storageAccountName}.`, "success")
    setStorageDraft(null)
    setEditing(null)
  }

  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><KeyRound className="h-[18px] w-[18px]" /></span> Tenants
        </CardTitle>
        <CardDescription>Who you are signed in as, and where each tenant's backups are stored.</CardDescription>
      </CardHeader>
      <CardContent className="px-7 pb-7">
        {tenants.length === 0 ? (
          <p className="text-sm text-gray-600">
            No tenants yet. <Link to="/portal/onboarding" className="text-blue-600 hover:underline">Set up your first tenant</Link>.
          </p>
        ) : (
          <div className="divide-y divide-gray-100">
            {tenants.map((tenant) => {
              const tenantId = tenant.credentials?.tenantId ?? ""
              const account = accounts.find((a) => a.tenantId === tenantId.toLowerCase())
              return (
                <div key={tenant.id} className="flex items-center gap-3 py-4 first:pt-1 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-gray-900">{tenant.name}</p>
                    <p className="truncate text-xs text-gray-500">
                      {account ? `Signed in as ${account.username}` : "Not signed in"} · Backups: {storageLabel(tenant.resources?.storageAccountName)}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void signIn(tenant)} disabled={busy === tenantId || !tenant.credentials}>
                    {busy === tenantId && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {account ? "Sign in again" : "Sign in"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setChoice(null); setStorageDraft(null); setEditing(tenant) }} disabled={!tenant.credentials}>
                    Change storage
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={active && Boolean(editing)} onOpenChange={(open) => { if (!open) { setStorageDraft(null); setEditing(null) } }}>
        <DialogContent className="sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>Backup storage for {editing?.name}</DialogTitle>
            <DialogDescription>
              New backups go to the location you choose. Existing backups stay where they are and are only listed
              while that location is selected.
            </DialogDescription>
          </DialogHeader>
          {editing?.credentials && (
            <StorageChooser
              tenantId={editing.credentials.tenantId}
              clientId={editing.credentials.appId}
              initial={currentChoice(editing)}
              initialDraft={storageDraft ?? undefined}
              onChange={setChoice}
              onDraftChange={setStorageDraft}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setStorageDraft(null); setEditing(null) }}>Cancel</Button>
            <Button disabled={!choice} onClick={saveStorage}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function allowsCustomRetention(days: number): boolean {
  return days !== 0 && days <= COMMUNITY_RETENTION_DAYS
}

export function BackgroundAndRetention() {
  const tenants = useTenants()
  const { status: licenseStatus } = useLicense()
  const [prefs, setPrefs] = useState<AppPreferences | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [launcher, setLauncher] = useState<{ supported: boolean; installed: boolean } | null>(null)
  const [launchBusy, setLaunchBusy] = useState<"install" | "remove" | null>(null)
  const [checkBusy, setCheckBusy] = useState(true)
  const [checkError, setCheckError] = useState(false)
  const launchInFlight = useRef(false)
  const checkInFlight = useRef(false)
  const checkLauncher = async () => {
    if (checkInFlight.current || launchInFlight.current) return
    checkInFlight.current = true
    setCheckBusy(true)
    try {
      setLauncher(await bridge.backgroundLaunch.status())
      setCheckError(false)
    } catch {
      setLauncher(null)
      setCheckError(true)
    } finally {
      checkInFlight.current = false
      setCheckBusy(false)
    }
  }
  const changeLauncher = async () => {
    if (launchInFlight.current || checkInFlight.current || !launcher?.supported) return
    launchInFlight.current = true
    setLaunchBusy(launcher.installed ? "remove" : "install")
    try {
      setLauncher(await (launcher.installed ? bridge.backgroundLaunch.remove() : bridge.backgroundLaunch.install()))
    } catch (error) {
      toast(String(error), "error")
    } finally {
      launchInFlight.current = false
      setLaunchBusy(null)
    }
  }
  const load = () => {
    setLoadError(null)
    Promise.all([bridge.app.info(), bridge.preferences.get()]).then(([nextInfo, nextPrefs]) => {
      setInfo(nextInfo)
      setPrefs(nextPrefs)
    }, (error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
  }
  useEffect(() => { void checkLauncher() }, [])
  useEffect(load, [])
  const set = async (changes: Partial<AppPreferences>) => {
    try {
      setPrefs(await bridge.preferences.set(changes))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error")
    }
  }
  if (loadError) return <SectionLoadError title="Background runner" icon={MonitorCog} message={loadError} onRetry={load} />
  if (!prefs || !info) return null
  const iconLocation = info.platform === "darwin" ? "menu bar" : "tray"
  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><MonitorCog className="h-[18px] w-[18px]" /></span> Background runner
        </CardTitle>
        <CardDescription>Automatic backups run while TenuVault is running, in the window or in the {iconLocation}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-7 pb-7 text-sm text-gray-700">
        <div className="rounded-xl border border-gray-200 p-4">
          <p className="font-medium">Restart TenuVault for scheduled backups</p>
          <p className="mt-2 text-sm">{info.platform === "darwin" ? "Adds a LaunchAgent for your user account" : "Adds a scheduled task for your user account"}. The background runner can reopen TenuVault in the {iconLocation} within five minutes while you are signed in. Backups still require valid Microsoft sign-in, plan access and available storage. This does not run while signed out, asleep or powered off.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="outline" disabled={!launcher?.supported || checkBusy || !!launchBusy} onClick={() => void changeLauncher()}>{launchBusy === "install" ? "Installing..." : launchBusy === "remove" ? "Removing..." : launcher?.installed ? "Remove background launch" : "Install background launch"}</Button>
            <p role="status">{checkBusy ? "Checking..." : checkError ? "Unable to check" : launcher?.installed ? "Installed" : "Not installed"}</p>
          </div>
          {checkError && <div className="mt-3 flex flex-wrap items-center gap-3">
            <p role="alert">Could not check background startup. Try again.</p>
            <Button variant="outline" size="sm" disabled={checkBusy} onClick={() => void checkLauncher()}>Retry check</Button>
          </div>}
          {launcher && !launcher.supported && <p className="mt-2 text-xs">Available in installed Windows and macOS builds.</p>}
          <p className="mt-2 text-xs">Backups need an awake computer and a signed in session. Locking the screen does not sign you out; closing a laptop lid may put it to sleep.</p>
          <p className="mt-2 text-xs">To stop automatic restarts, remove the background runner and turn off Start at login before quitting. Removing it leaves your backup schedules unchanged.</p>
        </div>
        <label className="flex items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={prefs.startAtLogin} onChange={(e) => void set({ startAtLogin: e.target.checked })} />
          Start TenuVault in the {iconLocation} when I sign in to this computer
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={prefs.keepRunningInTray} onChange={(e) => void set({ keepRunningInTray: e.target.checked })} />
          Keep running in the {iconLocation} when I close the window
        </label>
        {(() => {
          const connected = tenants.filter((tenant) => tenant.credentials?.tenantId)
          const plans = connected.map((tenant) => tenantPlan(licenseStatus?.tenants.find((entry) => entry.tenantId.toLowerCase() === tenant.credentials!.tenantId.toLowerCase())))
          const allCommunity = connected.length > 0 && plans.every((plan) => plan === "community")
          const gated = allCommunity && !allowsCustomRetention(prefs.retentionDays)
          return (
            <>
              <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
                <label htmlFor="retention" className="flex items-center gap-2">Keep backups for{allCommunity && <PlanBadge feature="customRetention" />}</label>
                <select
                  id="retention"
                  className="h-10 rounded-full border border-gray-300 bg-white px-4"
                  value={prefs.retentionDays}
                  onChange={(e) => void set({ retentionDays: Number(e.target.value) })}
                >
                  {[7, 14, 30, 60, 90, 180, 365].map((days) => (
                    <option key={days} value={days} disabled={allCommunity && days > COMMUNITY_RETENTION_DAYS}>
                      {days} days{allCommunity && days > COMMUNITY_RETENTION_DAYS ? " (Pro)" : ""}
                    </option>
                  ))}
                  <option value={0} disabled={allCommunity}>Forever{allCommunity ? " (Pro)" : ""}</option>
                </select>
              </div>
              <p className="text-xs text-gray-500">
                Older backups are deleted after each successful backup. The newest backup is always kept. Community tenants
                keep {COMMUNITY_RETENTION_DAYS} days at most; Pro and MSP tenants keep what you choose here.
              </p>
              {gated && (
                <p role="note" className="text-xs text-gray-700">
                  Your saved choice is {prefs.retentionDays === 0 ? "Forever" : `${prefs.retentionDays} days`}. On Community it takes effect as {effectiveRetentionDays(prefs.retentionDays, "community")} days until a tenant is on Pro or MSP.
                </p>
              )}
            </>
          )
        })()}
      </CardContent>
    </Card>
  )
}

export function Updates() {
  const [prefs, setPrefs] = useState<AppPreferences | null>(null)
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const failed = (error: unknown): UpdateStatus => ({ state: "error", message: error instanceof Error ? error.message : String(error) })
  const load = () => {
    setLoadError(null)
    bridge.preferences.get().then(setPrefs, (error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
  }
  useEffect(() => {
    load()
    bridge.updates.status().then(setStatus, (error: unknown) => setStatus(failed(error)))
    return bridge.updates.onChanged(setStatus)
  }, [])
  const set = async (changes: Partial<AppPreferences>) => {
    setSaveError(null)
    try {
      setPrefs(await bridge.preferences.set(changes))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }
  if (loadError) return <SectionLoadError title="Updates" icon={Download} message={loadError} onRetry={load} />
  if (!prefs) return null
  const describe = () => {
    switch (status.state) {
      case "checking":
        return "Checking for updates..."
      case "not-available":
        return "TenuVault is up to date."
      case "downloading":
        return `Downloading version ${status.version} (${status.percent}%)...`
      case "ready":
        return `Version ${status.version} is ready to install.`
      case "error":
        return `Could not check for updates: ${status.message}`
      case "disabled":
        return prefs.autoUpdateManaged ? "Your organization manages updates for TenuVault." : "Automatic updates are off."
      default:
        return ""
    }
  }
  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><Download className="h-[18px] w-[18px]" /></span> Updates
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-7 pb-7 text-sm text-gray-700">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={prefs.autoUpdate}
            disabled={prefs.autoUpdateManaged}
            onChange={(e) => void set({ autoUpdate: e.target.checked })}
          />
          Download and install updates automatically
        </label>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={prefs.nightlyUpdates}
            disabled={prefs.autoUpdateManaged || !prefs.autoUpdate}
            onChange={(e) => void set({ nightlyUpdates: e.target.checked })}
          />
          Get nightly builds
        </label>
        {saveError && <p role="alert" className="text-red-700">Could not save the update setting: {saveError}</p>}
        <p className="text-xs text-gray-500">
          Enable this to try preview builds between stable releases. A stable release newer than the latest nightly
          is offered too. Turn it off to download the current stable release, even if its version is older than your
          installed nightly. Changing channels replaces any pending
          update. Nightly builds may contain bugs.
        </p>
        <p className="text-gray-600">{describe()}</p>
        <div className="flex gap-2">
          {status.state === "ready" ? (
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => void bridge.updates.install()}>
              Restart and update
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={!prefs.autoUpdate || status.state === "checking"} onClick={() => void bridge.updates.check().then(setStatus, (error: unknown) => setStatus(failed(error)))}>
              <RefreshCw className="mr-2 h-4 w-4" /> Check now
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** A settings section whose saved state could not be read, with a retry. */
function SectionLoadError({ title, icon: Icon, message, onRetry }: { title: string; icon: LucideIcon; message: string; onRetry: () => void }) {
  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><Icon className="h-[18px] w-[18px]" /></span> {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 px-7 pb-7 text-sm">
        <p role="alert" className="text-red-700">These settings could not be loaded: {message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
      </CardContent>
    </Card>
  )
}

function About({ active }: { active: boolean }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  // Without the app info only the version number is left out.
  useEffect(() => void bridge.app.info().then(setInfo, () => undefined), [])
  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><Info className="h-[18px] w-[18px]" /></span> About
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-7 pb-7 text-sm text-gray-700">
        <p>TenuVault Desktop {info?.version ?? ""}</p>
        <p>
          TenuVault talks to Microsoft (sign-in, Graph, Azure), to GitHub for the Open Intune Baseline catalog and for
          updates, and to tenuvault.com for license checks. No tenant configuration or backup is ever sent to TenuVault.
        </p>
        <p>
          <Link to="/license" className="text-blue-600 hover:underline">License</Link>
          {" · "}
          <LicenseAgreementLink active={active} />
          {" · "}
          <button type="button" className="text-blue-600 hover:underline" onClick={() => void bridge.app.openExternal("https://tenuvault.com/")}>
            Website and support
          </button>
        </p>
      </CardContent>
    </Card>
  )
}

function AppearanceSettings() {
  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><SunMoon className="h-[18px] w-[18px]" /></span> Appearance
        </CardTitle>
        <CardDescription>How TenuVault looks on this computer.</CardDescription>
      </CardHeader>
      <CardContent className="px-7 pb-7">
        <label className="flex items-center gap-3 text-sm font-medium text-gray-600">Appearance
          <select className="h-10 rounded-full border border-gray-200 bg-white px-4 text-gray-900" defaultValue={getAppearance()} onChange={e => setAppearance(e.target.value as Appearance)}>
            <option value="system">Use system setting</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
      </CardContent>
    </Card>
  )
}

const SECTIONS: { id: SettingsSectionId; title: string; icon: typeof KeyRound }[] = [
  { id: "signin", title: "Sign-in", icon: KeyRound },
  { id: "storage", title: "Storage and recovery", icon: HardDrive },
  { id: "background", title: "Background runner", icon: MonitorCog },
  { id: "notifications", title: "Notifications", icon: Bell },
  { id: "branding", title: "PDF branding", icon: Palette },
  { id: "updates", title: "Updates", icon: Download },
  { id: "appearance", title: "Appearance", icon: SunMoon },
  { id: "about", title: "About", icon: Info },
]

export default function SettingsPage() {
  const [searchParams] = useSearchParams()
  const { hash } = useLocation()
  // Links that only carry the recovery key anchor predate the section parameter; they mean the storage section.
  const section: SettingsSectionId = hash === "#recovery-key" && !searchParams.get("section")
    ? "storage"
    : parseSettingsSection(searchParams.get("section"))

  // Keep every panel mounted and only toggle visibility, so unsaved edits and
  // loaded state survive switching sections. Start each section at the top,
  // except when a deep link targets a control inside the storage section.
  useEffect(() => {
    if (hash !== "#recovery-key") window.scrollTo({ top: 0 })
  }, [section, hash])

  // In the narrow row layout the active entry can sit outside the scrollable
  // strip after a deep link. Scroll the strip sideways only; scrollIntoView
  // would also move the page and push a focused control out of view.
  useEffect(() => {
    if (!window.matchMedia("(max-width: 1279px)").matches) return
    const link = document.querySelector('nav[aria-label="Settings sections"] [aria-current="page"]')
    const strip = link?.parentElement
    if (!link || !strip) return
    const linkBox = link.getBoundingClientRect()
    const stripBox = strip.getBoundingClientRect()
    if (linkBox.left < stripBox.left) strip.scrollLeft += linkBox.left - stripBox.left - 4
    else if (linkBox.right > stripBox.right) strip.scrollLeft += linkBox.right - stripBox.right + 4
  }, [section])

  // Hiding a panel closes its dialogs; their focus return targets are hidden
  // too, so land focus on the active section entry instead of losing it.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const landFocus = () => {
      const focused = document.activeElement
      if (!focused || focused === document.body || focused.closest("section[hidden]")) {
        document.querySelector<HTMLElement>('nav[aria-label="Settings sections"] [aria-current="page"]')?.focus({ preventScroll: true })
      }
    }
    landFocus()
    // A closing dialog still holds focus inside its portal through its exit
    // animation and only drops it when the portal leaves the DOM, so keep
    // checking while nodes are removed, then stop watching.
    const observer = new MutationObserver(landFocus)
    observer.observe(document.body, { childList: true, subtree: true })
    const stop = setTimeout(() => observer.disconnect(), 1000)
    return () => {
      observer.disconnect()
      clearTimeout(stop)
    }
  }, [section])

  const panel = (id: SettingsSectionId, content: ReactNode) => (
    <section key={id} id={`settings-${id}`} hidden={section !== id}>{content}</section>
  )

  return (
    <div className="p-6 lg:p-8">
      <div className="pb-2">
        <h1 className="text-4xl font-medium tracking-tight text-gray-900">Settings</h1>
        <p className="mt-2 text-lg text-gray-500">Sign-in, backup storage, encryption, background backups, notifications, PDF branding and updates.</p>
      </div>
      <div className="mt-4 flex flex-col gap-6 xl:flex-row xl:items-start">
        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto p-1 xl:sticky xl:top-8 xl:w-56 xl:shrink-0 xl:flex-col xl:overflow-visible xl:p-0">
          {SECTIONS.map(({ id, title, icon: Icon }) => (
            <Link
              key={id}
              to={settingsHref(id)}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex min-h-10 shrink-0 items-center gap-3 rounded-full px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                section === id
                  ? "bg-primary text-primary-foreground"
                  : "text-gray-600 hover:bg-secondary hover:text-foreground dark:text-gray-400",
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
              <span className="truncate">{title}</span>
            </Link>
          ))}
        </nav>
        <div className="min-w-0 w-full max-w-5xl flex-1">
          {panel("signin", <TenantSettings active={section === "signin"} />)}
          {panel("storage", <div className="space-y-6"><BackupsOnDevice /><RestoreWrites active={section === "storage"} /></div>)}
          {panel("background", <div className="space-y-6"><BackgroundAndRetention /><BackupReaderSettings /></div>)}
          {panel("notifications", <NotificationSettings active={section === "notifications"} />)}
          {panel("branding", <PdfBrandingSettings />)}
          {panel("updates", <Updates />)}
          {panel("appearance", <AppearanceSettings />)}
          {panel("about", <About active={section === "about"} />)}
        </div>
      </div>
    </div>
  )
}
