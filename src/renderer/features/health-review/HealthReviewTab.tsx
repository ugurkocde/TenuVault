import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock, Play } from "lucide-react"
import { BigValue, Chip, Tile, TileLabel } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { toast } from "../../lib/toast"
import { startBackgroundTask, useBackgroundTask } from "../../lib/background-tasks"
import type { FeatureTabProps } from "../types"
import { evidenceAge, formatTime, healthApi, OUTCOME_LABELS, STALE_EVIDENCE_DAYS, type Finding, type Status } from "./api"
import { EndpointsPanel } from "./EndpointsPanel"
import { FindingsList } from "./FindingsList"
import { PortfolioHealth } from "./PortfolioHealth"

const INTERVALS = [6, 12, 24, 48, 168]

/**
 * Health review (#147): scheduled review of stale backups, with opt-in
 * notifications. Without the feature it shows only stored results,
 * read-only, and nothing when there are none.
 */
export default function HealthReviewTab({ tenant, plan, allowed }: FeatureTabProps) {
  const tenantId = tenant.credentials?.tenantId
  const client = useQueryClient()
  const status = useQuery({ queryKey: ["health-status", tenantId], queryFn: () => healthApi.status(tenant), enabled: !!tenantId })
  const findings = useQuery({ queryKey: ["health-findings", tenantId], queryFn: () => healthApi.findings(tenant), enabled: !!tenantId })
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["health-status", tenantId] })
    void client.invalidateQueries({ queryKey: ["health-findings", tenantId] })
  }
  // The review runs as a background task, so it keeps going and stays visible in the activity
  // panel while the admin works elsewhere; coming back here shows it still running.
  const reviewKey = tenantId ? `health-review:${tenantId.toLowerCase()}` : undefined
  const reviewTask = useBackgroundTask(reviewKey)
  const reviewing = reviewTask?.status === "running"
  const startReview = () => {
    if (!reviewKey) return
    startBackgroundTask(reviewKey, { title: "Health review", detail: `Reviewing backups of ${tenant.name}`, href: "/portal/operations/health-review", tenantId }, async () => {
      try {
        const result = await healthApi.run(tenant)
        const outcome = `Review ${OUTCOME_LABELS[result.run.status]?.toLowerCase() ?? result.run.status}. ${result.run.summary}`
        // A run that could not read the tenant at all is a failure, not a completed review.
        if (result.run.status === "could-not-authenticate" || result.run.status === "failed") throw new Error(outcome)
        return outcome
      } finally {
        refresh()
      }
    })
  }
  const schedule = useMutation({
    mutationFn: (body: { enabled?: boolean; intervalHours?: number }) => healthApi.schedule(tenant, body),
    onError: (error) => toast(error instanceof Error ? error.message : "The schedule could not be saved.", "error"),
    onSettled: refresh,
  })

  const data = status.data
  const stored = findings.data ?? []
  if (!allowed) {
    if (!data?.lastRun && stored.length === 0) return null
    return (
      <div className="space-y-4">
        {data && <StatusTiles status={data} findings={stored} />}
        <FindingsList tenant={tenant} findings={stored} lastRun={data?.lastRun} load={findings} readOnly onChanged={refresh} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {status.error && <p className="text-sm text-red-700" role="alert">{status.error instanceof Error ? status.error.message : "Status could not be loaded."}</p>}
      {data && <StatusTiles status={data} findings={stored} review={{ run: startReview, running: reviewing }} />}

      <Tile aria-labelledby="health-schedule-heading" className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="health-schedule-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
              <Clock className="h-4 w-4 text-gray-500" aria-hidden="true" />
              Schedule
            </h3>
            <p className="max-w-3xl text-sm text-gray-600">{data?.readiness.note}</p>
          </div>
          <Button type="button" onClick={startReview} disabled={reviewing}>
            <Play className="h-4 w-4" aria-hidden="true" />
            {reviewing ? "Reviewing in background" : "Review now"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2 text-gray-800">
            <input
              type="checkbox"
              className="size-4 accent-coral-600"
              checked={data?.schedule?.enabled ?? false}
              disabled={schedule.isPending || !data}
              onChange={(event) => schedule.mutate({ enabled: event.target.checked })}
            />
            Review on a schedule
          </label>
          <label className="flex items-center gap-2 text-gray-700">
            Every
            <select
              className="h-9 rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-900 dark:bg-input/30"
              value={data?.schedule?.intervalHours ?? 24}
              disabled={schedule.isPending || !data}
              onChange={(event) => schedule.mutate({ intervalHours: Number(event.target.value) })}
            >
              {INTERVALS.map((hours) => (
                <option key={hours} value={hours}>{hours === 168 ? "7 days" : `${hours} hours`}</option>
              ))}
            </select>
          </label>
        </div>
        {data && (
          <p className="text-xs text-gray-500">
            Thresholds: backups healthy below {data.thresholds.backupWarningHours} hours and critical after {data.thresholds.backupCriticalHours} hours.
          </p>
        )}
      </Tile>

      <FindingsList tenant={tenant} findings={stored} lastRun={data?.lastRun} load={findings} onChanged={refresh} />
      <EndpointsPanel tenant={tenant} endpoints={data?.endpoints ?? []} onChanged={refresh} />
      <PortfolioHealth tenant={tenant} plan={plan} />
    </div>
  )
}

/** Where stale evidence is refreshed, by the screen a finding links to. */
const REFRESH_LABELS: Record<string, string> = { "/portal/governance/hygiene": "Scan the latest backup in Conflicts and hygiene" }

export function StatusTiles({ status, findings, review, now }: { status: Status; findings: Finding[]; review?: { run: () => void; running: boolean }; now?: number }) {
  const { schedule, readiness, lastRun, counts } = status
  const open = counts.critical + counts.high + counts.medium + counts.low
  const tone = readiness.state === "ready" ? "success" : readiness.state === "disabled" ? "neutral" : "warning"
  const evidence = evidenceAge(findings, now)
  return (
    <div className="space-y-4">
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Tile>
        <TileLabel>Last review</TileLabel>
        <BigValue className="text-xl">{formatTime(schedule?.lastReviewAt ?? lastRun?.finishedAt)}</BigValue>
        {lastRun && <p className="mt-2 text-sm text-gray-600">{OUTCOME_LABELS[lastRun.status] ?? lastRun.status}{lastRun.trigger === "catch-up" ? `, catch-up after ${lastRun.missedWindows} missed windows` : ""}</p>}
      </Tile>
      <Tile>
        <TileLabel>Evidence from</TileLabel>
        <BigValue className="text-xl">{evidence.oldest ? new Date(evidence.oldest).toLocaleDateString(undefined, { dateStyle: "medium" }) : "No dated evidence"}</BigValue>
        {evidence.ageDays !== null && <p className="mt-2 text-sm text-gray-600">Oldest evidence of the open findings, {evidence.ageDays === 0 ? "from today" : `${evidence.ageDays} ${evidence.ageDays === 1 ? "day" : "days"} old`}.</p>}
        {evidence.stale > 0 && <div className="mt-2"><Chip tone="warning">Stale</Chip></div>}
      </Tile>
      <Tile>
        <TileLabel>Scheduling readiness</TileLabel>
        <div className="mt-1"><Chip tone={tone}>{readiness.state === "ready" ? "Ready" : readiness.state === "disabled" ? "Off" : readiness.state === "sign-in-required" ? "Sign-in required" : "Not licensed"}</Chip></div>
        <p className="mt-2 text-sm text-gray-600">{readiness.message}</p>
        {schedule?.enabled && <p className="mt-1 text-sm text-gray-600">Next due: {formatTime(schedule.nextDueAt, "Now")}</p>}
      </Tile>
      <Tile>
        <TileLabel>Open findings</TileLabel>
        <BigValue>{lastRun || open ? open : "Unknown"}</BigValue>
        <p className="mt-2 text-sm text-gray-600">
          {counts.critical} critical, {counts.high} high, {counts.medium} medium, {counts.low} low, {counts.unknown} with unknown evidence
        </p>
      </Tile>
    </div>
    {evidence.stale > 0 && (
      <div role="status" aria-label="Stale evidence" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <span>
          {evidence.stale === 1 ? "1 open finding is" : `${evidence.stale} open findings are`} based on evidence older than {STALE_EVIDENCE_DAYS} days, the oldest from {formatTime(evidence.oldest)}. A review reads stored evidence, so refresh it at its source first, then review again.
        </span>
        {evidence.staleLink && <Link to={evidence.staleLink} className="font-medium text-gray-900 underline underline-offset-2">{REFRESH_LABELS[evidence.staleLink] ?? "Open the source"}</Link>}
        {review && <Button type="button" size="sm" variant="outline" onClick={review.run} disabled={review.running}>{review.running ? "Reviewing" : "Review now"}</Button>}
      </div>
    )}
    </div>
  )
}
