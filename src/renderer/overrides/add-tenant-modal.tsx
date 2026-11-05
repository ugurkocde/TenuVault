import { useEffect, useRef } from "react"
import { useNavigate } from "react-router-dom"
import type { SignedInAccount } from "../../shared/ipc"
import { DELEGATED_CLIENT_SECRET } from "../../shared/constants"
import { storageResources, type StorageChoice } from "../lib/storage"

/**
 * Desktop replacement for ~/components/tenants/add-tenant-modal-redesigned.
 *
 * Connecting a tenant has one path on the desktop: the guided setup (Set up TenuVault), which
 * explains the app registration, signs in, chooses storage and takes a first backup. Every
 * Connect tenant button of the portal pages opens it. The profile carries no secret: API calls
 * use delegated tokens.
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

/** Opens the guided setup whenever a portal page asks for the Connect tenant dialog. */
export function AddTenantModal({ open, onOpenChange }: AddTenantModalProps) {
  const navigate = useNavigate()
  const close = useRef(onOpenChange)
  close.current = onOpenChange
  useEffect(() => {
    if (!open) return
    close.current(false)
    void navigate("/portal/onboarding")
  }, [open, navigate])
  return null
}
