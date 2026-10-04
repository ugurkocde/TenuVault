import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  AlertCircle,
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Sparkles,
  WifiOff,
} from "lucide-react"
import { useTenants } from "~/contexts/TenantContext"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Checkbox } from "~/components/ui/checkbox"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import type { LicenseStatus, TenantLicenseStatus } from "../../shared/ipc"
import { LicenseAgreementLink } from "../components/LicenseAgreementDialog"
import { bridge } from "../lib/bridge"
import { formatDateTime, isUnlicensed, planName, useLicense } from "../lib/license"

type Busy = "activate" | "deactivate" | `retry:${string}` | `share:${string}` | null

function useAction() {
  const { refresh } = useLicense()
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const run = async (name: Busy, action: () => Promise<LicenseStatus | void>, success?: (result: LicenseStatus | void) => string | null) => {
    setBusy(name)
    setError("")
    setNotice("")
    try {
      const result = await action()
      setNotice(success?.(result) ?? "")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      await refresh()
    }
  }
  return { busy, error, notice, run }
}

function TrialCallToAction() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-blue-50/60 p-5">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-3 text-base font-medium text-gray-900">
          <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-coral-500 text-white" aria-hidden="true">
            <Sparkles className="h-4 w-4" />
          </span>
          You are on Community, the free plan. Try Pro or MSP free for 30 days.
        </p>
        <p className="mt-2 text-sm text-gray-600">
          Community covers one tenant with manual and weekly backups. Pro covers two tenants and adds daily backups, full
          restore, replace in place, drift revert, Azure storage and the audit log. New MSP subscriptions include 5
          tenants and add cross tenant views and bulk actions. Your license key arrives by email right after checkout, and
          you are not charged until the trial ends.
        </p>
      </div>
      <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void bridge.license.open("buy")}>
        <ExternalLink className="mr-2 h-4 w-4" />
        Start 30 day free trial
      </Button>
    </div>
  )
}

