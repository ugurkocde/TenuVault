import type { WriteRecord } from "../../main/storage/restore-journal"
import { getAppearance, setAppearance, type Appearance } from "../lib/appearance"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Download, FolderOpen, HardDrive, Info, KeyRound, Loader2, Lock, MonitorCog, RefreshCw, Save, Upload } from "lucide-react"
import { useTenantOperations, useTenants, type Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { storageLabel } from "~/lib/storage-label"
import type { AppInfo, AppPreferences, BackupSettings, SignedInAccount, UpdateStatus } from "../../shared/ipc"
import { LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import { COMMUNITY_RETENTION_DAYS } from "../../shared/plans"
import { LicenseAgreementLink } from "../components/LicenseAgreementDialog"
import { StorageChooser } from "../components/StorageChooser"
import { bridge } from "../lib/bridge"
import { storageResources, type StorageChoice } from "../lib/storage"
import { toast } from "../lib/toast"

function RestoreWrites() {
  const tenants = useTenants().filter(tenant => tenant.credentials?.tenantId)
  const [selected, setSelected] = useState("")
  const tenantId = tenants.some(tenant => tenant.credentials?.tenantId === selected) ? selected : tenants[0]?.credentials?.tenantId
  if (!tenantId) return <Card><CardContent className="pt-6">Connect and sign in to a tenant to view restore write history.</CardContent></Card>
  return <div className="space-y-3"><label className="block text-sm">Restore history tenant<select className="ml-3 rounded border bg-background p-2" value={tenantId} onChange={event => setSelected(event.target.value)}>{tenants.map(tenant => <option key={tenant.id} value={tenant.credentials!.tenantId}>{tenant.name}</option>)}</select></label><TenantRestoreWrites key={tenantId} tenantId={tenantId} /></div>
}

function TenantRestoreWrites({ tenantId }: { tenantId: string }) {
  const [records, setRecords] = useState<WriteRecord[]>([])
  const [error, setError] = useState("")
  const request = async (body: object) => {
    try {
      const response = await fetch("/api/restore-journal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, tenantId }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      if (!Array.isArray(data.records)) throw new Error("Invalid restore history response")
      setError("")
      setRecords(data.records)
    } catch (error) { setRecords([]); throw error }
  }
  useEffect(() => { void request({ action: "list" }).catch(e => setError(String(e))) }, [])
  return <Card><CardHeader><CardTitle>Restore write history</CardTitle><Button variant="outline" onClick={() => void request({ action: "list" }).catch(e => setError(String(e)))}>Refresh history</Button><CardDescription>Interrupted writes stay blocked across restarts. Check the target tenant in Intune before resolving an uncertain result. Request payloads and tokens are not stored here.</CardDescription></CardHeader><CardContent>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {!records.length && <p>No restore writes recorded.</p>}
    {records.slice().reverse().map(record => <div key={record.key} className="border-t py-3 text-sm">
      <p className="font-medium">{record.label ?? "Object name unavailable"}</p>
      <p>{record.at} · {record.state} · Tenant {record.tenant}</p><p className="break-all">{record.method} {record.path}{record.objectId ? ` · Object ${record.objectId}` : ""}</p>
      {record.state === "reconciled" && <Button className="mt-2 mr-2" variant="outline" onClick={() => { const objectId = window.prompt("After checking the original policy name and tenant in Intune, enter the corrected object ID. The next retry will read and verify its creation fields before any follow-up writes.", record.objectId); if (objectId) void request({ action: "applied", key: record.key, objectId, confirmed: true }).catch(e => setError(String(e))) }}>Correct applied ID</Button>}
      {record.state === "reconciled" && <Button className="mt-2" variant="outline" onClick={() => { if (window.confirm("Start a new operation with this request? Future attempts will send the write again and may create another object. Do not clear this while resuming a repair.")) void request({ action: "new-operation", key: record.key, confirmed: true }).catch(e => setError(String(e))) }}>Allow a new operation</Button>}
      {record.state === "uncertain" && <div className="mt-2 flex gap-3">
        <Button variant="outline" onClick={() => { const objectId = window.prompt("After checking Intune, enter the ID of the object this request applied to. A retry will reuse this result instead of repeating the write."); if (objectId) void request({ action: "applied", key: record.key, objectId, confirmed: true }).catch(e => setError(String(e))) }}>Confirm applied</Button>
        <Button variant="outline" onClick={() => { if (window.confirm("I checked the target tenant in Intune and confirmed this request was NOT applied. Allow another attempt?")) void request({ action: "not-applied", key: record.key, confirmed: true }).catch(e => setError(String(e))) }}>Confirm not applied</Button>
      </div>}
    </div>)}
  </CardContent></Card>
}

function BackupsOnDevice() {
  const [settings, setSettings] = useState<BackupSettings | null>(null)
  const [recoveryKey, setRecoveryKey] = useState("")
  const [importing, setImporting] = useState(false)

  useEffect(() => void bridge.backups.settings().then(setSettings), [])

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
          if (result.imported) toast(`Imported ${result.backupId}. Select this device as storage for tenant ${result.tenantId} to preview and restore it.`, "success")
        })}><Upload className="mr-2 h-4 w-4" /> Import backup ZIP</Button>
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
              variant="outline"
              size="sm"
              onClick={() =>
                void run(async () => {
                  const result = await bridge.backups.exportRecoveryKey()
                  if (result.saved) toast(`Recovery key saved to ${result.path}. Move it to a safe place.`, "success")
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
            <div className="space-y-2">
              <textarea aria-label="Recovery key"
                className="min-h-16 w-full rounded-2xl border border-gray-300 px-4 py-3 font-mono text-xs"
                placeholder="TVK2.... (or a legacy TVK1 key)"
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                spellCheck={false}
              />
              <p className="text-xs text-gray-500">
                The imported key encrypts new backups. Backups made with the previous key stay readable.
              </p>
              <Button
                size="sm"
                disabled={!recoveryKey.trim()}
                onClick={() =>
                  void run(async () => {
                    const imported = await bridge.backups.importRecoveryKey(recoveryKey)
                    if (!imported) return
                    setSettings(imported)
                    setRecoveryKey("")
                    setImporting(false)
                    toast("Recovery key imported.", "success")
                  })
                }
              >
                Import
              </Button>
            </div>
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

function TenantSettings() {
  const tenants = useTenants()
  const { updateTenant } = useTenantOperations()
  const [accounts, setAccounts] = useState<SignedInAccount[]>([])
  const [editing, setEditing] = useState<Tenant | null>(null)
  const [choice, setChoice] = useState<StorageChoice | null>(null)
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
                  <Button variant="ghost" size="sm" onClick={() => { setChoice(null); setEditing(tenant) }} disabled={!tenant.credentials}>
                    Change storage
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
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
              onChange={setChoice}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!choice} onClick={saveStorage}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function BackgroundAndRetention() {
  const [prefs, setPrefs] = useState<AppPreferences | null>(null)
  const [launcher, setLauncher] = useState<{ supported: boolean; installed: boolean } | null>(null)
  const [launchBusy, setLaunchBusy] = useState(false)
  useEffect(() => { void bridge.backgroundLaunch.status().then(setLauncher).catch(error => toast(String(error), "error")) }, [])
  useEffect(() => void bridge.preferences.get().then(setPrefs), [])
  const set = async (changes: Partial<AppPreferences>) => {
    try {
      setPrefs(await bridge.preferences.set(changes))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error")
    }
  }
  if (!prefs) return null
  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><MonitorCog className="h-[18px] w-[18px]" /></span> Background and retention
        </CardTitle>
        <CardDescription>Automatic backups run while TenuVault is running, in the window or in the system tray.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-7 pb-7 text-sm text-gray-700">
        <div className="rounded-xl border border-gray-200 p-4">
          <p className="font-medium">Restart TenuVault for scheduled backups</p>
          <p className="mt-2 text-sm">An OS task can reopen TenuVault in the tray within five minutes while you are signed in. Backups still require valid Microsoft sign-in, plan access and available storage. This does not run while signed out, asleep or powered off.</p>
          <Button className="mt-3" variant="outline" disabled={!launcher?.supported || launchBusy} onClick={() => {
            setLaunchBusy(true)
            void (launcher?.installed ? bridge.backgroundLaunch.remove() : bridge.backgroundLaunch.install()).then(setLauncher).catch(error => toast(String(error), "error")).finally(() => setLaunchBusy(false))
          }}>{launcher?.installed ? "Remove background launch" : "Install background launch"}</Button>
          {launcher && !launcher.supported && <p className="mt-2 text-xs">Available in installed Windows and macOS builds.</p>}
          <p className="mt-2 text-xs">To stop automatic restarts, remove background launch and turn off Start at login before quitting. Removing it leaves your backup schedules unchanged.</p>
        </div>
        <label className="flex items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={prefs.startAtLogin} onChange={(e) => void set({ startAtLogin: e.target.checked })} />
          Start TenuVault in the tray when I sign in to this computer
        </label>
        <label className="flex items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={prefs.keepRunningInTray} onChange={(e) => void set({ keepRunningInTray: e.target.checked })} />
          Keep running in the tray when I close the window
        </label>
        <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
          <label htmlFor="retention">Keep backups for</label>
          <select
            id="retention"
            className="h-10 rounded-full border border-gray-300 bg-white px-4"
            value={prefs.retentionDays}
            onChange={(e) => void set({ retentionDays: Number(e.target.value) })}
          >
            {[7, 14, 30, 60, 90, 180, 365].map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
            <option value={0}>Forever</option>
          </select>
        </div>
        <p className="text-xs text-gray-500">
          Older backups are deleted after each successful backup. The newest backup is always kept. Community tenants
          keep {COMMUNITY_RETENTION_DAYS} days at most; Pro and MSP tenants keep what you choose here.
        </p>
      </CardContent>
    </Card>
  )
}

function Updates() {
  const [prefs, setPrefs] = useState<AppPreferences | null>(null)
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" })
  useEffect(() => {
    void bridge.preferences.get().then(setPrefs)
    void bridge.updates.status().then(setStatus)
    return bridge.updates.onChanged(setStatus)
  }, [])
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
            onChange={(e) => void bridge.preferences.set({ autoUpdate: e.target.checked }).then(setPrefs)}
          />
          Download and install updates automatically
        </label>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={prefs.nightlyUpdates}
            disabled={prefs.autoUpdateManaged || !prefs.autoUpdate}
            onChange={(e) => void bridge.preferences.set({ nightlyUpdates: e.target.checked }).then(setPrefs)}
          />
          Get nightly builds
        </label>
        <p className="text-xs text-gray-500">
          Enable this to try preview builds between stable releases. Turn it off to download the current stable
          release, even if its version is older than your installed nightly. Changing channels replaces any pending
          update. Nightly builds may contain bugs.
        </p>
        <p className="text-gray-600">{describe()}</p>
        <div className="flex gap-2">
          {status.state === "ready" ? (
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => void bridge.updates.install()}>
              Restart and update
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={!prefs.autoUpdate || status.state === "checking"} onClick={() => void bridge.updates.check().then(setStatus)}>
              <RefreshCw className="mr-2 h-4 w-4" /> Check now
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => void bridge.app.info().then(setInfo), [])
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
          <LicenseAgreementLink />
          {" · "}
          <button type="button" className="text-blue-600 hover:underline" onClick={() => void bridge.app.openExternal("https://tenuvault.com/")}>
            Website and support
          </button>
        </p>
      </CardContent>
    </Card>
  )
}

export default function SettingsPage() {
  return (
    <div className="max-w-5xl space-y-6 p-6 lg:p-8">
      <div className="flex flex-wrap items-end justify-between gap-6 pb-2">
        <div>
          <h1 className="text-4xl font-medium tracking-tight text-gray-900">Settings</h1>
          <p className="mt-2 text-lg text-gray-500">Sign-in, backup storage, encryption, background backups and updates.</p>
        </div>
      <label className="flex items-center gap-3 text-sm font-medium text-gray-600">Appearance
        <select className="h-10 rounded-full border border-gray-200 bg-white px-4 text-gray-900" defaultValue={getAppearance()} onChange={e => setAppearance(e.target.value as Appearance)}>
          <option value="system">Use system setting</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </label>
      </div>
      <nav aria-label="Settings sections" className="flex flex-wrap gap-2 text-sm">
        {[['signin', 'Sign-in'], ['storage', 'Storage and recovery'], ['background', 'Background and retention'], ['updates', 'Updates'], ['about', 'About']].map(([id, title]) => <button key={id} type="button" className="h-9 rounded-full bg-card px-4 font-medium text-foreground transition-colors hover:bg-primary hover:text-primary-foreground" onClick={() => document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' })}>{title}</button>)}
      </nav>
      <section className="scroll-mt-6" id="settings-signin"><TenantSettings /></section>
      <section className="scroll-mt-6" id="settings-storage"><BackupsOnDevice />
      <RestoreWrites /></section>
      <section className="scroll-mt-6" id="settings-background"><BackgroundAndRetention /></section>
      <section className="scroll-mt-6" id="settings-updates"><Updates /></section>
      <section className="scroll-mt-6" id="settings-about"><About /></section>
    </div>
  )
}
