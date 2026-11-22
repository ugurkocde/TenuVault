import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ArrowRight, CheckCircle2, FileDown, FileUp, Info, Loader2, MinusCircle, XCircle } from "lucide-react"
import { useTenants } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Checkbox } from "~/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import type { ServicesStatus } from "../../shared/ipc"
import type { TransferApplyResult, TransferGroup, TransferItem, TransferPreview } from "../../shared/settings-transfer"
import { getAppearance, setAppearance } from "../lib/appearance"
import { bridge } from "../lib/bridge"
import { settingsHref } from "../lib/settings-section"
import { toast } from "../lib/toast"
import { PlanBadge } from "./UpgradeNote"

/** What a settings file never holds, said wherever a file is made. */
export const NEVER_EXPORTED = "Never included: sign-ins, license keys, the recovery key, Backup Reader certificates, proxy passwords, client secrets and logs."

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function connectedTenants(tenants: ReturnType<typeof useTenants>) {
  return tenants.flatMap((tenant) => (tenant.credentials?.tenantId ? [{ tenantId: tenant.credentials.tenantId.toLowerCase(), clientId: tenant.credentials.appId, name: tenant.name, domain: tenant.domain }] : []))
}

/** Which permissions an applied services change still needs, from the sign-in TenuVault already has. */
export function missingPermissions(status: ServicesStatus, moduleIds?: string[]): string[] {
  if (status.error) return [`The permissions could not be checked: ${status.error}`]
  return status.modules.filter((module) => module.enabled && module.check && (!moduleIds || moduleIds.includes(module.id))).flatMap((module) => {
    const missing = [module.check!.backup !== "ready" && "backups", module.check!.restore !== "ready" && "restores"].filter(Boolean)
    return missing.length ? [`${module.label}: permissions for ${missing.join(" and ")} are missing.`] : []
  })
}

