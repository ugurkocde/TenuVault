import { useEffect, useRef, useState } from "react"
import { AlertCircle, Check, CheckCircle2, Cloud, Copy, ExternalLink, HardDrive, Loader2, Lock, RefreshCw, Save } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Label } from "~/components/ui/label"
import { cn } from "~/lib/utils"
import storageSetupScript from "../../../resources/New-TenuVaultStorage.ps1?raw"
import { bridge } from "../lib/bridge"
import { useTenantPlan } from "../lib/license"
import { announceBackupSettings, backupSettingsRevision, useBackupSettings, useLocalInventoryProblems } from "../lib/local-inventory"
import { listStorageAccounts, type AzureStorageAccount, type StorageChoice } from "../lib/storage"
import { UnreadableBackupsNotice } from "./UnreadableBackupsNotice"
import { PlanBadge, UpgradeNote } from "./UpgradeNote"

const STORAGE_GUIDE_URL = "https://docs.tenuvault.com/getting-started/create-storage-account/"

interface StorageChooserProps {
  tenantId: string
  clientId: string
  initial?: StorageChoice
  /** Called with a verified choice, or null while the choice is incomplete or unverified. */
  onChange: (choice: StorageChoice | null) => void
}

/** Lets the admin keep backups encrypted on this device or in their own Azure storage account. */
export function StorageChooser({ tenantId, clientId, initial, onChange }: StorageChooserProps) {
  const [kind, setKind] = useState<StorageChoice["kind"]>(initial?.kind ?? "local")
  const [settingsError, setSettingsError] = useState("")
  const [settings, setSettings] = useBackupSettings((error) =>
    setSettingsError(error instanceof Error ? error.message : String(error)),
  )
  // Async settings reads below must never apply after this chooser is gone or after a
  // newer settings update arrived: a stale "key saved" read would reopen another
  // chooser's recovery key gate for a different, unsaved key.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const applySettingsRead = (startedRevision: number, next: Parameters<typeof setSettings>[0]): boolean => {
    if (!mountedRef.current || backupSettingsRevision() !== startedRevision) return false
    setSettings(next)
    setSettingsError("")
    announceBackupSettings(next)
    return true
  }
  const [accounts, setAccounts] = useState<AzureStorageAccount[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [selected, setSelected] = useState(initial?.kind === "azure" ? initial.storageAccountName : "")
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [verifying, setVerifying] = useState(false)
  // The account name access was confirmed for, so a check that resolves after the
  // selection moved can never mark the newly selected account as confirmed.
  const [verifiedFor, setVerifiedFor] = useState("")
  const verified = verifiedFor !== "" && verifiedFor === selected
  const [verifyError, setVerifyError] = useState("")
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [savingKey, setSavingKey] = useState(false)
  const [saveKeyError, setSaveKeyError] = useState("")
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState("")
  // Community keeps backups on this device; Azure storage is a paid feature.
  const community = useTenantPlan(tenantId) === "community"
  // Azure uploads are refused in the main process until the current recovery key has been
  // saved, so the Azure choice stays incomplete until then instead of failing at first backup.
  const recoveryReady = settings?.recoveryExported === true

  // A warning only: the local choice is never held back, and the first backup reports what is wrong.
  const inventory = useLocalInventoryProblems(settings, [tenantId])
  const affected = inventory.affected.length > 0

  useEffect(() => {
    if (kind !== "azure" || accounts || community) return
    let active = true
    listStorageAccounts(tenantId, clientId)
      .then((list) => {
        if (!active) return
        setAccounts(list)
        if (selectedRef.current && !list.some((a) => a.name === selectedRef.current)) {
          setSelected("")
          setVerifiedFor("")
          setVerifyError("")
        }
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => { active = false }
  }, [kind, accounts, tenantId, clientId, community, loadAttempt])

  useEffect(() => {
    if (kind === "local") return onChange({ kind: "local" })
    if (community) return onChange(null)
    const account = accounts?.find((a) => a.name === selected)
    onChange(
      account && verified && recoveryReady
        ? { kind: "azure", storageAccountName: account.name, subscriptionId: account.subscriptionId, resourceGroupName: account.resourceGroup, location: account.location }
        : null,
    )
    // onChange is a callback prop; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, selected, verified, accounts, community, recoveryReady])

  const refreshAccounts = () => {
    setLoadError("")
    setVerifyError("")
    setAccounts(null)
    // After a failed load accounts is already null, so only the new attempt retriggers the loader.
    setLoadAttempt((attempt) => attempt + 1)
  }

  const retrySettings = async () => {
    const startedRevision = backupSettingsRevision()
    try {
      const next = await bridge.backups.settings()
      applySettingsRead(startedRevision, next)
    } catch (error) {
      if (mountedRef.current && backupSettingsRevision() === startedRevision) {
        setSettingsError(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const saveRecoveryKey = async () => {
    setSavingKey(true)
    setSaveKeyError("")
    try {
      const result = await bridge.backups.exportRecoveryKey()
      if (result.saved && mountedRef.current) {
        const startedRevision = backupSettingsRevision()
        try {
          const next = await bridge.backups.settings()
          applySettingsRead(startedRevision, next)
        } catch (error) {
          if (mountedRef.current && backupSettingsRevision() === startedRevision) {
            setSettingsError(error instanceof Error ? error.message : String(error))
          }
        }
      }
    } catch (error) {
      if (mountedRef.current) setSaveKeyError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) setSavingKey(false)
    }
  }

  const copyStorageInstructions = async () => {
    setCopyError("")
    try {
      await navigator.clipboard.writeText(
        `# TenuVault backup storage setup\n# Guide: ${STORAGE_GUIDE_URL}\n# Save everything below as New-TenuVaultStorage.ps1 and run it as described in the guide.\n\n${storageSetupScript}`,
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error))
    }
  }

  const verify = async () => {
    const accountName = selected
    setVerifying(true)
    setVerifyError("")
    try {
      await bridge.backups.verifyAzureStorage(tenantId, clientId, accountName)
      setVerifiedFor(accountName)
    } catch (error) {
      if (selectedRef.current === accountName) {
        setVerifyError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setVerifying(false)
    }
  }

  const option = (value: StorageChoice["kind"], icon: React.ReactNode, title: string, description: string, locked = false) => (
    <button
      type="button"
      onClick={() => setKind(value)}
      disabled={locked}
      className={cn(
        "flex w-full items-start gap-4 rounded-3xl border-2 p-5 text-left transition-colors",
        kind === value ? "border-blue-500 bg-blue-50/60" : "border-transparent bg-gray-50 hover:bg-gray-100",
        locked && "cursor-not-allowed opacity-60 hover:bg-gray-50",
      )}
      aria-pressed={kind === value}
    >
      <span className={cn("flex size-10 flex-shrink-0 items-center justify-center rounded-full", kind === value ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")}>{icon}</span>
      <span>
        <span className="flex items-center gap-2 font-medium text-gray-900">{title}{locked && <PlanBadge feature="azureStorage" />}</span>
        <span className="mt-0.5 block text-sm text-gray-600">{description}</span>
      </span>
    </button>
  )

  return (
    <div className="space-y-3">
      {option(
        "local",
        <HardDrive className="h-5 w-5" />,
        "This device, encrypted",
        "Backups are encrypted with AES-256 and the key is protected by your Windows or macOS account. Nothing leaves this computer.",
      )}
      {kind === "local" && settings && (
        <div className="ml-14 space-y-1 rounded-2xl bg-gray-50 px-4 py-3 text-xs text-gray-600">
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5" />
            Folder: <span className="font-mono text-gray-800">{settings.localFolder}</span>
          </div>
          <p>Change the folder or save the recovery key in Settings. Without the recovery key, backups can only be read on this device.</p>
          {inventory.checking && !affected && (
            <p className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking this tenant's backups in the folder...</p>
          )}
        </div>
      )}
      {kind === "local" && affected && (
        <div className="ml-14">
          <UnreadableBackupsNotice settings={settings} affected={affected} checking={inventory.checking} onChange={setSettings} />
        </div>
      )}

      {option(
        "azure",
        <Cloud className="h-5 w-5" />,
        "Your Azure storage account, encrypted",
        "Backups are encrypted with AES-256-GCM before upload to your subscription. You need the Storage Blob Data Contributor role on it and a saved recovery key; other devices need that key to read these backups.",
        community,
      )}
      {community && <UpgradeNote feature="azureStorage" />}
      {kind === "azure" && !community && (
        <div className="ml-14 space-y-3">
          {settingsError && (
            <div className="space-y-2">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>Could not check whether your recovery key is saved: {settingsError} Azure storage stays unavailable until this check works.</AlertDescription>
              </Alert>
              <Button type="button" variant="outline" size="sm" onClick={() => void retrySettings()}>
                Try again
              </Button>
            </div>
          )}
          {!settings && !settingsError && (
            <p className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking your recovery key...
            </p>
          )}
          {settings && !recoveryReady && (
            <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">Save your recovery key before you continue</p>
              <p>
                Azure backups are encrypted with this device&apos;s key. Without the recovery key saved somewhere safe,
                such as your password manager, nobody can read them after a reinstall or on another device.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void saveRecoveryKey()} disabled={savingKey}>
                {savingKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save recovery key
              </Button>
              {saveKeyError && <p role="alert" className="text-red-700">{saveKeyError}</p>}
            </div>
          )}
          {!accounts && !loadError && (
            <p className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your storage accounts...
            </p>
          )}
          {loadError && (
            <>
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
              <Button type="button" variant="outline" size="sm" onClick={refreshAccounts}>
                <RefreshCw className="mr-2 h-4 w-4" /> Refresh
              </Button>
            </>
          )}
          {accounts && accounts.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">No storage accounts found that your account can see. Ask an Azure administrator to create one and grant you access.</p>
              <div className="space-y-2 rounded-2xl bg-blue-50/60 px-4 py-3 text-sm text-gray-700">
                <p className="font-medium text-gray-900">No storage account yet?</p>
                <p>
                  Send your Azure administrator the storage setup script. It creates the account with the recommended
                  settings and grants your admin group access. Afterwards, select Refresh here.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void copyStorageInstructions()}>
                    {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                    {copied ? "Copied" : "Copy setup instructions for your Azure administrator"}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void bridge.app.openExternal(STORAGE_GUIDE_URL)}>
                    <ExternalLink className="mr-2 h-4 w-4" /> Storage setup guide
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={refreshAccounts}>
                    <RefreshCw className="mr-2 h-4 w-4" /> Refresh
                  </Button>
                </div>
                {copyError && <p role="alert" className="text-sm text-red-700">{copyError}</p>}
              </div>
            </div>
          )}
          {accounts && accounts.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="storage-account">Storage account</Label>
                <Button type="button" variant="ghost" size="sm" onClick={refreshAccounts}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Refresh
                </Button>
              </div>
              <div className="flex gap-2">
                <select
                  id="storage-account"
                  className="h-10 min-w-0 flex-1 rounded-full border border-gray-300 bg-white px-4 text-sm"
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value)
                    setVerifyError("")
                  }}
                >
                  <option value="">Choose a storage account</option>
                  {accounts.map((a) => (
                    <option key={`${a.subscriptionId}/${a.name}`} value={a.name}>
                      {a.name} ({a.resourceGroup}, {a.location})
                    </option>
                  ))}
                </select>
                <Button type="button" variant="outline" className="shrink-0" onClick={() => void verify()} disabled={!selected || verifying || verified}>
                  {verifying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : verified ? <CheckCircle2 className="mr-2 h-4 w-4 text-green-600" /> : null}
                  {verified ? "Access confirmed" : "Check access"}
                </Button>
              </div>
              <p className="text-xs text-gray-500">TenuVault writes a test file to the intune-backups container to confirm you can store backups there.</p>
            </div>
          )}
          {verifyError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{verifyError}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  )
}
