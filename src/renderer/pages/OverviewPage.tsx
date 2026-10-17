import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AlertCircle, ArrowUpRight, BadgeCheck, CalendarClock, CheckCircle2, Database, KeyRound, Play, Plus } from "lucide-react"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { useSelectedTenant, useTenants, type Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip, Fact, RoundIconButton, Tile, TileLabel } from "~/components/dashboard/tiles"
import { storageLabel } from "~/lib/storage-label"
import type { SignedInAccount } from "../../shared/ipc"
import { stoppedEarly } from "../../shared/intune/backup-status"
import { backupTarget, trackBackup } from "../lib/backups"
import { RunBackupDialog } from "../components/RunBackupDialog"
import { UnreadableBackupsNotice } from "../components/UnreadableBackupsNotice"
import { RecoveryKeyNotice } from "../components/RecoveryKeyNotice"
import { bridge } from "../lib/bridge"
import { formatDate, planName, tenantLicense, useLicense } from "../lib/license"
import { localTenantIds, useBackupSettings, useLocalInventoryProblems } from "../lib/local-inventory"
import { describeSchedule, formatWhen, useSchedules } from "../lib/schedules"
import { toast } from "../lib/toast"

/** All connected tenants at a glance: sign-in, license, storage, schedule and last backup. */
export default function OverviewPage() {
  const tenants = useTenants()
  const schedules = useSchedules()
  const { status } = useLicense()
  const { setSelectedTenantId } = useSelectedTenant()
  const { addJob } = useBackupProgress()
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState<SignedInAccount[]>([])
  const [backingUp, setBackingUp] = useState<Tenant | null>(null)
  const [backupSettings, setBackupSettings] = useBackupSettings((error) => toast(String(error), "error"))

  useEffect(() => void bridge.auth.accounts().then(setAccounts), [])
  // A shared folder can hold tenants another device backs up with its own key; only this device's tenants matter.
  const inventory = useLocalInventoryProblems(backupSettings, localTenantIds(tenants))

  const open = (tenant: Tenant, path = "/portal/dashboard") => {
    setSelectedTenantId(tenant.id)
    void navigate(path)
  }

  const backUp = (tenant: Tenant) => {
    try {
      backupTarget(tenant)
      setBackingUp(tenant)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  const tenantIds = tenants.map((t) => t.credentials?.tenantId?.toLowerCase() ?? "")
  const signedInCount = tenantIds.filter((id) => accounts.some((a) => a.tenantId === id)).length
  const licensedCount = tenantIds.filter((id) => tenantLicense(status, id)?.entitled).length
  const scheduledCount = tenantIds.filter((id) => schedules.some((s) => s.tenantId === id && s.enabled)).length

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 p-6 lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-4xl font-light tracking-tight text-gray-900">All tenants</h1>
          <p className="mt-2 text-sm text-gray-600">
            {tenants.length} tenant{tenants.length === 1 ? "" : "s"} connected on this device.
          </p>
        </div>
        <Button className="bg-blue-600 text-white hover:bg-blue-700" onClick={() => void navigate("/portal/onboarding")}>
          <Plus className="h-4 w-4" /> Connect a tenant
        </Button>
      </div>

      <UnreadableBackupsNotice settings={backupSettings} affected={inventory.affected.length > 0} checking={inventory.checking} onChange={setBackupSettings} />
      <RecoveryKeyNotice settings={backupSettings} />

      {/* Summary row: counts from the tenant list, sign-ins, license state and schedules */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile focal className="justify-between">
          <p className="text-sm text-white/70">Tenants connected</p>
          <div>
            <p className="mt-3 text-4xl font-light tabular-nums">{tenants.length}</p>
            {status?.plan && status.tenantLimit !== null && (
              <p className="mt-1 text-sm text-white/70">{`${planName(status.plan)} covers ${status.tenantLimit} tenant${status.tenantLimit === 1 ? "" : "s"}`}</p>
            )}
          </div>
        </Tile>
        {[
          ["Signed in", signedInCount],
          ["Licensed", licensedCount],
          ["Automatic backups on", scheduledCount],
        ].map(([label, count]) => (
          <Tile key={label} className="justify-between">
            <TileLabel>{label}</TileLabel>
            <p className="mt-3 text-4xl font-light text-gray-900 tabular-nums">
              {count}
              <span className="text-lg text-gray-400"> of {tenants.length} connected</span>
            </p>
          </Tile>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {tenants.map((tenant) => {
          const tenantId = tenant.credentials?.tenantId?.toLowerCase() ?? ""
          const account = accounts.find((a) => a.tenantId === tenantId)
          const schedule = schedules.find((s) => s.tenantId === tenantId)
          // A cancelled automatic backup is shown like a failed one, named as cancelled.
          const failed = stoppedEarly(schedule?.lastStatus)
          const license = tenantLicense(status, tenantId)
          return (
            <Tile key={tenant.id}>
              <div className="flex items-start justify-between gap-3">
                <button type="button" className="group min-w-0 text-left" onClick={() => open(tenant)}>
                  <h2 className="truncate text-2xl font-light tracking-tight text-gray-900 group-hover:text-blue-700">{tenant.name}</h2>
                  <p className="truncate text-sm text-gray-500">{tenant.domain || tenantId}</p>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {account ? <Chip tone="success">Signed in</Chip> : <Chip tone="warning">Not signed in</Chip>}
                  <RoundIconButton icon={ArrowUpRight} label={`Open the dashboard of ${tenant.name}`} onClick={() => open(tenant)} />
                </div>
              </div>
              <dl className="mt-6 grid flex-1 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <Fact label="Account">
                  <span className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 shrink-0 text-gray-400" />
                    {account ? <span className="truncate">{account.username}</span> : <span className="text-gray-500">No administrator signed in</span>}
                  </span>
                </Fact>
                <Fact label="License">
                  <span className="flex items-center gap-2">
                    {license?.entitled ? (
                      <>
                        <BadgeCheck className="h-4 w-4 shrink-0 text-green-600" />
                        <span className="truncate">
                          {license.source === "tenant" ? `Licensed through your organization (${planName(license.plan)})` : `Licensed, ${planName(license.plan)}`}
                        </span>
                      </>
                    ) : license?.plan === "community" ? (
                      <Link to="/license" className="truncate text-gray-700 hover:underline">
                        Community (free)
                      </Link>
                    ) : license ? (
                      <>
                        <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                        <Link to="/license" className="text-amber-700 hover:underline" title={license.message ?? undefined}>
                          Not licensed
                        </Link>
                      </>
                    ) : (
                      // Only tenants connected by an older version, or whose sign-in is gone:
                      // new tenants are checked when they are added, signed-in ones at start.
                      <>
                        <BadgeCheck className="h-4 w-4 shrink-0 text-gray-400" />
                        <span className="truncate text-gray-500" title="Checked the next time you sign in to this tenant">
                          License checked at first use
                        </span>
                      </>
                    )}
                  </span>
                  {license?.validUntil && (
                    <p className="mt-1 text-xs text-gray-500">Valid until {formatDate(license.validUntil)}</p>
                  )}
                </Fact>
                <Fact label="Storage">
                  <span className="flex items-center gap-2">
                    <Database className="h-4 w-4 shrink-0 text-gray-400" />
                    <span className="truncate">{storageLabel(tenant.resources?.storageAccountName)}</span>
                  </span>
                </Fact>
                <Fact label="Automatic backups" wrap>
                  <span className="flex items-start gap-2">
                    <CalendarClock className="h-4 w-4 shrink-0 text-gray-400" />
                    <span className="min-w-0">
                      {schedule?.enabled ? (
                        <>
                          <span className="block break-words">{describeSchedule(schedule)}</span>
                          <span className="mt-1 block break-words text-gray-500">Next {formatWhen(schedule.nextRunAt)}</span>
                        </>
                      ) : "No automatic backups"}
                    </span>
                  </span>
                </Fact>
                <div className="sm:col-span-2">
                  <Fact label="Last backup" wrap>
                    {failed ? (
                      <div className="space-y-2">
                        <button type="button" className="flex w-full items-start gap-2 text-left text-red-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={() => open(tenant, "/portal/backup?tab=schedule")}>
                          <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
                          <span className="min-w-0 break-words">
                            {schedule?.lastStatus === "Cancelled" ? "Last automatic backup cancelled" : "Last automatic backup attempt failed"}{schedule?.lastAttemptAt ? ` ${formatWhen(schedule.lastAttemptAt)}` : ""}
                          </span>
                        </button>
                        <Chip tone="danger">Action required</Chip>
                      </div>
                    ) : (
                      <span className="flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-gray-400" />
                        <span className="min-w-0 break-words">
                          {schedule?.lastAttemptAt
                            ? `Last automatic backup ${formatWhen(schedule.lastAttemptAt)}`
                            : tenant.lastBackup
                              ? `Last backup ${formatWhen(tenant.lastBackup)}`
                              : "No backups yet"}
                        </span>
                      </span>
                    )}
                  </Fact>
                </div>
              </dl>
              <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-5">
                {!account && (
                  <Button size="sm" className="bg-blue-600 text-white hover:bg-blue-700" onClick={() => open(tenant, "/portal/settings?section=signin")}>
                    Sign in
                  </Button>
                )}
                {account && !license?.entitled && (
                  <Button size="sm" className="bg-blue-600 text-white hover:bg-blue-700" onClick={() => open(tenant, "/license")}>
                    Check license
                  </Button>
                )}
                <Button size="sm" onClick={() => backUp(tenant)} disabled={!account || !license?.entitled}>
                  <Play className="h-4 w-4" />
                  Back up now
                </Button>
                <div className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => open(tenant, "/portal/backup")}>
                    Backups
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => open(tenant, "/portal/drift")}>
                    Drift
                  </Button>
                </div>
              </div>
            </Tile>
          )
        })}
      </div>
      <RunBackupDialog
        open={backingUp !== null}
        onOpenChange={(next) => !next && setBackingUp(null)}
        tenant={backingUp ? backupTarget(backingUp) : null}
        onStarted={(jobId) => {
          if (!backingUp) return
          trackBackup(backingUp, jobId, addJob)
          toast(`Backup of ${backingUp.name} started.`, "success")
        }}
      />
    </div>
  )
}