/** Settings > Import and export. */
export function SettingsTransfer({ active, onApplied }: { active: boolean; onApplied: (result: TransferApplyResult) => void }) {
  const [exporting, setExporting] = useState(false)
  const [opening, setOpening] = useState(false)
  const [preview, setPreview] = useState<TransferPreview | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get("import")

  // Onboarding sends the admin here with the setup file it opened, once the tenant is connected.
  useEffect(() => {
    if (!active || !requested) return
    const next = new URLSearchParams(searchParams)
    next.delete("import")
    setSearchParams(next, { replace: true })
    bridge.settingsTransfer.preview(requested, getAppearance()).then(setPreview, (error: unknown) => toast(message(error), "error"))
  }, [active, requested, searchParams, setSearchParams])

  const openFile = async () => {
    setOpening(true)
    try {
      const opened = await bridge.settingsTransfer.import(getAppearance())
      if (opened) setPreview(opened)
    } catch (error) {
      toast(message(error), "error")
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="p-7 pb-4">
          <CardTitle className="flex items-center gap-3 text-xl font-medium">
            <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><FileDown className="h-[18px] w-[18px]" /></span> Export settings
          </CardTitle>
          <CardDescription>
            Save the settings of this computer and of your tenants as a readable JSON file: to keep as a backup, or to set up another admin&apos;s TenuVault the same way.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-7 pb-7 text-sm text-gray-700">
          <p className="text-xs text-gray-500">{NEVER_EXPORTED}</p>
          <Button type="button" variant="outline" onClick={() => setExporting(true)}><FileDown className="mr-2 h-4 w-4" aria-hidden="true" />Export settings</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="p-7 pb-4">
          <CardTitle className="flex items-center gap-3 text-xl font-medium">
            <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><FileUp className="h-[18px] w-[18px]" /></span> Import settings
          </CardTitle>
          <CardDescription>
            Open a settings file and review what would change. Nothing is applied until you choose the settings and select Apply.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-7 pb-7 text-sm text-gray-700">
          <p className="text-xs text-gray-500">Settings for a tenant apply only to the same tenant connected on this computer. A tenant that is not connected yet can be connected from a file that includes its connection details.</p>
          <Button type="button" variant="outline" disabled={opening} onClick={() => void openFile()}>
            {opening ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <FileUp className="mr-2 h-4 w-4" aria-hidden="true" />}Import settings
          </Button>
        </CardContent>
      </Card>
      <ExportDialog open={exporting} onOpenChange={setExporting} />
      {/* The review steps aside while "Save current settings first" exports, and comes back as it was. */}
      {preview && <ImportDialog preview={preview} paused={exporting} onClose={() => setPreview(null)} onApplied={onApplied} onExportFirst={() => setExporting(true)} />}
    </div>
  )
}

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const tenants = connectedTenants(useTenants())
  const [app, setApp] = useState(true)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [connection, setConnection] = useState(false)
  const [busy, setBusy] = useState(false)
  const connectionId = useId()
  const appId = useId()
  // Every opening starts with everything selected.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setApp(true)
      setChosen(new Set(tenants.map((tenant) => tenant.tenantId)))
      setConnection(false)
    }
  }
  const save = async () => {
    setBusy(true)
    try {
      const result = await bridge.settingsTransfer.export({ app, tenantIds: [...chosen], connection, appearance: getAppearance() })
      if (result.saved) {
        toast(`Saved ${result.path ?? "the settings file"}`, "success")
        onOpenChange(false)
      }
    } catch (error) {
      toast(message(error), "error")
    } finally {
      setBusy(false)
    }
  }
  const toggle = (tenantId: string, on: boolean) => setChosen((current) => { const next = new Set(current); if (on) next.add(tenantId); else next.delete(tenantId); return next })
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Export settings</DialogTitle>
          <DialogDescription>Choose what the file holds. You can still choose what to apply when you import it.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-4 overflow-y-auto text-sm">
          <label htmlFor={appId} className="flex items-start gap-3 rounded-2xl bg-secondary/60 p-3">
            <Checkbox id={appId} className="mt-0.5" checked={app} onCheckedChange={(value) => setApp(value === true)} />
            <span><span className="font-medium text-gray-900">This computer</span><span className="block text-xs text-gray-500">Keep backups for, tray and update settings, appearance and PDF branding.</span></span>
          </label>
          {tenants.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-gray-500">Tenants: services, what is backed up, schedule and cloud backup setup</legend>
              {tenants.map((tenant) => (
                <label key={tenant.tenantId} className="flex items-start gap-3 rounded-2xl bg-secondary/60 p-3">
                  <Checkbox className="mt-0.5" checked={chosen.has(tenant.tenantId)} onCheckedChange={(value) => toggle(tenant.tenantId, value === true)} aria-label={tenant.name} />
                  <span><span className="font-medium text-gray-900">{tenant.name}</span><span className="block text-xs text-gray-500">{tenant.domain || tenant.tenantId}</span></span>
                </label>
              ))}
            </fieldset>
          )}
          {tenants.length > 0 && (
            <label htmlFor={connectionId} className="flex items-start gap-3 rounded-2xl border border-gray-200 p-3 dark:border-gray-800">
              <Checkbox id={connectionId} className="mt-0.5" checked={connection} disabled={chosen.size === 0} onCheckedChange={(value) => setConnection(value === true)} />
              <span>
                <span className="font-medium text-gray-900">Include connection details</span>
                <span className="block text-xs text-gray-500">The client ID of each tenant&apos;s app registration and where its backups are stored, so another admin can connect the tenant from this file. Both are identifiers, not secrets: the other admin still signs in with their own account.</span>
              </span>
            </label>
          )}
          <p className="text-xs text-gray-500">{NEVER_EXPORTED}</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={busy || (!app && chosen.size === 0)} onClick={() => void save()}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}Save file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ItemRow({ item, checked, onChange }: { item: TransferItem; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId()
  const selectable = item.status === "change"
  return (
    <li className="flex items-start gap-3 py-3">
      <Checkbox id={id} className="mt-0.5" checked={selectable && checked} disabled={!selectable} onCheckedChange={(value) => onChange(value === true)} aria-describedby={`${id}-values`} />
      <div className="min-w-0 flex-1 space-y-1">
        <label htmlFor={id} className="flex flex-wrap items-center gap-2 font-medium text-gray-900">
          {item.label}
          {item.feature && <PlanBadge feature={item.feature} />}
          {item.status === "same" && <span className="text-xs font-normal text-gray-500">Already the same</span>}
        </label>
        <p id={`${id}-values`} className="flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
          <span>{item.current}</span>
          {item.status !== "same" && <><ArrowRight className="h-3 w-3" aria-label="to" /><span className="font-medium text-gray-900">{item.next}</span></>}
        </p>
        {item.reason && <p className="flex items-start gap-1.5 text-xs text-gray-600"><MinusCircle className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />{item.reason}</p>}
        {item.warning && item.status === "change" && <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />{item.warning}</p>}
        {item.note && <p className="flex items-start gap-1.5 text-xs text-gray-500"><Info className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />{item.note}</p>}
      </div>
    </li>
  )
}

function GroupSection({ group, importId, selected, showUnchanged, onToggle }: { group: TransferGroup; importId: string; selected: Set<string>; showUnchanged: boolean; onToggle: (id: string, on: boolean) => void }) {
  const navigate = useNavigate()
  const items = group.items.filter((item) => showUnchanged || item.status !== "same")
  const unchanged = group.items.length - items.length
  return (
    <section aria-label={group.title} className="rounded-2xl border border-gray-200 px-4 py-3 dark:border-gray-800">
      <h3 className="font-medium text-gray-900">{group.title}</h3>
      {group.detail && group.detail !== group.title && <p className="text-xs text-gray-500">{group.detail}</p>}
      {group.notice && <p className="mt-2 rounded-xl bg-secondary/70 px-3 py-2 text-xs text-gray-700">{group.notice}</p>}
      {group.setup && !group.connected && (
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void navigate(`/portal/onboarding?setup=${encodeURIComponent(importId)}&tenant=${encodeURIComponent(group.id)}`)}>
          Connect this tenant
        </Button>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {items.map((item) => <ItemRow key={item.id} item={item} checked={selected.has(item.id)} onChange={(on) => onToggle(item.id, on)} />)}
        </ul>
      )}
      {group.connected && items.length === 0 && <p className="py-2 text-xs text-gray-500">{unchanged > 0 ? "Everything here is already the same." : "Nothing to apply."}</p>}
    </section>
  )
}

