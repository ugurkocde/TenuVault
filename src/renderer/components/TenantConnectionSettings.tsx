import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import type { PackConsentPlan } from "../../shared/pack-consent"
import {
  ORGANIZATION_RENEWAL_NOTICE,
  OWN_APP_UPGRADE,
  SIGN_IN_METHODS,
  TENUVAULT_APP_UNAVAILABLE,
  connectionNeedsMethod,
  type TenantConnection,
} from "../../shared/tenant-connection"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"
import { toast } from "../lib/toast"
import { ChooseSignInMethodCard, OwnAppSwitchDialog } from "./ChooseSignInMethodCard"
import { TenuVaultConsent } from "./TenuVaultConsent"

export function TenantConnectionSettings({ tenantId, clientId, initialPack, onChanged }: {
  tenantId: string
  clientId: string
  initialPack?: string
  onChanged: (clientId: string) => void
}) {
  const [connection, setConnection] = useState<TenantConnection | null>(null)
  const [consent, setConsent] = useState<PackConsentPlan | null>(null)
  const [tenuvaultAvailable, setTenuvaultAvailable] = useState<boolean | null>(null)
  const { status } = useLicense()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let current = true
    setConsent(null)
    setTenuvaultAvailable(null)
    void bridge.auth.connection(tenantId).then(async value => {
      if (!current) return
      setConnection(value)
      if (value?.origin === "wizard") {
        const [available, plan] = await Promise.all([
          bridge.auth.tenuvaultAppAvailable?.().catch(() => false) ?? Promise.resolve(false),
          bridge.auth.packConsentPlan?.(tenantId).catch(() => null) ?? Promise.resolve(null),
        ])
        if (current) {
          setTenuvaultAvailable(available === true)
          setConsent(plan ?? null)
        }
      }
    }).catch(() => undefined)
    return () => { current = false }
  }, [tenantId, clientId])

  const tenantLicense = status?.tenants.find(tenant => tenant.tenantId === tenantId.toLowerCase())

  if (connection?.origin !== "wizard") return null

  if (connectionNeedsMethod(connection)) {
    return (
      <div className="mt-3">
        <ChooseSignInMethodCard
          tenantId={tenantId}
          initialPack={initialPack}
          consent={consent}
          tenuvaultAppAvailable={tenuvaultAvailable}
          onChanged={result => {
            setConnection(result.connection)
            onChanged(result.connection.clientId)
          }}
        />
      </div>
    )
  }

  const tenuvaultReady = tenuvaultAvailable === true && Boolean(consent?.packs.length)
  const tenuvaultUnavailable = tenuvaultAvailable === false || (tenuvaultAvailable === true && consent !== null && !consent.packs.length)

  return (
    <div className="mt-2 flex scroll-mt-4 flex-wrap items-center gap-2">
      <p className="text-xs text-gray-500">Sign-in method: {SIGN_IN_METHODS[connection.method!]}</p>
      {tenuvaultReady && consent && (
        <TenuVaultConsent
          key={`${tenantId}/${initialPack ?? ""}`}
          tenantId={tenantId}
          plan={consent}
          initialPack={initialPack}
          active={connection.method === "tenuvaultApp"}
          label={connection.method === "tenuvaultApp" ? "Review permission packs" : "Use TenuVault app (Recommended)"}
          onChanged={result => {
            setConnection(result.connection)
            onChanged(result.connection.clientId)
            toast("TenuVault app permissions verified.", "success")
          }}
        />
      )}
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {connection.method === "tenuvaultApp" ? OWN_APP_UPGRADE : "Change app registration"}
      </Button>
      {tenuvaultUnavailable && (
        <p role="status" className="basis-full text-xs text-muted-foreground">{TENUVAULT_APP_UNAVAILABLE}</p>
      )}
      {tenantLicense?.organizationRenewalPending && <p role="status" className="basis-full text-sm text-gray-600">{ORGANIZATION_RENEWAL_NOTICE}</p>}
      <OwnAppSwitchDialog
        open={open}
        onOpenChange={setOpen}
        tenantId={tenantId}
        currentClientId={connection.clientId}
        title={connection.method === "tenuvaultApp" ? OWN_APP_UPGRADE : "Change app registration"}
        description="Sign in with your own app registration for this tenant. Your backups and schedules stay with the tenant."
        onSwitched={result => {
          setConnection(result.connection)
          onChanged(result.connection.clientId)
          toast(result.missing.length
            ? "App registration updated. Review missing permissions under Services and permissions."
            : "App registration updated.", "success")
        }}
      />
    </div>
  )
}
