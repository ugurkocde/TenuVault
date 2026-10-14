import { useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Cloud, HardDrive, Loader2, Lock } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Label } from "~/components/ui/label"
import { cn } from "~/lib/utils"
import { bridge } from "../lib/bridge"
import { useTenantPlan } from "../lib/license"
import { useBackupSettings, useLocalInventoryProblems } from "../lib/local-inventory"
import { listStorageAccounts, type AzureStorageAccount, type StorageChoice } from "../lib/storage"
import { UnreadableBackupsNotice } from "./UnreadableBackupsNotice"
import { PlanBadge, UpgradeNote } from "./UpgradeNote"

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
  const [settings, setSettings] = useBackupSettings()
  const [accounts, setAccounts] = useState<AzureStorageAccount[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [selected, setSelected] = useState(initial?.kind === "azure" ? initial.storageAccountName : "")
  const [verifying, setVerifying] = useState(false)
  const [verified, setVerified] = useState(false)
  const [verifyError, setVerifyError] = useState("")
  // Community keeps backups on this device; Azure storage is a paid feature.
  const community = useTenantPlan(tenantId) === "community"

  // A warning only: the local choice is never held back, and the first backup reports what is wrong.
  const inventory = useLocalInventoryProblems(settings, [tenantId])
  const affected = inventory.affected.length > 0

  useEffect(() => {
    if (kind !== "azure" || accounts || community) return
    listStorageAccounts(tenantId, clientId)
      .then(setAccounts)
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
  }, [kind, accounts, tenantId, clientId])

  useEffect(() => {
    if (kind === "local") return onChange({ kind: "local" })
    if (community) return onChange(null)
    const account = accounts?.find((a) => a.name === selected)
    onChange(
      account && verified
        ? { kind: "azure", storageAccountName: account.name, subscriptionId: account.subscriptionId, resourceGroupName: account.resourceGroup, location: account.location }
        : null,
    )
    // onChange is a callback prop; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, selected, verified, accounts, community])

  const verify = async () => {
    setVerifying(true)
    setVerifyError("")
    try {
      await bridge.backups.verifyAzureStorage(tenantId, clientId, selected)
      setVerified(true)
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : String(error))
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
        "Backups are encrypted with AES-256-GCM before upload to your subscription. Save the recovery key in Settings before your first backup; other devices need it to read these backups. You need the Storage Blob Data Contributor role on it.",
        community,
      )}
      {community && <UpgradeNote feature="azureStorage" />}
      {kind === "azure" && !community && (
        <div className="ml-14 space-y-3">
          {!accounts && !loadError && (
            <p className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your storage accounts...
            </p>
          )}
          {loadError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          )}
          {accounts && accounts.length === 0 && (
            <p className="text-sm text-gray-600">No storage accounts found that your account can see. Ask an Azure administrator to create one and grant you access.</p>
          )}
          {accounts && accounts.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="storage-account">Storage account</Label>
              <div className="flex gap-2">
                <select
                  id="storage-account"
                  className="h-10 min-w-0 flex-1 rounded-full border border-gray-300 bg-white px-4 text-sm"
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value)
                    setVerified(false)
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