/** The review of an opened settings file: choose items, apply, then the result. */
export function ImportDialog({ preview, paused = false, onClose, onApplied, onExportFirst }: { preview: TransferPreview; paused?: boolean; onClose: () => void; onApplied: (result: TransferApplyResult) => void; onExportFirst: () => void }) {
  const items = useMemo(() => preview.groups.flatMap((group) => group.items), [preview])
  const [selected, setSelected] = useState(() => new Set(items.filter((item) => item.selected).map((item) => item.id)))
  const [showUnchanged, setShowUnchanged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TransferApplyResult | null>(null)
  const [permissions, setPermissions] = useState<Array<{ tenant: string; lines: string[] }> | null>(null)
  const tenants = connectedTenants(useTenants())
  const tenantsRef = useRef(tenants)
  tenantsRef.current = tenants
  const queryClient = useQueryClient()
  const showId = useId()
  const unchanged = items.filter((item) => item.status === "same").length
  const chosen = items.filter((item) => item.status === "change" && selected.has(item.id))

  const apply = async () => {
    setBusy(true)
    try {
      const applied = await bridge.settingsTransfer.apply(preview.importId, chosen.map((item) => item.id), getAppearance())
      if (applied.appearance) setAppearance(applied.appearance)
      setResult(applied)
      onApplied(applied)
      void queryClient.invalidateQueries()
      const enabled = Object.entries(applied.servicesEnabled)
      if (enabled.length) {
        // The permission check reads the sign-in TenuVault already holds; it changes nothing. It covers
        // only the services this import turned on.
        const checks = await Promise.all(enabled.map(async ([tenantId, moduleIds]) => {
          const tenant = tenantsRef.current.find((entry) => entry.tenantId === tenantId)
          if (!tenant) return { tenant: tenantId, lines: [] }
          const status = await bridge.services.status(tenantId, tenant.clientId).catch((error: unknown): ServicesStatus => ({ tenantId, modules: [], checkedAt: null, error: message(error) }))
          return { tenant: tenant.name, lines: missingPermissions(status, moduleIds) }
        }))
        setPermissions(checks)
      }
    } catch (error) {
      toast(message(error), "error")
    } finally {
      setBusy(false)
    }
  }

  const exported = preview.exportedAt ? new Date(preview.exportedAt).toLocaleString() : "an unknown date"
  return (
    <Dialog open={!paused} onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{result ? "Settings applied" : "Review settings from the file"}</DialogTitle>
          <DialogDescription>
            {result ? "What was applied, and what was not." : `Exported on ${exported}${preview.appVersion ? ` by TenuVault ${preview.appVersion}` : ""}. Choose the settings to apply to this computer.`}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto text-sm">
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {result.items.map((entry) => (
                <li key={entry.id} className="flex items-start gap-2 py-2">
                  {entry.outcome === "applied" ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" aria-hidden="true" /> : entry.outcome === "skipped" ? <MinusCircle className="mt-0.5 h-4 w-4 text-gray-400" aria-hidden="true" /> : <XCircle className="mt-0.5 h-4 w-4 text-red-600" aria-hidden="true" />}
                  <span>
                    <span className="font-medium text-gray-900">{entry.label}</span>
                    <span className="text-gray-500"> ({entry.group === "app" ? "this computer" : preview.groups.find((group) => group.id === entry.group)?.title ?? entry.group}): {entry.outcome === "applied" ? "applied" : entry.outcome === "skipped" ? "skipped" : "not applied"}</span>
                    {entry.message && <span className="block text-xs text-gray-600">{entry.message}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {result.items.some((entry) => entry.outcome === "failed") && result.items.some((entry) => entry.outcome === "applied") && (
              <p className="text-xs text-gray-500">The settings that were applied stay applied.</p>
            )}
            {permissions && (
              <div className="space-y-2 rounded-2xl bg-secondary/60 p-3">
                <p className="font-medium text-gray-900">Permissions for the services you turned on</p>
                {permissions.map((check) => (
                  <div key={check.tenant} className="text-xs text-gray-700">
                    <p className="font-medium">{check.tenant}</p>
                    {check.lines.length ? check.lines.map((line) => <p key={line}>{line}</p>) : <p>Your sign-in has the permissions these services need.</p>}
                  </div>
                ))}
                {permissions.some((check) => check.lines.length) && <Link to={settingsHref("services")} className="text-xs text-blue-600 underline" onClick={onClose}>Open Services and permissions</Link>}
              </div>
            )}
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto text-sm">
            {preview.groups.map((group) => (
              <GroupSection key={group.id} group={group} importId={preview.importId} selected={selected} showUnchanged={showUnchanged}
                onToggle={(id, on) => setSelected((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next })} />
            ))}
            {preview.groups.length === 0 && <p className="text-gray-600">The file holds no settings.</p>}
            {preview.skipped.length > 0 && (
              <div className="rounded-2xl bg-secondary/60 p-3 text-xs text-gray-700">
                <p className="font-medium">Not known to this version, so skipped</p>
                <ul className="mt-1 list-disc pl-5">{preview.skipped.map((entry) => <li key={entry}>{entry}</li>)}</ul>
              </div>
            )}
            {unchanged > 0 && (
              <label htmlFor={showId} className="flex items-center gap-2 text-xs text-gray-600">
                <Checkbox id={showId} checked={showUnchanged} onCheckedChange={(value) => setShowUnchanged(value === true)} />
                Show settings that are already the same ({unchanged})
              </label>
            )}
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2">
          {result ? (
            <Button type="button" onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="ghost" className="mr-auto" disabled={busy} onClick={onExportFirst}>Save current settings first</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
              <Button type="button" disabled={busy || chosen.length === 0} onClick={() => void apply()}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {chosen.length === 1 ? "Apply 1 setting" : `Apply ${chosen.length} settings`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
