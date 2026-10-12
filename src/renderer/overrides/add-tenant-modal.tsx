import { showCommunityLimitError } from "../lib/plan-dialog"
import { useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import type { SignedInAccount } from "../../shared/ipc"
import { DELEGATED_CLIENT_SECRET } from "../../shared/constants"
import { StorageChooser } from "../components/StorageChooser"
import { SetupScriptCard, TenantSignInForm } from "../components/TenantSignInForm"
import { bridge } from "../lib/bridge"
import { storageResources, type StorageChoice } from "../lib/storage"

/**
 * Desktop replacement for ~/components/tenants/add-tenant-modal-redesigned.
 *
 * Step 1: the admin signs in through their own public client app registration (no
 * secret). Step 2: they choose where backups go, on this device (encrypted) or in
 * their own Azure storage account. The profile carries no secret: API calls use
 * delegated tokens. The license is checked at the sign-in and again before the tenant
 * is saved; a tenant the license does not cover is not added and its sign-in is removed.
 */

interface AddTenantModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onTenantAdded: (tenant: TenantCredentials) => void
}

export interface TenantCredentials {
  tenantId: string
  appId: string
  clientSecret: string
  displayName?: string
  storageAccountName?: string
  automationAccountName?: string
  resourceGroupName?: string
  subscriptionId?: string
  resourceGroupLocation?: string
  preconfigured?: boolean
}

export function desktopTenantCredentials(account: SignedInAccount, displayName: string, choice: StorageChoice): TenantCredentials {
  return {
    tenantId: account.tenantId,
    appId: account.clientId,
    clientSecret: DELEGATED_CLIENT_SECRET,
    displayName: displayName || undefined,
    ...storageResources(account.tenantId, choice),
    preconfigured: true,
  }
}

export function AddTenantModal({ open, onOpenChange, onTenantAdded }: AddTenantModalProps) {
  const [account, setAccount] = useState<{ account: SignedInAccount; displayName: string } | null>(null)
  const [choice, setChoice] = useState<StorageChoice | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState("")

  // The tenants page closes the dialog through `open`, so start fresh every time it opens.
  useEffect(() => {
    if (open) {
      setAccount(null)
      setChoice(null)
      setError("")
    }
  }, [open])

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setAccount(null)
      setChoice(null)
      setError("")
    }
    onOpenChange(next)
  }

  const add = async () => {
    if (!account || !choice) return
    setAdding(true)
    setError("")
    try {
      await bridge.license.checkNewTenant(account.account.tenantId)
      onTenantAdded(desktopTenantCredentials(account.account, account.displayName, choice))
    } catch (caught) {
      // The sign-in was removed: start over from the sign-in step.
      setAccount(null)
      setChoice(null)
      if (!showCommunityLimitError(caught)) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[620px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{account ? "Where should backups be stored?" : "Connect a tenant"}</DialogTitle>
          <DialogDescription>
            {account
              ? "You can change this later in Settings."
              : "Sign in with your own admin account through your own app registration. Backups and policy data stay in your chosen storage. License checks send your tenant identity and Microsoft ID token to TenuVault to verify entitlement; passwords are never sent."}
          </DialogDescription>
        </DialogHeader>

        {!account ? (
          <div className="space-y-5">
            <details><summary className="cursor-pointer text-sm font-medium text-blue-700">First time? Create an app registration</summary><div className="mt-3"><SetupScriptCard compact /></div></details>
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <TenantSignInForm
              onSignedIn={(signedIn, displayName) => {
                setError("")
                setAccount({ account: signedIn, displayName })
              }}
            />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-2xl bg-green-50 px-4 py-3 text-sm text-green-800">
              <CheckCircle2 className="h-4 w-4" />
              Signed in as {account.account.username}
            </div>
            <StorageChooser tenantId={account.account.tenantId} clientId={account.account.clientId} onChange={setChoice} />
          </div>
        )}

        {account && (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button
              className="bg-coral-600 text-white hover:bg-coral-700"
              disabled={!choice || adding}
              onClick={() => void add()}
            >
              {adding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Connect tenant
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
