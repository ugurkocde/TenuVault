import { useEffect, useState } from "react"
import { useLocation } from "react-router-dom"
import { Cloud, KeyRound } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { useSelectedTenant, useTenantOperations, useTenants } from "~/contexts/TenantContext"
import type { PackConsentPlan } from "../../shared/pack-consent"
import {
  OWN_APP_UPGRADE,
  SIGN_IN_METHODS,
  START_NOW_REMOVED_REASON,
  TENUVAULT_APP_UNAVAILABLE,
  connectionNeedsMethod,
  type ConnectionSwitchResult,
  type TenantConnection,
} from "../../shared/tenant-connection"
import { isGuid } from "../../shared/security"
import { DEFAULT_ONBOARDING_CHOICE } from "../../shared/services/onboarding"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"
import { toast } from "../lib/toast"
import { ConnectTenantSetup } from "./ConnectTenantSetup"
import { NoticeCard } from "./NoticeCard"
import { TenuVaultConsent } from "./TenuVaultConsent"

export function OwnAppSwitchDialog({
  open,
  onOpenChange,
  tenantId,
  currentClientId,
  title,
  description,
  onSwitched,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tenantId: string
  currentClientId: string
  title: string
  description: string
  onSwitched: (result: ConnectionSwitchResult) => void
}) {
  const { status } = useLicense()
  const [nextClientId, setNextClientId] = useState("")
  const [creating, setCreating] = useState(false)
  const [setupRunning, setSetupRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [setupNote, setSetupNote] = useState<string>()

  useEffect(() => {
    if (open) {
      setNextClientId("")
      setCreating(false)
      setError(undefined)
      setSetupNote(undefined)
    }
  }, [open, tenantId])

  const tenantLicense = status?.tenants.find(tenant => tenant.tenantId === tenantId.toLowerCase())

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const outcome = await bridge.auth.switchConnection(tenantId, { method: "ownApp", clientId: nextClientId.trim() })
      if ("error" in outcome) {
        setError(outcome.error.message)
        return
      }
      onSwitched(outcome.result)
      onOpenChange(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The app registration could not be changed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!busy && !setupRunning) onOpenChange(value) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {creating ? (
          <div className="space-y-3">
            <ConnectTenantSetup
              choice={DEFAULT_ONBOARDING_CHOICE}
              expectedTenant={tenantId}
              onRunningChange={setSetupRunning}
              onManual={() => setCreating(false)}
              onRegistered={(result) => {
                setNextClientId(result.clientId)
                setCreating(false)
                setSetupNote("App registration ready. Select Sign in to connect this tenant.")
              }}
            />
            {!setupRunning && (
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreating(false)}>Enter an existing client ID</Button>
              </DialogFooter>
            )}
          </div>
        ) : (
          <>
            {(tenantLicense?.source === "tenant" || tenantLicense?.organizationRenewalPending) && (
              <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
                Your organization license uses a shared app registration. Ask the license key holder to share the license using the new registration before your cached coverage expires.
              </p>
            )}
            {setupNote && <p role="status" className="text-sm text-green-700 dark:text-green-400">{setupNote}</p>}
            <label className="block text-sm font-medium">
              Application (client) ID
              <input
                className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                value={nextClientId}
                onChange={event => setNextClientId(event.target.value)}
                disabled={busy}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </label>
            <div>
              <button
                type="button"
                className="text-xs font-medium text-blue-700 underline underline-offset-2 disabled:opacity-50 dark:text-blue-400"
                disabled={busy}
                onClick={() => { setError(undefined); setCreating(true) }}
              >
                Need an app registration? Create it for me or use the setup script
              </button>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => {
                if (busy) void bridge.auth.cancelSignIn()
                else onOpenChange(false)
              }}>Cancel</Button>
              <Button
                disabled={busy || !isGuid(nextClientId.trim()) || nextClientId.trim().toLowerCase() === currentClientId.toLowerCase()}
                onClick={() => void submit()}
              >
                {busy ? "Waiting for sign-in" : "Sign in"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ChooseSignInMethodCard({
  tenantId,
  tenantName,
  initialPack,
  consent,
  tenuvaultAppAvailable,
  onChanged,
  className,
}: {
  tenantId: string
  tenantName?: string
  initialPack?: string
  consent: PackConsentPlan | null
  tenuvaultAppAvailable: boolean | null
  onChanged: (result: ConnectionSwitchResult) => void
  className?: string
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const tenuvaultReady = tenuvaultAppAvailable === true && Boolean(consent?.packs.length)
  const tenuvaultUnavailable = tenuvaultAppAvailable === false || (tenuvaultAppAvailable === true && consent !== null && !consent.packs.length)

  return (
    <NoticeCard
      tone="warning"
      className={className}
      summary="Choose a sign-in method"
      details={
        <div className="space-y-1.5">
          <p>Your existing backups, recovery key and backup history remain intact and readable.</p>
          <p>Scheduled backups for this tenant are paused until you choose a sign-in method.</p>
        </div>
      }
    >
      <p className="text-xs leading-relaxed">
        {tenantName ? `${tenantName}: ` : ""}{START_NOW_REMOVED_REASON}
      </p>
      {tenuvaultUnavailable && (
        <p role="status" className="text-xs text-muted-foreground">{TENUVAULT_APP_UNAVAILABLE}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {tenuvaultReady && consent ? (
          <TenuVaultConsent
            key={`${tenantId}/${initialPack ?? ""}`}
            tenantId={tenantId}
            plan={consent}
            initialPack={initialPack}
            active={false}
            label={`${SIGN_IN_METHODS.tenuvaultApp} (Recommended)`}
            variant="default"
            icon={<Cloud className="mr-1.5 size-3.5" aria-hidden="true" />}
            onChanged={result => {
              onChanged(result)
              toast("TenuVault app permissions verified.", "success")
            }}
          />
        ) : tenuvaultAppAvailable === null ? (
          <Button variant="outline" size="sm" disabled>
            <Cloud className="mr-1.5 size-3.5" aria-hidden="true" />
            Checking {SIGN_IN_METHODS.tenuvaultApp}...
          </Button>
        ) : null}
        <Button
          variant={tenuvaultReady ? "outline" : "default"}
          size="sm"
          onClick={() => setOwnOpen(true)}
        >
          <KeyRound className="mr-1.5 size-3.5" aria-hidden="true" />
          {SIGN_IN_METHODS.ownApp}
        </Button>
      </div>
      <OwnAppSwitchDialog
        open={ownOpen}
        onOpenChange={setOwnOpen}
        tenantId={tenantId}
        currentClientId=""
        title={OWN_APP_UPGRADE}
        description="Sign in with your own app registration for this tenant. Your backups and schedules stay with the tenant."
        onSwitched={result => {
          onChanged(result)
          toast(result.missing.length
            ? "App registration updated. Review missing permissions under Services and permissions."
            : "App registration updated.", "success")
        }}
      />
    </NoticeCard>
  )
}

/** Shown on load across the app whenever the active tenant has a removed Start now connection. */
export function ChooseSignInMethodBanner() {
  const { pathname, search } = useLocation()
  const tenants = useTenants()
  const { selectedTenant } = useSelectedTenant()
  const { updateTenant } = useTenantOperations()
  const activeTenant = selectedTenant ?? (tenants.length === 1 ? tenants[0] : null)
  const tenantId = activeTenant?.credentials?.tenantId ?? ""
  const [connection, setConnection] = useState<TenantConnection | null>(null)
  const [consent, setConsent] = useState<PackConsentPlan | null>(null)
  const [tenuvaultAvailable, setTenuvaultAvailable] = useState<boolean | null>(null)

  const onSignInSettings = pathname === "/portal/settings" && (new URLSearchParams(search).get("section") ?? "signin") === "signin"

  useEffect(() => {
    if (!tenantId) {
      setConnection(null)
      setConsent(null)
      setTenuvaultAvailable(null)
      return
    }
    let active = true
    const load = () => {
      const fetchConnection = bridge.auth?.connection
      if (!fetchConnection) return
      void fetchConnection(tenantId).then(async value => {
        if (!active) return
        setConnection(value)
        if (!connectionNeedsMethod(value)) {
          setConsent(null)
          setTenuvaultAvailable(null)
          return
        }
        const [available, plan] = await Promise.all([
          bridge.auth.tenuvaultAppAvailable?.().catch(() => false) ?? Promise.resolve(false),
          bridge.auth.packConsentPlan?.(tenantId).catch(() => null) ?? Promise.resolve(null),
        ])
        if (!active) return
        setTenuvaultAvailable(available === true)
        setConsent(plan ?? null)
      }).catch(() => {
        if (active) setConnection(null)
      })
    }
    load()
    const unsubscribe = bridge.auth?.onAccountsChanged?.(changed => {
      if (changed.toLowerCase() === tenantId.toLowerCase()) load()
    })
    return () => { active = false; unsubscribe?.() }
  }, [tenantId])

  if (!activeTenant || !tenantId || onSignInSettings || !connectionNeedsMethod(connection)) return null

  return (
    <div className="px-6 pt-5 lg:px-8" data-choose-sign-in-method>
      <ChooseSignInMethodCard
        tenantId={tenantId}
        tenantName={activeTenant.name}
        consent={consent}
        tenuvaultAppAvailable={tenuvaultAvailable}
        onChanged={result => {
          setConnection(result.connection)
          if (activeTenant.credentials) {
            updateTenant(activeTenant.id, { credentials: { ...activeTenant.credentials, appId: result.connection.clientId } })
          }
        }}
      />
    </div>
  )
}