function TenantRow({
  tenant,
  name,
  busy,
  onRetry,
  onShare,
}: {
  tenant: TenantLicenseStatus
  name: string | undefined
  busy: Busy
  onRetry: () => void
  onShare: (shared: boolean) => void
}) {
  const organization = tenant.entitled && tenant.source === "tenant"
  const keyHolder = tenant.entitled && tenant.source === "key"
  return (
    <div className="space-y-2 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-gray-900">{name ?? tenant.tenantId}</p>
          <p className="truncate font-mono text-xs text-gray-500">{tenant.tenantId}</p>
        </div>
        {tenant.entitled ? (
          <Badge variant="green">{organization ? `Active through your organization (${planName(tenant.plan)})` : `Active, ${planName(tenant.plan)}`}</Badge>
        ) : tenant.plan === "community" ? (
          <Badge variant="gray">Community (free)</Badge>
        ) : tenant.signedIn ? (
          <Badge variant="orange">Not active</Badge>
        ) : (
          <Badge variant="gray">Not signed in</Badge>
        )}
        {tenant.signedIn && !tenant.entitled && (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={onRetry}>
            {busy === `retry:${tenant.tenantId}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Retry
          </Button>
        )}
      </div>
      {tenant.entitled && tenant.expiresAt && (
        <p className="text-xs text-gray-500">
          Verified until {formatDateTime(tenant.expiresAt)}
          {organization && tenant.displayKey ? ` · Organization license ${tenant.displayKey}` : ""}
        </p>
      )}
      {!tenant.entitled && tenant.message && <p className="text-xs text-orange-700">{tenant.message}</p>}
      {keyHolder && (
        <div className="rounded-2xl bg-gray-50 p-4">
          <label className="flex items-center gap-2 text-sm text-gray-900">
            <Checkbox
              checked={tenant.shared === true}
              disabled={busy !== null}
              onCheckedChange={(checked) => onShare(checked === true)}
            />
            Let other admins in this tenant use this license
            {busy === `share:${tenant.tenantId}` && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </label>
          <p className="mt-1 text-xs text-gray-500">
            Anyone who signs in to this tenant with the same TenuVault app registration is licensed automatically. The key
            stays on this machine.
          </p>
          {tenant.shareNeedsSignIn && (
            <p className="mt-1 text-xs text-orange-700">Sign in to this tenant again to share the license with it.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function LicensePage() {
  const { status, refresh } = useLicense()
  const tenants = useTenants()
  const [key, setKey] = useState("")
  const { busy, error, notice, run } = useAction()

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!status) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    )
  }

  const nameOf = (tenantId: string) =>
    tenants.find((t) => t.credentials?.tenantId?.toLowerCase() === tenantId)?.name
  const tenantRows: TenantLicenseStatus[] = [...status.tenants]
  for (const profile of tenants) {
    const id = profile.credentials?.tenantId.toLowerCase()
    if (id && !tenantRows.some(row => row.tenantId.toLowerCase() === id)) {
      tenantRows.push({
        tenantId: id, signedIn: false, activated: false, entitled: false,
        source: null, plan: null, tenants: null, expiresAt: null, shared: null,
        shareNeedsSignIn: false, displayKey: null, message: 'Sign in to check this tenant’s license.',
      })
    }
  }
  const activeKeyTenants = status.tenants.filter((t) => t.entitled && t.source === "key").length
  const signedIn = status.tenants.filter((t) => t.signedIn).length

  const activate = () =>
    void run(
      "activate",
      async () => {
        const result = await bridge.license.setKey(key.trim())
        setKey("")
        return result
      },
      (result) =>
        result && result.tenants.some((t) => t.entitled && t.source === "key")
          ? "License activated."
          : "License key saved. It activates for a tenant when you sign in to it.",
    )
  const deactivate = () => {
    if (!window.confirm("Deactivate this machine? Backups that require this license will stop. Your existing backups remain available. Save your license key so you can activate again.")) return
    void run("deactivate", () => bridge.license.deactivate(), () =>
      status.hasKey
        ? "This machine was deactivated. You can use the key on another machine."
        : "This machine was deactivated.",
    )
  }
  const retry = (tenantId: string) =>
    void run(`retry:${tenantId}`, () => bridge.license.retry(tenantId), (result) =>
      result?.tenants.find((t) => t.tenantId === tenantId)?.entitled ? "License activated for this tenant." : null,
    )
  const share = (tenantId: string, shared: boolean) =>
    void run(`share:${tenantId}`, () => bridge.license.setShared(tenantId, shared), () =>
      shared
        ? "Other admins in this tenant can now use this license after signing in."
        : "Other admins in this tenant can no longer use this license.",
    )

  const title = isUnlicensed(status)
    ? "Add your license"
    : status.plan
      ? `${planName(status.plan)} plan active`
      : status.hasKey
        ? "License key saved"
        : "Licensed through your organization"

  return (
    <div className="max-w-5xl space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-4xl font-medium tracking-tight text-gray-900">License</h1>
        <p className="mt-2 max-w-3xl text-base text-gray-500">
          Each tenant you connect needs a license. TenuVault checks it with tenuvault.com when a tenant is first used and
          every few hours, and keeps working offline for up to 14 days after the last check.
        </p>
      </div>

      <Card>
        <CardHeader className="p-7 pb-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-3 text-2xl font-medium">
                <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-full bg-secondary" aria-hidden="true">
                  {status.plan ? (
                    <BadgeCheck className="h-[18px] w-[18px] text-green-600" />
                  ) : (
                    <KeyRound className="h-[18px] w-[18px] text-gray-600" />
                  )}
                </span>
                {title}
              </CardTitle>
              <CardDescription className="mt-2">
                {isUnlicensed(status)
                  ? "Paste the license key from your purchase email, or start a free trial."
                  : status.plan
                    ? `Your license covers ${status.tenantLimit ?? 1} tenant${status.tenantLimit === 1 ? "" : "s"}. ${activeKeyTenants} ${activeKeyTenants === 1 ? "is" : "are"} active on this machine.`
                    : status.hasKey
                      ? signedIn === 0
                        ? "Your key is saved. It activates for a tenant when you sign in to it."
                        : "Your key is saved but not active for your signed-in tenants. Check the tenants below."
                      : "A tenant admin shared their TenuVault license with your tenant."}
              </CardDescription>
            </div>
            {status.plan && <Badge variant="secondary">{planName(status.plan)}</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-5 px-7 pb-7">
          {status.offline && (
            <Alert>
              <WifiOff className="h-4 w-4" />
              <AlertDescription>
                The licensing service could not be reached. Tenants that are already active keep working until their
                verification expires.
              </AlertDescription>
            </Alert>
          )}
          {status.message && signedIn > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription>{status.message}</AlertDescription>
            </Alert>
          )}

          {isUnlicensed(status) && <TrialCallToAction />}

          {status.hasKey ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-gray-50 px-5 py-4">
              <div>
                <div className="text-xs font-medium text-gray-500">License key</div>
                <div className="mt-1 font-mono text-sm text-gray-900">{status.keyHint}</div>
              </div>
            </div>
          ) : (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (key.trim()) activate()
              }}
            >
              <Label htmlFor="license-key">License key</Label>
              <div className="flex gap-2">
                <Input
                  id="license-key"
                  className="font-mono"
                  placeholder="Paste the key from your purchase email"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  spellCheck={false}
                  disabled={busy !== null}
                />
                <Button type="submit" disabled={busy !== null || !key.trim()}>
                  {busy === "activate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  Activate
                </Button>
              </div>
              <p className="text-xs text-gray-500">
                Licensed through your organization? <Link to="/portal/onboarding" className="text-blue-600 hover:underline">Sign in to your tenant</Link>{" "}
                and TenuVault uses the license a tenant admin shared with it.
              </p>
            </form>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {notice && (
            <Alert>
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            {status.hasKey && (
              <Button variant="outline" onClick={() => void bridge.license.open("portal")}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Manage subscription
              </Button>
            )}
            {!isUnlicensed(status) && (
              <Button variant="ghost" disabled={busy !== null} onClick={deactivate}>
                {busy === "deactivate" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Deactivate this machine
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {tenantRows.length > 0 && (
        <Card>
          <CardHeader className="p-7 pb-4">
            <CardTitle className="text-xl font-medium">Tenants</CardTitle>
            <CardDescription>
              The license state of every tenant on this machine. Removing a tenant from TenuVault frees its place on the
              license.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-7 pb-7">
            <div className="divide-y divide-gray-100">
              {tenantRows.map((tenant) => (
                <TenantRow
                  key={tenant.tenantId}
                  tenant={tenant}
                  name={nameOf(tenant.tenantId)}
                  busy={busy}
                  onRetry={() => retry(tenant.tenantId)}
                  onShare={(shared) => share(tenant.tenantId, shared)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-gray-500">
        License checks send the license key, your Microsoft sign-in (ID) token or both: the token proves the tenant for an
        organization license or for sharing the license with it, is verified and only its tenant ID used, never stored. They also send a random installation ID, the tenant ID, the app
        registration client ID and the app version. Tenant configuration and backups are never sent.
        {!status.persisted &&
          " Secure storage is not available on this system, so the license is kept in memory only and must be entered again after a restart."}
      </p>

      <p className="text-xs text-gray-500">
        Official TenuVault builds are licensed under the <LicenseAgreementLink label="license agreement" />. The source
        code is available under the Business Source License 1.1.
      </p>
    </div>
  )
}
