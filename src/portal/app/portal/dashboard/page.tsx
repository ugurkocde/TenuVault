"use client"

import { useState, useEffect, Suspense } from "react"
import { useRouter } from "next/navigation"
import { Link } from "react-router-dom"
import {
  Activity,
  CheckCircle,
  AlertCircle,
  CalendarClock,
  Database,
  GitCompareArrows,
  RefreshCw,
  Play,
  Settings,
  Building2,
  ArrowUpRight,
  BadgeCheck,
  Layers,
  Loader2,
  HardDrive,
  Gauge,
} from "lucide-react"
import { cn } from "~/lib/utils"
import { Button } from "~/components/ui/button"
import { useDashboardStats } from "~/hooks/dashboard/useDashboardStats"
import { backupSummary } from "~/lib/backup-health"
import { stoppedEarly } from "../../../../shared/intune/backup-status"
import { unresolvedNotice } from "~/components/backup/types"
import { useBaselineScore } from "~/hooks/dashboard/useBaselineScore"
import { formatDate, formatPercent } from "@desktop/features/scores/api"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { storageLabel } from "~/lib/storage-label"
import DashboardEmptyState from "~/components/dashboard/empty-state/dashboard-empty-state"
import { BarList, BigValue, Chip, Fact, RoundIconButton, Ring, Tile, TileIcon, TileLabel } from "~/components/dashboard/tiles"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { bridge } from "@desktop/lib/bridge"
import { planName, tenantLicense, tenantPlan, useLicense, formatDateTime } from "@desktop/lib/license"
import { PlanBadge } from "@desktop/components/UpgradeNote"
import type { Tenant } from "~/contexts/TenantContext"
import type { Plan } from "../../../../shared/plans"
import { describeSchedule, formatWhen, useSchedules } from "@desktop/lib/schedules"
import type { SignedInAccount } from "../../../../shared/ipc"

// Simple time ago formatter to avoid date-fns issues
function formatDistanceToNow(
  date: Date,
  options?: { addSuffix?: boolean },
  nowOverride?: Date
): string {
  if (!date || Number.isNaN(date.getTime())) return ""
  const now = nowOverride ?? new Date()
  const diffMs = now.getTime() - date.getTime()
  const isPast = diffMs >= 0
  const diff = Math.abs(diffMs)
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  let distance = ""
  if (days > 0) {
    distance = `${days} day${days > 1 ? 's' : ''}`
  } else if (hours > 0) {
    distance = `${hours} hour${hours > 1 ? 's' : ''}`
  } else if (minutes > 0) {
    distance = `${minutes} minute${minutes > 1 ? 's' : ''}`
  } else {
    distance = `${seconds} second${seconds > 1 ? 's' : ''}`
  }

  if (!options?.addSuffix) return distance
  return isPast ? `${distance} ago` : `in ${distance}`
}

const quickActions = [
  { icon: Play, label: "Run Backup", href: "/portal/backup" },
  { icon: RefreshCw, label: "Restore policies", href: "/portal/backup?tab=restore" },
  { icon: Building2, label: "Connect tenant", href: "/portal/tenants?connect=1" },
  { icon: Settings, label: "Settings", href: "/portal/settings" },
]

const periodLabels: Record<string, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
}

const policyTypeLabels = [
  ["configurationPolicies", "Settings catalog"],
  ["deviceConfigurations", "Device configurations"],
  ["compliancePolicies", "Compliance policies"],
  ["appProtectionPolicies", "App protection"],
  ["conditionalAccess", "Conditional Access"],
] as const

const healthChip = {
  healthy: { tone: "success", label: "Healthy" },
  warning: { tone: "warning", label: "Warning" },
  critical: { tone: "danger", label: "Critical" },
} as const

function TileSkeleton({ className }: { className?: string }) {
  return (
    <Tile className={className}>
      <div className="animate-pulse space-y-4">
        <div className="h-4 w-24 rounded-full bg-gray-200" />
        <div className="h-8 w-32 rounded-full bg-gray-200" />
        <div className="h-3 w-40 rounded-full bg-gray-200" />
      </div>
    </Tile>
  )
}

