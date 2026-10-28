import { useEffect, useId, useState } from "react"
import { Check, Copy, Download, ExternalLink, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { useTenants } from "~/contexts/TenantContext"
import { useConfirm } from "~/components/ConfirmDialog"
import readerScript from "../../../resources/New-TenuVaultBackupReader.ps1?raw"
import type { BackupReaderState } from "../../shared/ipc"
import { readerView } from "../lib/backup-reader-view"
import { isGuid } from "../../shared/security"
import { bridge } from "../lib/bridge"
import { showFeaturePlanError } from "../lib/plan-dialog"
import { toast } from "../lib/toast"
import { PlanBadge, UpgradeNote } from "./UpgradeNote"

const GUIDE_URL = "https://docs.tenuvault.com/backups/backup-reader/"
const CA_GUIDE_URL = "https://docs.tenuvault.com/security/conditional-access/"

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })

/**
 * Settings for the optional read-only Backup Reader: scheduled backups that keep running when
 * Conditional Access session controls end the admin's sign-in. One tenant at a time.
 */
export function BackupReaderSettings() {
  const tenants = useTenants().filter((tenant) => tenant.credentials?.tenantId)
  const { confirm, confirmDialog } = useConfirm()
  const ids = { tenant: useId(), appId: useId() }
  const [tenantId, setTenantId] = useState(tenants[0]?.credentials?.tenantId ?? "")
  const [state, setState] = useState<BackupReaderState | null>(null)
  const [appId, setAppId] = useState("")
  const [busy, setBusy] = useState<"prepare" | "export" | "verify" | "remove" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!tenantId && tenants[0]?.credentials?.tenantId) setTenantId(tenants[0].credentials.tenantId)
  }, [tenants, tenantId])
  useEffect(() => {
    if (!tenantId) return
    // A slow answer for the tenant selected before must not replace this tenant's state.
    let current = true
    setState(null)
    setError(null)
    bridge.backupReader.status(tenantId).then((next) => {
      if (!current) return
      setState(next)
      setAppId(next.reader?.clientId ?? "")
    }, (failure: unknown) => { if (current) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { current = false }
  }, [tenantId])

  const run = async (action: NonNullable<typeof busy>, work: () => Promise<BackupReaderState | void>) => {
    setBusy(action)
    setError(null)
    try {
      const next = await work()
      if (next) setState(next)
    } catch (failure) {
      if (!showFeaturePlanError(failure)) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }
  const copyScript = async () => {
    await navigator.clipboard.writeText(`# TenuVault Backup Reader setup\n# Guide: ${GUIDE_URL}\n# Save everything below as New-TenuVaultBackupReader.ps1 and run it as described in the guide.\n\n${readerScript}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  const remove = async () => {
    const ok = await confirm({
      title: "Remove the Backup Reader?",
      description: "Scheduled backups of this tenant use your own sign-in again. The private key is deleted from this computer. Also remove the certificate from the app registration in Entra ID.",
      confirmLabel: "Remove",
      destructive: true,
    })
    if (ok) await run("remove", () => bridge.backupReader.remove(tenantId))
  }

  if (!tenants.length) return null
  const { reader, verified, waiting, daysLeft, expiry, command, excluded, canAct } = readerView(state)
  const disabled = !canAct || !!busy

  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><ShieldCheck className="h-[18px] w-[18px]" /></span> Backup Reader
          {state && !state.available && <PlanBadge feature="backupReader" />}
        </CardTitle>
        <CardDescription>
          Optional. Keeps scheduled backups running when Conditional Access sign-in frequency ends your session. A separate
          read-only app registration with a certificate on this computer reads Intune for scheduled backups only. Manual
          backups, restores and every other change keep using your own sign-in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-7 pb-7 text-sm text-gray-700">
        {state && !state.available && <UpgradeNote feature="backupReader" />}
        {state && !state.supported && <p>Available in the installed Windows and macOS apps, where scheduled backups run.</p>}
        {tenants.length > 1 && (
          <div className="flex items-center gap-3">
            <label htmlFor={ids.tenant}>Tenant</label>
            <select id={ids.tenant} className="h-10 rounded-full border border-gray-300 bg-white px-4" value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
              {tenants.map((tenant) => <option key={tenant.id} value={tenant.credentials!.tenantId}>{tenant.name}</option>)}
            </select>
          </div>
        )}
        {!state && !error && <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading...</p>}

        {state && !reader && (
          <div className="space-y-3 rounded-xl border border-gray-200 p-4">
            <p>
              Use it when scheduled backups stop because Microsoft asks you to sign in again. Often the simpler fix is a
              Conditional Access change: see <button type="button" className="underline" onClick={() => void bridge.app.openExternal(CA_GUIDE_URL)}>Conditional Access and TenuVault</button>.
            </p>
            <p>
              What it can do: read all Intune configuration of the tenant, including script contents, and write new backups.
              What it cannot do: change Intune, delete backups, or read encrypted OMA-URI values in plain text (scheduled
              backups keep those masked; a manual backup captures them).
            </p>
            <Button disabled={disabled} onClick={() => void run("prepare", () => bridge.backupReader.prepare(tenantId))}>
              {busy === "prepare" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
              Set up the Backup Reader
            </Button>
          </div>
        )}

        {reader && verified && (
          <div className="space-y-2 rounded-xl border border-gray-200 p-4">
            <p className="font-medium">Scheduled backups of this tenant use the Backup Reader.</p>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-gray-500">Application ID</dt><dd className="font-mono">{reader.clientId}</dd>
              <dt className="text-gray-500">Certificate</dt><dd className="font-mono">{reader.thumbprintSha256.slice(0, 16)}...</dd>
              <dt className="text-gray-500">Valid until</dt><dd>{day(reader.notAfter)}{expiry ? ` (${expiry === "soon" ? `${daysLeft} days left` : "expired"})` : ""}</dd>
              <dt className="text-gray-500">Permissions</dt><dd>{reader.verifiedRoles?.join(", ")}</dd>
            </dl>
            {excluded.length > 0 && <p className="text-xs">Scheduled backups leave out {excluded.join(" and ")}; manual backups include them.</p>}
            {expiry && (
              <p role="alert" className="text-xs text-coral-700">
                {expiry === "soon" ? "The certificate expires soon." : "The certificate has expired, so scheduled backups use your sign-in again."}{" "}
                {reader.renewalPending ? "Upload the renewal certificate below and verify it." : "Renew it to keep scheduled backups independent of your sign-in."}
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-2">
              {!reader.renewalPending && (
                <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run("prepare", () => bridge.backupReader.prepare(tenantId))}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Renew certificate
                </Button>
              )}
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void run("verify", () => bridge.backupReader.verify(tenantId, reader.clientId, false))}>
                {busy === "verify" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />} Verify again
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void remove()}>
                <Trash2 className="mr-2 h-4 w-4" /> Remove
              </Button>
            </div>
          </div>
        )}

        {reader && waiting && (
          <ol className="list-decimal space-y-4 rounded-xl border border-gray-200 p-4 pl-9">
            <li>
              <p className="font-medium">{reader.renewalPending ? "Save the renewal certificate" : "Save the certificate"}</p>
              <p className="mt-1 text-xs">Only the public certificate. Its private key stays encrypted on this computer and is never shown or exported.</p>
              <Button className="mt-2" variant="outline" size="sm" disabled={!!busy} onClick={() => void run("export", async () => {
                const result = await bridge.backupReader.exportCertificate(tenantId)
                if (result.saved) toast("Certificate saved.", "success")
              })}>
                <Download className="mr-2 h-4 w-4" /> Save certificate
              </Button>
            </li>
            <li>
              <p className="font-medium">Run the setup script</p>
              <p className="mt-1 text-xs">As a Global Administrator or Privileged Role Administrator, in PowerShell:</p>
              <code className="mt-2 block break-all rounded-lg bg-secondary px-3 py-2 font-mono text-xs">{command}</code>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void copyScript()}>
                  {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}{copied ? "Copied" : "Copy setup script"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void bridge.app.openExternal(GUIDE_URL)}>
                  <ExternalLink className="mr-2 h-4 w-4" /> Setup guide
                </Button>
              </div>
              <p className="mt-2 text-xs">Backups in Azure Storage: an Azure administrator also runs New-TenuVaultStorage.ps1 with -BackupReaderAppId and the -SubscriptionId, -ResourceGroupName and -StorageAccountName of this tenant's backup storage account. It lets the reader write backups but not delete them.</p>
            </li>
            <li>
              <p className="font-medium">Verify</p>
              {reader.renewalPending ? (
                <p className="mt-1 text-xs">TenuVault checks the renewal certificate with Microsoft and switches to it.</p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  <label htmlFor={ids.appId} className="text-xs font-medium text-gray-500">Application (client) ID the script printed</label>
                  <Input id={ids.appId} value={appId} disabled={!!busy} placeholder="00000000-0000-0000-0000-000000000000" onChange={(event) => setAppId(event.target.value.trim())} />
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" disabled={disabled || !isGuid(reader.renewalPending ? reader.clientId : appId)} onClick={() => void run("verify", () => bridge.backupReader.verify(tenantId, reader.renewalPending ? reader.clientId : appId, reader.renewalPending))}>
                  {busy === "verify" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />} Verify
                </Button>
                {reader.renewalPending && (
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void run("remove", () => bridge.backupReader.cancelRenewal(tenantId))}>
                    <Trash2 className="mr-2 h-4 w-4" /> Cancel renewal
                  </Button>
                )}
                {!verified && (
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void remove()}>
                    <Trash2 className="mr-2 h-4 w-4" /> Cancel setup
                  </Button>
                )}
              </div>
              <p className="mt-2 text-xs">New certificates and permissions can take a few minutes to apply in Microsoft Entra ID.</p>
            </li>
          </ol>
        )}

        {state?.warning && !error && <p role="alert" className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900">{state.warning}</p>}
        {error && <p role="alert" className="rounded-xl bg-coral-50 px-4 py-3 text-coral-800">{error}</p>}
        {confirmDialog}
      </CardContent>
    </Card>
  )
}
