import { useState } from "react"
import { Link } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip, Tile } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { toast } from "../../lib/toast"
import { formatTime, healthApi, SEVERITY_TONE, type Finding, type Run } from "./api"
import { GovernanceExportButtons } from "../shared/GovernanceExportButtons"
import { healthCsv, healthJson } from "../shared/governance-export"

/**
 * Stored findings of the health review. Unknown findings are labelled as unknown evidence,
 * never as passing. Resolved findings are listed separately with the evidence time that
 * resolved them. In read-only mode (plan without the feature) no action is offered.
 */
/** What the list says when no finding is shown: never run, clean, or only resolved findings. */
export function emptyFindingsText(lastRun: Pick<Run, "status" | "finishedAt"> | null | undefined, findings: Finding[]): string {
  if (!lastRun) return findings.length ? "No open findings." : "No review has run yet. Backup status is unknown."
  const when = formatTime(lastRun.finishedAt)
  if (lastRun.status === "partial") return `No open findings in the latest review (${when}). Some evidence could not be read, so it is not a clean result.`
  if (lastRun.status !== "completed") return `No open findings, but the latest review (${when}) did not complete. Review again for current results.`
  return `No open findings in the latest review (${when}).`
}

/**
 * `load` is the state of the findings read: the list and its empty-state text show only after a
 * successful read, never while it loads or after it failed.
 */
export function FindingsList({ tenant, findings, lastRun, load = { status: "success", error: null }, readOnly = false, onChanged }: { tenant: Tenant; findings: Finding[]; lastRun?: Run | null; load?: { status: "pending" | "error" | "success"; error: unknown }; readOnly?: boolean; onChanged: () => void }) {
  const [showResolved, setShowResolved] = useState(false)
  const active = findings.filter((finding) => finding.state !== "resolved")
  const resolved = findings.filter((finding) => finding.state === "resolved")
  const shown = showResolved ? [...active, ...resolved] : active
  return (
    <Tile aria-labelledby="health-findings-heading" className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="health-findings-heading" className="text-lg font-medium text-gray-900">Findings</h3>
        <GovernanceExportButtons kind="health" tenantName={tenant.name} disabled={load.status !== "success" || shown.length === 0} buildCsv={() => healthCsv(shown)} buildJson={(exportedAt) => healthJson(shown, tenant.name, exportedAt)} />
        {resolved.length > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={() => setShowResolved((value) => !value)} aria-pressed={showResolved}>
            {showResolved ? "Hide resolved" : `Show ${resolved.length} resolved`}
          </Button>
        )}
      </div>
      {load.status === "pending" && <p className="text-sm text-gray-500">Loading findings</p>}
      {load.status === "error" && (
        <div role="alert" className="flex flex-wrap items-start justify-between gap-3 text-sm text-red-700">
          <p>{load.error instanceof Error ? load.error.message : "The findings could not be read."}</p>
          <Button type="button" variant="outline" size="sm" onClick={onChanged}>Retry</Button>
        </div>
      )}
      {load.status === "success" && shown.length === 0 && <p className="text-sm text-gray-500">{emptyFindingsText(lastRun, findings)}</p>}
      {load.status === "success" && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {shown.map((finding) => (
            <FindingRow key={finding.id} tenant={tenant} finding={finding} readOnly={readOnly} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </Tile>
  )
}

function FindingRow({ tenant, finding, readOnly, onChanged }: { tenant: Tenant; finding: Finding; readOnly: boolean; onChanged: () => void }) {
  const [owner, setOwner] = useState(finding.owner ?? "")
  const acknowledge = useMutation({ mutationFn: () => healthApi.acknowledge(tenant, finding.id), onSuccess: onChanged, onError: (error) => toast(error instanceof Error ? error.message : "Failed", "error") })
  const saveOwner = useMutation({ mutationFn: () => healthApi.owner(tenant, finding.id, owner.trim() || null), onSuccess: () => { toast("Owner saved", "success"); onChanged() }, onError: (error) => toast(error instanceof Error ? error.message : "Failed", "error") })
  const resolved = finding.state === "resolved"
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={resolved ? "success" : SEVERITY_TONE[finding.severity]}>{resolved ? "Resolved" : finding.severity}</Chip>
        {finding.state === "unknown" && <Chip tone="warning">Unknown evidence</Chip>}
        {finding.occurrence > 1 && <Chip tone="neutral">Reopened {finding.occurrence - 1}x</Chip>}
        {finding.acknowledgedAt && !resolved && <Chip tone="neutral">Acknowledged by {finding.acknowledgedBy ?? "an admin"}</Chip>}
        <span className="font-medium text-gray-900">{finding.title}</span>
      </div>
      <p className="mt-1 text-sm text-gray-600">
        {finding.reason}
        {finding.link && (
          <>
            {" "}
            <Link to={finding.link} className="font-medium text-gray-900 underline underline-offset-2">Open</Link>
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-gray-500">
        First seen {formatTime(finding.firstSeenAt)}; last checked {formatTime(finding.lastSeenAt)}; evidence read {formatTime(finding.observedAt, "never (unknown)")}
        {resolved && `; resolved by fresh evidence ${formatTime(finding.resolvedAt)}`}
      </p>
      {readOnly ? (
        finding.owner && <p className="mt-1 text-xs text-gray-500">Owner: {finding.owner}</p>
      ) : (
        !resolved && (
          <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); saveOwner.mutate() }}>
            <label className="sr-only" htmlFor={`owner-${finding.id}`}>Owner of {finding.title}</label>
            <Input id={`owner-${finding.id}`} className="h-8 w-56" placeholder="Owner" maxLength={200} value={owner} onChange={(event) => setOwner(event.target.value)} />
            <Button type="submit" size="sm" variant="outline" disabled={saveOwner.isPending}>Save owner</Button>
            {!finding.acknowledgedAt && <Button type="button" size="sm" variant="outline" disabled={acknowledge.isPending} onClick={() => acknowledge.mutate()}>Acknowledge</Button>}
          </form>
        )
      )}
    </li>
  )
}