/**
 * Newest baseline score of the tenant, linking to the gated scores screen. Community sees a
 * badged teaser and no score: the score is a paid projection and is not computed for it.
 */
export function BaselineScoreTile({ tenant, plan }: { tenant: Tenant; plan: Plan | null }) {
  const router = useRouter()
  const score = useBaselineScore(tenant, plan)
  const latest = score.latest?.latest ?? null
  const open = () => router.push("/portal/governance/scores")
  if (score.isLoading) return <TileSkeleton className="md:col-span-2 xl:col-span-1" />
  return (
    <Tile className="md:col-span-2 xl:col-span-1" aria-label="Baseline score">
      <div className="flex items-start justify-between gap-3">
        <TileIcon icon={Gauge} />
        {!score.enabled ? (plan ? <PlanBadge feature="baselineScores" /> : <Chip>Not checked</Chip>)
          : latest?.freshness.stale ? <Chip tone="warning">Stale</Chip>
          : latest && latest.incompleteCollection.length > 0 ? <Chip tone="warning">Partial</Chip>
          : null}
      </div>
      <TileLabel className="mt-6">{latest ? `Baseline score: ${latest.identity.frameworkName}` : "Baseline score"}</TileLabel>
      {!score.enabled ? (
        <p className="mt-1 text-sm text-gray-500">Scores and coverage from your saved framework comparisons and OIB validations, with trends. Framework comparisons stay available on every plan.</p>
      ) : score.error ? (
        <>
          <BigValue className="mt-1">Unavailable</BigValue>
          <p className="mt-1 line-clamp-2 text-sm text-gray-500">{score.error instanceof Error ? score.error.message : "Scores could not be read."}</p>
        </>
      ) : !latest && score.unavailable > 0 ? (
        <>
          <BigValue className="mt-1">Unavailable</BigValue>
          <p className="mt-1 text-sm text-gray-500">Saved comparisons could not be read, so there is no score.</p>
        </>
      ) : !latest && score.historyOnly ? (
        <>
          <BigValue className="mt-1">No current score</BigValue>
          <p className="mt-1 line-clamp-3 text-sm text-gray-500">{score.historyOnly.frameworkName}: {score.historyOnly.message}</p>
        </>
      ) : !latest ? (
        <>
          <BigValue className="mt-1">No score</BigValue>
          <p className="mt-1 text-sm text-gray-500">No saved framework comparison or OIB validation yet.</p>
        </>
      ) : (
        <>
          <BigValue className="mt-1">{formatPercent(latest.score.score)}</BigValue>
          <p className="mt-1 line-clamp-2 text-sm text-gray-500">
            {latest.score.score === null ? latest.score.reason : `On ${formatPercent(latest.score.coverage, "unknown")} coverage, ${latest.score.counts.unknown} unknown.`} {score.assessed > 1 ? `The most recently assessed of ${score.assessed} scored frameworks, ${formatDate(latest.freshness.assessedAt)}.` : `Assessed ${formatDate(latest.freshness.assessedAt)}.`}
          </p>
          {latest.identity.selectionSha256 && <p className="mt-1 text-xs text-gray-500">Selected deployed OIB policies only.</p>}
        </>
      )}
      <div className="mt-auto pt-5">
        <Button variant="outline" size="sm" onClick={open}>{score.enabled ? "Open scores" : "See baseline scores"}</Button>
      </div>
    </Tile>
  )
}

