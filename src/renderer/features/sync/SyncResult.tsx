import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { AlertTriangle, Check, ExternalLink, RotateCcw, X } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { cn } from "~/lib/utils"
import { ChangeSetFlow } from "../shared/ChangeSetFlow"
import { syncRollbackActions, syncTargetActions, type SyncBackup, type SyncTarget } from "./api"
import { backupOf, excludedReason, failedItems, initials, intuneLink, linkPath, plural, progress, targetPhase, type TargetPhase } from "./model"

export interface ResultTarget {
  target: SyncTarget
  name: string
  domain: string
  phase: TargetPhase
}

const FINISHED: TargetPhase[] = ["verified", "partial", "failed", "in-sync"]

/** A backup completed before the target was written: its pre-change evidence names a backup folder. */
const backedUp = (target: SyncTarget) => !!target.changeSet?.preChange?.backupFolder

/** Only an approved change set can be applied again; one that was never approved needs a new sync. */
const retryable = (target: SyncTarget) => ["approved", "partial", "failed", "uncertain"].includes(target.changeSet?.status ?? "")

const STROKE: Record<TargetPhase, string> = {
  excluded: "stroke-border",
  waiting: "stroke-border",
  writing: "stroke-coral-500",
  verified: "stroke-green-600",
  partial: "stroke-amber-500",
  failed: "stroke-red-500",
  "in-sync": "stroke-green-600",
}
const FILL: Record<TargetPhase, string> = {
  excluded: "fill-border",
  waiting: "fill-border",
  writing: "fill-coral-500",
  verified: "fill-green-600",
  partial: "fill-amber-500",
  failed: "fill-red-500",
  "in-sync": "fill-green-600",
}
const BAR: Record<TargetPhase, string> = { excluded: "bg-gray-300", waiting: "bg-gray-300", writing: "bg-coral-500", verified: "bg-green-600", partial: "bg-amber-500", failed: "bg-red-500", "in-sync": "bg-green-600" }
const NODE: Record<TargetPhase, string> = {
  excluded: "border-dashed border-border opacity-80",
  waiting: "border-border",
  writing: "border-coral-500",
  verified: "border-green-600 shadow-[0_0_0_4px_rgba(22,163,74,0.14),0_6px_20px_-8px_rgba(22,21,20,0.25)]",
  partial: "border-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.16),0_6px_20px_-8px_rgba(22,21,20,0.25)]",
  failed: "border-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.14),0_6px_20px_-8px_rgba(22,21,20,0.25)]",
  "in-sync": "border-green-600 shadow-[0_0_0_4px_rgba(22,163,74,0.14),0_6px_20px_-8px_rgba(22,21,20,0.25)]",
}

function StateIcon({ phase }: { phase: TargetPhase }) {
  if (phase === "writing") return <span aria-hidden="true" className="size-7 shrink-0 rounded-full border-2 border-border border-t-coral-500 motion-safe:animate-spin" />
  if (phase === "verified" || phase === "in-sync") return <span aria-hidden="true" className="sync-pop flex size-7 shrink-0 items-center justify-center rounded-full bg-green-600 text-white"><Check className="h-4 w-4" strokeWidth={3} /></span>
  if (phase === "partial") return <span aria-hidden="true" className="sync-pop flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white"><AlertTriangle className="h-3.5 w-3.5" strokeWidth={3} /></span>
  if (phase === "failed") return <span aria-hidden="true" className="sync-pop flex size-7 shrink-0 items-center justify-center rounded-full bg-red-500 text-white"><X className="h-4 w-4" strokeWidth={3} /></span>
  return <span aria-hidden="true" className="size-7 shrink-0 rounded-full bg-secondary" />
}

/** What a target node says, from its stored change set and this screen's requests. */
function nodeText(entry: ResultTarget, backup: SyncBackup, error: string | null, note: string | null): { text: string; problems: string[] } {
  const { target, phase } = entry
  const { done, total } = progress(target)
  const taken = backupOf(target.changeSet) ?? backup
  const problems = [...failedItems(target.changeSet).map((item) => `${item.name}: ${item.message}`), ...(error ? [error] : [])]
  if (!problems.length && phase !== "verified" && target.changeSet?.lastError) problems.push(target.changeSet.lastError)
  switch (phase) {
    case "waiting": return { text: "Waiting", problems: [] }
    case "writing": return { text: target.changeSet?.preChange ? `Writing, ${done} of ${total} verified` : taken === "none" ? "Saving current versions, then writing" : "Backing up, then writing", problems: [] }
    case "verified": return { text: `${plural(total, "change", "changes")} verified${target.skipped?.length ? `, ${target.skipped.length} already in sync` : ""}. ${backedUp(target) ? "Backup taken first." : "No backup taken."}`, problems: [] }
    case "in-sync": return { text: "Already in sync, nothing written. No backup taken.", problems: [] }
    case "partial": return { text: `${done} of ${total} synced. ${failedItems(target.changeSet).length || 1} failed:`, problems }
    case "failed": return { text: target.changeSet && !retryable(target) ? "Nothing was synced. Start a new sync to review it again." : "Nothing was synced.", problems }
    default: return { text: `Not synced. ${note ?? excludedReason(target)}`, problems: [] }
  }
}

