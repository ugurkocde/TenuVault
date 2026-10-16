import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock, Play } from "lucide-react"
import { BigValue, Chip, Tile, TileLabel } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { toast } from "../../lib/toast"
import type { FeatureTabProps } from "../types"
import { formatTime, healthApi, OUTCOME_LABELS, type Status } from "./api"
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
  const run = useMutation({
    mutationFn: () => healthApi.run(tenant),
    onSuccess: (result) => toast(`Review ${OUTCOME_LABELS[result.run.status]?.toLowerCase() ?? result.run.status}. ${result.run.summary}`, result.run.status === "completed" ? "success" : "info"),
    onError: (error) => toast(error instanceof Error ? error.message : "The review failed.", "error"),
    onSettled: refresh,
  })
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
        {data && <StatusTiles status={data} />}
        <FindingsList tenant={tenant} findings={stored} lastRun={data?.lastRun} load={findings} readOnly onChanged={refresh} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {status.error && <p className="text-sm text-red-700" role="alert">{status.error instanceof Error ? status.error.message : "Status could not be loaded."}</p>}
      {data && <StatusTiles status={data} />}

      <Tile aria-labelledby="health-schedule-heading" className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="health-schedule-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
              <Clock className="h-4 w-4 text-gray-500" aria-hidden="true" />
              Schedule
            </h3>
            <p className="max-w-3xl text-sm text-gray-600">{data?.readiness.note}</p>
          </div>
          <Button type="button" onClick={() => run.mutate()} disabled={run.isPending}>
            <Play className="h-4 w-4" aria-hidden="true" />
            {run.isPending ? "Reviewing" : "Review now"}
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

function StatusTiles({ status }: { status: Status }) {
  const { schedule, readiness, lastRun, counts } = status
  const open = counts.critical + counts.high + counts.medium + counts.low
  const tone = readiness.state === "ready" ? "success" : readiness.state === "disabled" ? "neutral" : "warning"
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Tile>
        <TileLabel>Last review</TileLabel>
        <BigValue className="text-xl">{formatTime(schedule?.lastReviewAt ?? lastRun?.finishedAt)}</BigValue>
        {lastRun && <p className="mt-2 text-sm text-gray-600">{OUTCOME_LABELS[lastRun.status] ?? lastRun.status}{lastRun.trigger === "catch-up" ? `, catch-up after ${lastRun.missedWindows} missed windows` : ""}</p>}
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
          {counts.critical} critical, {counts.high} high, {counts.medium} medium, {counts.unknown} with unknown evidence
        </p>
      </Tile>
    </div>
  )
}