function DashboardContent() {
  const router = useRouter()
  const [selectedPeriod, setSelectedPeriod] = useState("7d")
  const [relativeNow, setRelativeNow] = useState(() => Date.now())
  const [accounts, setAccounts] = useState<SignedInAccount[] | null>(null)
  useEffect(() => {
    const interval = window.setInterval(() => setRelativeNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])
  useEffect(() => void bridge.auth.accounts().then(setAccounts), [])

  const tenants = useTenants()
  const { selectedTenant } = useSelectedTenant()
  // The dashboard follows the tenant switcher; before a choice is stored it shows the first tenant.
  const tenant = selectedTenant ?? tenants[0]
  const tenantGuid = tenant?.credentials?.tenantId?.toLowerCase() ?? ""
  const schedules = useSchedules()
  const { status: licenseStatus } = useLicense()
  const { activeJobs } = useBackupProgress()
  const {
    data: stats,
    isLoading: statsLoading,
    isFetching,
    refetch: refetchStats,
    error: statsError,
    dataUpdatedAt,
  } = useDashboardStats(selectedPeriod, tenant?.id)

  // Finished jobs stay in the progress list until dismissed; only unfinished ones are running.
  const tenantJobs = activeJobs.filter((job) => job.tenantId?.toLowerCase() === tenantGuid && !job.isComplete)
  // Every backup count on the tiles comes from this one summary, so the tiles cannot disagree.
  const backupStats = stats
    ? backupSummary(stats.backupHistory, stats.failedAttempts, { since: stats.periodStart, live: [...stats.liveRuns, ...tenantJobs.map((job) => job.jobId)] })
    : null
  const nowDate = new Date(relativeNow)
  // Null when no backup finished in the period, or the backups could not be read, which the tile shows as "No data".
  const successRateValue = stats?.backupsError ? null : backupStats?.successRate ?? null
  const recentActivities = stats?.recentActivity ?? []
  const computedLastUpdated = dataUpdatedAt
    ? formatDistanceToNow(new Date(dataUpdatedAt), { addSuffix: true }, nowDate)
    : ""
  const lastUpdatedLabel = computedLastUpdated || null
  const statsErrorMessage = statsError
    ? (statsError instanceof Error ? statsError.message : "Unable to load dashboard data.")
    : null

  const account = accounts?.find((a) => a.tenantId === tenantGuid)
  const license = tenantLicense(licenseStatus, tenantGuid)
  const plan = tenantPlan(license)
  const schedule = schedules.find((s) => s.tenantId === tenantGuid)
  const latest = stats?.latestBackup ?? null
  const protectedBackup = stats?.latestCompleteBackup ?? null
  const backupsError = stats?.backupsError ?? null
  // A cancelled automatic backup is shown like a failed one, named as cancelled.
  const scheduleStopped = stoppedEarly(schedule?.lastStatus)
  const scheduleCancelled = schedule?.lastStatus === "Cancelled"
  const failedBeforeFirstBackup = scheduleStopped && !!backupStats && !backupsError && backupStats.stored === 0
  const unresolvedBackups = stats?.unresolvedBackups ?? 0
  const health =
    stats && stats.tenants.total > 0
      ? stats.tenants.critical > 0 ? "critical" : stats.tenants.warning > 0 ? "warning" : "healthy"
      : null
  const isLocal = tenant?.resources?.storageAccountName?.startsWith("tvlocal-") ?? false

  // Format time until next backup
  const getTimeUntilNextBackup = () => {
    if (!schedule?.enabled || !schedule.nextRunAt) return null
    const diff = new Date(schedule.nextRunAt).getTime() - relativeNow
    if (!Number.isFinite(diff)) return null
    if (diff < 0) return "Running soon"
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
    if (hours > 24) {
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h`
    }
    return `${hours}h ${minutes}m`
  }
  const nextIn = getTimeUntilNextBackup()

  // Show empty state when no tenants are connected
  if (tenants.length === 0 || !tenant) {
    return <DashboardEmptyState />
  }

  const signInAction = () => router.push("/portal/settings?section=signin")
  const policyItems = protectedBackup?.policies
    ? policyTypeLabels.map(([key, label]) => ({ label, value: protectedBackup.policies?.[key] ?? 0 }))
    : null

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 p-6 lg:p-8">
      {/* Header: title and tenant on the left, date and controls on the right */}
      <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-4xl font-light tracking-tight text-gray-900">Dashboard</h1>
          <p className="mt-1 truncate text-2xl font-light tracking-tight text-gray-400">
            {tenant.name}
          </p>
          <p className="mt-2 text-sm text-gray-500">Backup overview for {tenant.domain || tenant.name}.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 pr-1">
            <span className="inline-flex size-14 items-center justify-center rounded-full border border-gray-200 text-2xl font-light text-gray-900 tabular-nums">
              {nowDate.getDate()}
            </span>
            <span className="text-sm leading-tight text-gray-700">
              {nowDate.toLocaleDateString(undefined, { weekday: "short" })},
              <br />
              {nowDate.toLocaleDateString(undefined, { month: "long" })}
            </span>
          </div>
          <span aria-hidden className="mx-1 hidden h-10 w-px bg-gray-200 sm:block" />
          <select
            aria-label="Reporting period" value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="h-10 rounded-full border border-gray-200 bg-white px-4 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:opacity-60"
            disabled={statsLoading || isFetching}
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh dashboard" onClick={() => refetchStats()}
            disabled={statsLoading || isFetching}
          >
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
          {lastUpdatedLabel && (
            <span className="w-full text-xs text-gray-500 lg:w-auto">Last updated {lastUpdatedLabel}</span>
          )}
        </div>
      </header>

      {statsErrorMessage && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{statsErrorMessage}</AlertDescription>
        </Alert>
      )}
      {unresolvedBackups > 0 && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{unresolvedNotice(unresolvedBackups)}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* Last backup */}
        {statsLoading ? <TileSkeleton className="md:col-span-2" /> : (
          <Tile className="md:col-span-2" aria-label="Last backup">
            <div className="flex items-start justify-between gap-3">
              <TileIcon icon={Database} />
              <div className="flex flex-wrap items-center justify-end gap-2">
                {backupStats?.latestStatus ? (
                  backupStats.latestStatus === "success" ? <Chip tone="success">Completed</Chip>
                    : backupStats.latestStatus === "partial" ? <Chip tone="warning">Completed with warnings</Chip>
                    : backupStats.latestStatus === "running" ? <Chip tone="coral">Running</Chip>
                    : backupStats.latestStatus === "unknown" ? <Chip tone="warning">Status unknown</Chip>
                    : backupStats.latestStatus === "cancelled" ? <Chip>Cancelled</Chip>
                    : <Chip tone="danger">{backupStats.latestStatus === "incomplete" ? "Incomplete" : "Failed"}</Chip>
                ) : null}
                {health && (
                  <Chip tone={healthChip[health].tone} title="Tenant Health, based on the newest complete successful backup">
                    Tenant Health: {healthChip[health].label}
                  </Chip>
                )}
              </div>
            </div>
            <TileLabel className="mt-6">Last backup</TileLabel>
            {latest ? (
              <>
                <BigValue className="mt-1 text-4xl">{formatDistanceToNow(latest.timestamp, { addSuffix: true }, nowDate)}</BigValue>
                <p className="mt-1 text-sm text-gray-500">
                  {latest.timestamp.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                  {latest.policiesBackedUp > 0 && `, ${latest.policiesBackedUp} policies`}
                </p>
              </>
            ) : backupsError ? (
              <>
                <BigValue className="mt-1 text-4xl">Unavailable</BigValue>
                <p className="mt-1 line-clamp-2 text-sm text-gray-500" title={backupsError}>{backupsError}</p>
              </>
            ) : (
              <>
                <BigValue className="mt-1 text-4xl">No backups yet</BigValue>
                <p className="mt-1 text-sm text-gray-500">Run the first backup to protect this tenant&apos;s policies.</p>
              </>
            )}
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-6">
              {!account && accounts !== null ? (
                <Button className="bg-blue-600 text-white hover:bg-blue-700" onClick={signInAction}>Sign in</Button>
              ) : (
                <Button className="bg-blue-600 text-white hover:bg-blue-700" onClick={() => router.push("/portal/backup")}>
                  <Play className="h-4 w-4" /> Run Backup
                </Button>
              )}
              <Button onClick={() => router.push("/portal/backup?tab=restore")}>Restore policies</Button>
              {backupStats && backupStats.stored > 0 && (
                <span className="ml-auto text-sm text-gray-500 tabular-nums">
                  {backupStats.stored} backup{backupStats.stored === 1 ? "" : "s"} in storage
                </span>
              )}
            </div>
          </Tile>
        )}

        {/* Success rate: the dark focal tile */}
        {statsLoading ? <TileSkeleton /> : (
          <Tile focal aria-label="Success Rate" className="items-center text-center">
            <p className="self-start text-sm text-white/70">Success Rate</p>
            <div className="my-3 text-white">
              <Ring value={successRateValue} marker={95}>
                <span className="text-3xl font-light tabular-nums">
                  {successRateValue !== null ? `${successRateValue.toFixed(successRateValue === 100 ? 0 : 1)}%` : "No data"}
                </span>
                <span className="mt-0.5 text-xs text-white/70">{periodLabels[selectedPeriod]}</span>
              </Ring>
            </div>
            <p className="mt-auto text-xs text-white/70">
              {successRateValue !== null
                ? <>Target 95%, {backupStats?.successful ?? 0} of {backupStats?.finished ?? 0} backups succeeded</>
                : backupsError ? "Backups could not be read" : "No finished backups in this period"}
            </p>
          </Tile>
        )}

        {/* Automatic backups / next backup */}
        <Tile aria-label="Next Backup">
          <div className="flex items-start justify-between gap-3">
            <TileIcon icon={CalendarClock} />
            {schedule?.enabled ? <Chip tone="success">On</Chip> : <Chip>Off</Chip>}
          </div>
          <TileLabel className="mt-6">Next Backup</TileLabel>
          {schedule?.enabled ? (
            <>
              <BigValue className="mt-1">{nextIn ?? "Not scheduled"}</BigValue>
              <p className="mt-1 text-sm text-gray-500">{describeSchedule(schedule)}</p>
              <p className="text-sm text-gray-500">{formatWhen(schedule.nextRunAt)}</p>
            </>
          ) : (
            <>
              <BigValue className="mt-1">No schedules</BigValue>
              <p className="mt-1 text-sm text-gray-500">Configure backup schedules</p>
            </>
          )}
          {schedule?.lastAttemptAt && (
            <p className={cn("mt-2 text-xs", scheduleStopped ? "text-red-700" : "text-gray-500")}>
              {scheduleCancelled ? "Last automatic backup cancelled" : scheduleStopped ? "Last automatic backup attempt failed" : "Last automatic backup"} {formatWhen(schedule.lastAttemptAt)}
            </p>
          )}
          {failedBeforeFirstBackup && (
            <p className="mt-2 text-xs text-red-700">{scheduleCancelled ? "Automatic backup was cancelled before a backup was saved." : "Automatic backup failed before a backup was saved."}</p>
          )}
          <div className="mt-auto pt-5">
            <Button variant="outline" size="sm" onClick={() => router.push("/portal/backup?tab=schedule")}>
              {schedule?.enabled ? "Edit schedule" : "Set up automatic backups"}
            </Button>
          </div>
        </Tile>

        {/* Policies protected, by type */}
        {statsLoading ? <TileSkeleton className="md:col-span-2 xl:row-span-2" /> : (
          <Tile className="md:col-span-2 xl:row-span-2" aria-label="Policies protected">
            <div className="flex items-start justify-between gap-3">
              <TileIcon icon={Layers} />
              <RoundIconButton icon={ArrowUpRight} label="Open backups" onClick={() => router.push("/portal/backup")} />
            </div>
            <TileLabel className="mt-6">Policies protected</TileLabel>
            {protectedBackup ? (
              <>
                <BigValue className="mt-1 text-5xl">{protectedBackup.policiesBackedUp}</BigValue>
                <p className="mt-1 text-sm text-gray-500">
                  In the latest complete backup, {protectedBackup.timestamp.toLocaleDateString(undefined, { dateStyle: "medium" })}
                </p>
                {policyItems && (
                  <div className="mt-8">
                    <BarList items={policyItems} />
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-1 flex-col">
                <BigValue className="mt-1">{backupsError ? "Unavailable" : "No complete backup"}</BigValue>
                <p className="mt-1 max-w-sm text-sm text-gray-500">
                  {backupsError
                    ? "Policy counts appear once the backups of this tenant can be read."
                    : "After the first complete successful backup, its policies are counted here by type."}
                </p>
                <div className="mt-8 space-y-3.5" aria-hidden>
                  {policyTypeLabels.map(([key, label]) => (
                    <div key={key}>
                      <p className="mb-1.5 text-sm text-gray-400">{label}</p>
                      <div className="tv-bar-track h-2.5 rounded-full bg-gray-100" />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Tile>
        )}

        {/* Backup status in the period */}
        {statsLoading ? <TileSkeleton /> : (
          <Tile aria-label="Successful backups">
            <TileLabel>Successful backups</TileLabel>
            <BigValue className="mt-1 text-4xl">{backupStats?.successful || 0}</BigValue>
            <p className="text-sm text-gray-500">{periodLabels[selectedPeriod]}</p>
            <p className="mt-1 text-xs text-gray-500">Failed includes attempts that saved no backup.</p>
            <div className="mt-auto grid grid-cols-3 gap-2 pt-5 text-center">
              {[
                ["Failed", backupStats?.failed || 0],
                ["Running", backupStats?.inProgress || 0],
                ["Scheduled", stats?.backups.scheduled || 0],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0 rounded-2xl bg-gray-100 px-1 py-2.5">
                  <p className="text-lg font-light text-gray-900 tabular-nums">{value}</p>
                  <p className="truncate text-xs text-gray-500">{label}</p>
                </div>
              ))}
            </div>
          </Tile>
        )}

        {/* Drift */}
        {statsLoading ? <TileSkeleton /> : (
          <Tile aria-label="Drift">
            <div className="flex items-start justify-between gap-3">
              <TileIcon icon={GitCompareArrows} />
              {stats?.lastDriftCheck && (
                stats.lastDriftCheck.succeeded ? <Chip tone="success">Checked</Chip> : <Chip tone="danger">Check failed</Chip>
              )}
            </div>
            <TileLabel className="mt-6">Drift</TileLabel>
            {stats?.lastDriftCheck ? (
              <>
                <BigValue className="mt-1">{formatDistanceToNow(stats.lastDriftCheck.time, { addSuffix: true }, nowDate)}</BigValue>
                <p className="mt-1 text-sm text-gray-500">Last comparison of backups</p>
              </>
            ) : (
              <>
                <BigValue className="mt-1">Not checked</BigValue>
                <p className="mt-1 text-sm text-gray-500">
                  {!backupsError && (backupStats?.stored ?? 0) < 2
                    ? "Drift compares two backups. Run another backup first."
                    : "No drift check in recent activity."}
                </p>
              </>
            )}
            <div className="mt-auto pt-5">
              <Button variant="outline" size="sm" onClick={() => router.push("/portal/drift")}>Check drift</Button>
            </div>
          </Tile>
        )}

        {/* License */}
        <Link to="/license" className="flex min-w-0 rounded-3xl transition-shadow hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          <Tile className="flex-1">
            <div className="flex items-start justify-between gap-3">
              <TileIcon icon={BadgeCheck} />
              {license?.entitled ? <Chip tone="success">Licensed</Chip>
                : license?.plan === "community" ? <Chip>Free plan</Chip>
                : license ? <Chip tone="warning">Not licensed</Chip>
                : <Chip>Not checked</Chip>}
            </div>
            <TileLabel className="mt-6">License</TileLabel>
            {license?.entitled ? (
              <>
                <BigValue className="mt-1">{planName(license.plan)}</BigValue>
                <p className="mt-1 text-sm text-gray-500">
                  {license.source === "tenant" ? "Licensed through your organization" : "Licensed with this device's key"}
                </p>
                {license.expiresAt && <p className="text-xs text-gray-500">Token valid until {formatDateTime(license.expiresAt)}</p>}
              </>
            ) : license?.plan === "community" ? (
              <>
                <BigValue className="mt-1">Community</BigValue>
                <p className="mt-1 text-sm text-gray-500">Free for one tenant. Pro adds daily backups, full restore and more.</p>
              </>
            ) : license ? (
              <>
                <BigValue className="mt-1">Not licensed</BigValue>
                <p className="mt-1 line-clamp-2 text-sm text-gray-500" title={license.message ?? undefined}>
                  Backups of this tenant need a license.
                </p>
              </>
            ) : (
              <>
                <BigValue className="mt-1">Unchecked</BigValue>
                <p className="mt-1 text-sm text-gray-500">License checked at first use</p>
              </>
            )}
            <div className="mt-auto pt-5">
              <span className="inline-flex h-9 items-center justify-center rounded-full border border-input bg-background px-3 text-sm font-medium">
                {license?.entitled ? "Manage license" : "Check license"}
              </span>
            </div>
          </Tile>
        </Link>

        {/* Storage and sign-in */}
        <Tile aria-label="Storage">
          <div className="flex items-start justify-between gap-3">
            <TileIcon icon={HardDrive} />
            {isLocal && <Chip tone="coral">Encrypted</Chip>}
          </div>
          <TileLabel className="mt-6">Storage</TileLabel>
          <BigValue className="mt-1 truncate text-2xl" >{isLocal ? "This device" : storageLabel(tenant.resources?.storageAccountName)}</BigValue>
          <dl className="mt-auto grid gap-3 pt-5">
            <Fact label="Signed in as">
              {account ? account.username : accounts === null ? "Checking" : <span className="text-amber-800">Not signed in</span>}
            </Fact>
          </dl>
        </Tile>

        {/* Recent activity */}
        {/* Baseline score */}
        <BaselineScoreTile tenant={tenant} plan={plan} />

        <Tile className="md:col-span-2 xl:col-span-2" aria-label="Recent Activity">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-light tracking-tight text-gray-900">Recent Activity</h2>
            <Button
              variant="default"
              size="sm"
              onClick={() => router.push("/portal/audit")}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              <ArrowUpRight className="h-4 w-4" />
              View All Activity
            </Button>
          </div>
          <div className="mt-4 flex flex-1 flex-col">
            {statsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            ) : recentActivities.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-2xl bg-gray-100 px-4 py-8 text-center text-sm text-gray-500">
                No recent activity
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {recentActivities.slice(0, 5).map((activity) => (
                  <li key={activity.id} className="flex items-start gap-3 py-3">
                    <span className={cn(
                      "mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full",
                      activity.status === "success" && "bg-green-100",
                      activity.status === "warning" && "bg-yellow-100",
                      activity.status === "failed" && "bg-red-100",
                      activity.status === "info" && "bg-blue-100"
                    )}>
                      {activity.status === "success" && <CheckCircle className="h-4 w-4 text-green-700" />}
                      {activity.status === "warning" && <AlertCircle className="h-4 w-4 text-yellow-600" />}
                      {activity.status === "failed" && <AlertCircle className="h-4 w-4 text-red-600" />}
                      {activity.status === "info" && <Activity className="h-4 w-4 text-blue-600" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-sm font-medium text-gray-900">{activity.tenant}</p>
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                            {activity.type}
                          </span>
                        </div>
                        <span className="whitespace-nowrap text-xs text-gray-500">
                          {formatDistanceToNow(activity.time, { addSuffix: true }, nowDate)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm text-gray-600">{activity.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Tile>

        {/* Quick actions */}
        <Tile className="md:col-span-2 xl:col-span-1" aria-label="Quick Actions">
          <h2 className="text-xl font-light tracking-tight text-gray-900">Quick Actions</h2>
          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-2">
            {quickActions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => router.push(action.href)}
                className="group flex flex-col items-center gap-2 rounded-2xl p-3 text-center transition-colors hover:bg-gray-50"
              >
                <span className="inline-flex size-11 items-center justify-center rounded-full border border-gray-200 text-gray-700 transition-colors group-hover:border-coral-300 group-hover:text-blue-700">
                  <action.icon className="h-5 w-5" />
                </span>
                <span className="text-xs font-medium text-gray-900">{action.label}</span>
              </button>
            ))}
          </div>
        </Tile>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading...</div>}>
      <DashboardContent />
    </Suspense>
  )
}