interface Geometry { x2: number; y2: number; d: string; mid: { x: number; y: number } }

/**
 * The result of a Sync run as a flowchart: the source on the left, one node per target on the
 * right, linked by curves. Every state is the target's stored change set, polled by the page
 * while a target writes: the link draws out and a dot travels along it while writing, then the
 * link, arrowhead and node turn green (verified), amber (partly applied) or red (nothing applied).
 */
export function SyncFlowchart({ source, policyCount, targets, backup, errors, notes, platforms, onRetry, retrying, detailsOpen, onDetails }: {
  source: { name: string; domain: string }
  policyCount: number
  targets: ResultTarget[]
  backup: SyncBackup
  errors: Record<string, string>
  notes: Record<string, string>
  platforms: Record<string, string | null>
  onRetry: (target: SyncTarget) => void
  retrying: boolean
  detailsOpen: string | null
  onDetails: (tenantId: string | null) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const sourceNode = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const [links, setLinks] = useState<Record<string, Geometry>>({})
  const ids = targets.map((entry) => entry.target.targetTenantId).join()

  // Layout positions (offsets, not transformed boxes), measured again whenever a node resizes.
  useLayoutEffect(() => {
    const measure = () => {
      const from = sourceNode.current
      if (!from) return
      const x1 = from.offsetLeft + from.offsetWidth
      const y1 = from.offsetTop + from.offsetHeight / 2
      const next: Record<string, Geometry> = {}
      for (const [id, node] of nodes.current) {
        const x2 = node.offsetLeft - 12
        const y2 = node.offsetTop + node.offsetHeight / 2
        next[id] = { x2, y2, ...linkPath(x1, y1, x2, y2) }
      }
      setLinks(next)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    for (const element of [box.current, sourceNode.current, ...nodes.current.values()]) if (element) observer.observe(element)
    return () => observer.disconnect()
  }, [ids])

  return (
    <div ref={box} className="relative grid grid-cols-[minmax(0,13rem)_minmax(4rem,1fr)_minmax(0,17rem)] items-center gap-y-4">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {targets.map(({ target, phase }) => {
          const link = links[target.targetTenantId]
          if (!link) return null
          const finished = FINISHED.includes(phase)
          return (
            <g key={target.targetTenantId}>
              <path d={link.d} fill="none" strokeWidth={2} className="stroke-border" strokeDasharray={phase === "excluded" ? "4 5" : undefined} />
              {phase !== "excluded" && phase !== "waiting" && <path d={link.d} pathLength={1} fill="none" strokeWidth={2.5} strokeLinecap="round" className={cn("sync-link", STROKE[phase])} />}
              <path d={`M${link.x2},${link.y2 - 6} L${link.x2 + 11},${link.y2} L${link.x2},${link.y2 + 6} Z`} className={cn("transition-[fill] duration-500", FILL[phase])} />
              {finished && (
                <g key={phase}>
                  <circle cx={link.mid.x} cy={link.mid.y} r={7} fill="none" strokeWidth={2} className={cn("sync-ring", STROKE[phase])} />
                  <circle cx={link.mid.x} cy={link.mid.y} r={6} className={cn("sync-pop", FILL[phase])} />
                </g>
              )}
            </g>
          )
        })}
      </svg>
      {targets.map(({ target, phase }) => {
        const link = links[target.targetTenantId]
        return phase === "writing" && link ? <span key={`pulse-${target.targetTenantId}`} aria-hidden="true" className="sync-pulse pointer-events-none absolute left-0 top-0 size-2.5 rounded-full bg-coral-500" style={{ offsetPath: `path("${link.d}")` }} /> : null
      })}

      <div ref={sourceNode} className="sync-node relative z-10 min-w-0 self-center rounded-3xl border-2 border-border bg-card p-4 shadow-[0_6px_20px_-8px_rgba(22,21,20,0.25)]" style={{ gridColumn: 1, gridRow: `1 / span ${Math.max(1, targets.length)}` }}>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Source</p>
        <div className="mt-2 flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-coral-50 text-[11px] font-bold text-coral-600">{initials(source.name)}</span>
          <span className="min-w-0"><span className="block truncate text-sm font-semibold text-gray-900">{source.name}</span><span className="block truncate text-xs text-gray-500">{source.domain}</span></span>
        </div>
        <p className="mt-3 text-xs text-gray-600">{plural(policyCount, "policy", "policies")} selected. Does not change.</p>
      </div>

      {targets.map((entry, index) => {
        const { target, phase, name, domain } = entry
        const id = target.targetTenantId
        const { done, total } = progress(target)
        const { text, problems } = nodeText(entry, backup, errors[id] ?? null, notes[id] ?? null)
        const finished = FINISHED.includes(phase)
        const intune = finished ? intuneLink(target, platforms) : null
        const width = phase === "verified" || phase === "in-sync" ? 100 : phase === "excluded" || phase === "waiting" ? 0 : total ? Math.max(phase === "writing" ? 8 : 0, (done / total) * 100) : 8
        return (
          <div
            key={id}
            ref={(element) => { if (element) nodes.current.set(id, element); else nodes.current.delete(id) }}
            role="group"
            aria-label={`${name}: ${text}`}
            className={cn("sync-node relative z-10 min-w-0 rounded-3xl border-2 bg-card p-4 shadow-[0_6px_20px_-8px_rgba(22,21,20,0.25)]", NODE[phase])}
            style={{ gridColumn: 3, gridRow: index + 1, animationDelay: `${index * 80}ms` }}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Target</p>
            <div className="mt-2 flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-bold text-gray-700">{initials(name)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-gray-900">{name}</span><span className="block truncate text-xs text-gray-500">{domain}</span></span>
              <StateIcon key={phase} phase={phase} />
            </div>
            <p className="mt-3 text-xs text-gray-600">{text}</p>
            {problems.length > 0 && (
              <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto text-xs text-red-700">
                {problems.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}
              </ul>
            )}
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-secondary">
              <div className={cn("h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500", BAR[phase])} style={{ width: `${width}%` }} />
            </div>
            {finished && (
              <div className="mt-3 flex flex-wrap gap-2">
                {intune && (
                  <Button asChild size="sm">
                    <a href={intune.url} target="_blank" rel="noreferrer" title={`Opens the Intune admin center in ${name}${intune.exact ? "" : ", on the list of this policy type"}`}>
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      Open Intune
                    </a>
                  </Button>
                )}
                {(phase === "partial" || phase === "failed") && retryable(target) && (
                  <Button type="button" size="sm" variant="secondary" disabled={retrying} aria-describedby={`retry-${id}`} onClick={() => onRetry(target)}>
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    Retry failed
                  </Button>
                )}
                {target.changeSet && (
                  <Button type="button" size="sm" variant="ghost" aria-expanded={detailsOpen === id} onClick={() => onDetails(detailsOpen === id ? null : id)}>
                    Details
                  </Button>
                )}
              </div>
            )}
            {finished && (phase === "partial" || phase === "failed") && retryable(target) && (
              <p id={`retry-${id}`} className="mt-2 text-xs text-gray-500">{(backupOf(target.changeSet) ?? backup) === "none" ? "Retry applies without a backup, as this sync started." : "Retry backs up first."}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The result view of a Sync run: its status line, the flowchart, the summary chips once every
 * target finished, and the details (change set, results and rollback) of one target.
 */
export function SyncResult({ source, policyCount, entries, backup, errors, notes, platforms, onRetry, retrying, tenantOf, onChanged }: {
  source: { name: string; domain: string }
  policyCount: number
  entries: ResultTarget[]
  backup: SyncBackup
  errors: Record<string, string>
  notes: Record<string, string>
  platforms: Record<string, string | null>
  onRetry: (target: SyncTarget) => void
  retrying: boolean
  tenantOf: (tenantId: string) => Tenant | undefined
  onChanged: () => void
}) {
  const [detailsOpen, setDetailsOpen] = useState<string | null>(null)
  // The approve button that led here is gone; keyboard and screen reader focus moves to the outcome.
  const statusLine = useRef<HTMLParagraphElement>(null)
  useEffect(() => statusLine.current?.focus(), [])
  const involved = entries.filter((entry) => entry.phase !== "excluded")
  const running = involved.some((entry) => entry.phase === "writing" || entry.phase === "waiting")
  const verified = involved.filter((entry) => entry.phase === "verified" || entry.phase === "in-sync").length
  const attention = involved.length - verified
  const anyWritten = involved.some((entry) => progress(entry.target).done > 0)
  // Targets already in sync wrote nothing, so they took no backup and decide nothing here. The
  // backup chip counts completed backups from the stored evidence, never the requested choice.
  const written = involved.filter((entry) => entry.target.changeSet)
  const attempted = written.filter((entry) => backupOf(entry.target.changeSet) !== null)
  const backups = attempted.filter((entry) => backedUp(entry.target)).length
  const skipped = attempted.some((entry) => backupOf(entry.target.changeSet) === "none")
  const backupChip = skipped ? <Chip tone="warning">Backup skipped</Chip>
    : !backups ? null
    : backups === attempted.length ? <Chip>Backup taken in each tenant</Chip>
    : <Chip>Backup taken in {backups} of {attempted.length} tenants</Chip>
  const open = entries.find((entry) => entry.target.targetTenantId === detailsOpen)
  const openTenant = open ? tenantOf(open.target.targetTenantId) : undefined

  return (
    <div className="space-y-5">
      <p ref={statusLine} tabIndex={-1} role="status" className="flex items-center gap-2.5 text-base font-semibold outline-none">
        {running ? (
          <>
            <span aria-hidden="true" className="size-4 rounded-full border-2 border-border border-t-coral-500 motion-safe:animate-spin" />
            <span className="text-gray-900">Syncing to {plural(involved.length, "tenant", "tenants")}</span>
          </>
        ) : !involved.length ? (
          <span className="text-gray-900">Nothing was synced. No target was approved.</span>
        ) : involved.every((entry) => entry.phase === "in-sync") ? (
          <span className="text-green-700">Already in sync. Nothing was written.</span>
        ) : attention === 0 ? (
          <span className="text-green-700">Synced to {plural(verified, "tenant", "tenants")}</span>
        ) : verified === 0 && !anyWritten ? (
          <span className="text-red-700">Nothing was synced. {plural(attention, "tenant needs", "tenants need")} attention.</span>
        ) : (
          <span className="text-amber-700">Synced to {verified} of {plural(involved.length, "tenant", "tenants")}. {attention} {attention === 1 ? "needs" : "need"} attention.</span>
        )}
      </p>
      <SyncFlowchart source={source} policyCount={policyCount} targets={entries} backup={backup} errors={errors} notes={notes} platforms={platforms} onRetry={onRetry} retrying={retrying} detailsOpen={detailsOpen} onDetails={setDetailsOpen} />
      {!running && written.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Summary">
          {anyWritten && <Chip tone="success">Links saved for the next sync</Chip>}
          {anyWritten && <Chip>Rollback available per tenant</Chip>}
          {backupChip}
          {written.length > 0 && <Chip>Recorded in the audit log</Chip>}
        </div>
      )}
      {open?.target.changeSet && open.target.promotionId && openTenant && (
        <section aria-label={`Details for ${open.name}`} className="space-y-4 rounded-3xl bg-gray-50 p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-900">Details: {open.name}</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDetailsOpen(null)}>Close</Button>
          </div>
          <ChangeSetFlow
            key={open.target.changeSet.id}
            changeSet={open.target.changeSet}
            actions={syncTargetActions(openTenant, open.target.promotionId)}
            tenantName={open.name}
            onChanged={onChanged}
            decisionFields={false}
            backupSkipped={(backupOf(open.target.changeSet) ?? backup) === "none"}
            intro={<p className="text-sm text-gray-600">Backup choice of this sync: {(backupOf(open.target.changeSet) ?? backup) === "none" ? "applied without a backup. Rollback uses the saved current versions." : "back up the affected policy types first."}</p>}
            rollbackHint="Rollback created. Review, approve and apply it below."
          />
          {open.target.rollbackChangeSet && (
            <div className="space-y-2 border-t border-gray-200 pt-5">
              <p className="text-sm font-medium text-gray-900">Rollback</p>
              <ChangeSetFlow key={open.target.rollbackChangeSet.id} changeSet={open.target.rollbackChangeSet} actions={syncRollbackActions(openTenant, open.target.promotionId)} tenantName={open.name} onChanged={onChanged} decisionFields={false} />
            </div>
          )}
        </section>
      )}
    </div>
  )
}

/** The result entries of a run's targets, in run order, with the tenant names this app knows. */
export function resultEntries(targets: SyncTarget[], tenantOf: (tenantId: string) => Tenant | undefined, active: ReadonlySet<string>, errors: Record<string, string>): ResultTarget[] {
  return targets.map((target) => {
    const tenant = tenantOf(target.targetTenantId)
    return { target, name: tenant?.name ?? target.targetTenantId, domain: tenant?.domain ?? "", phase: targetPhase(target, active.has(target.targetTenantId), errors[target.targetTenantId] ?? null) }
  })
}
