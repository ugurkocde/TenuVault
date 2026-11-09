import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { AlertTriangle, ArrowRight, Check, Clock, ExternalLink, Minus, PenLine, Plus, RotateCcw, Trash2, X } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { cn } from "~/lib/utils"
import { ChangeSetFlow } from "../shared/ChangeSetFlow"
import { syncRollbackActions, syncTargetActions, type SyncTarget } from "./api"
import { applyStage, awaitingReview, backupOf, excludedReason, failedItems, initials, intuneLink, linkPath, mayHaveWritten, outcomeCounts, plural, progress, targetPhase, type ApplyStage, type TargetPhase } from "./model"
import { Spinner } from "./loading"

export interface ResultTarget {
  target: SyncTarget
  name: string
  domain: string
  phase: TargetPhase
  /** The target tenant has backup storage; a rollback always backs up first, so it needs it. */
  storage: boolean
  /** This screen's approve or apply request for the target is running. */
  active?: boolean
}

const NO_ROLLBACK = "Rollback needs backup storage in this tenant."

const FINISHED: TargetPhase[] = ["verified", "partial", "failed", "in-sync"]

/** A backup completed before the target was written: its pre-change evidence names a backup folder. */
const backedUp = (target: SyncTarget) => !!target.changeSet?.preChange?.backupFolder

/** Only an approved change set can be applied again; one that was never approved needs a new sync. */
const retryable = (target: SyncTarget) => ["approved", "partial", "failed", "uncertain"].includes(target.changeSet?.status ?? "")

/** The color of a phase, as a CSS variable from desktop.css, so links follow light and dark mode. */
const COLOR: Record<TargetPhase, string> = {
  excluded: "var(--sync-line)",
  waiting: "var(--sync-line)",
  writing: "var(--sync-write)",
  verified: "var(--sync-ok)",
  partial: "var(--sync-warn)",
  failed: "var(--sync-fail)",
  "in-sync": "var(--sync-ok)",
}
const BAR: Record<TargetPhase, string> = { excluded: "bg-gray-300", waiting: "bg-gray-300", writing: "bg-coral-500", verified: "bg-green-600", partial: "bg-amber-500", failed: "bg-red-500", "in-sync": "bg-green-600" }
const BADGE: Partial<Record<TargetPhase, string>> = { verified: "bg-green-600", "in-sync": "bg-green-600", partial: "bg-amber-500", failed: "bg-red-500" }
const NODE: Record<TargetPhase, string> = {
  // Only a target left out is faded; every other state stays fully opaque.
  excluded: "border-dashed border-border opacity-80",
  waiting: "border-border",
  writing: "border-coral-500",
  verified: "border-green-600 shadow-[0_0_0_4px_rgba(22,163,74,0.12),0_6px_20px_-8px_rgba(22,21,20,0.25)]",
  partial: "border-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.14),0_6px_20px_-8px_rgba(22,21,20,0.25)]",
  failed: "border-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.12),0_6px_20px_-8px_rgba(22,21,20,0.25)]",
  "in-sync": "border-green-600 shadow-[0_0_0_4px_rgba(22,163,74,0.12),0_6px_20px_-8px_rgba(22,21,20,0.25)]",
}

/** A check mark whose stroke draws in once. */
export function DrawnCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" className="sync-check" />
    </svg>
  )
}

function StateIcon({ phase }: { phase: TargetPhase }) {
  if (phase === "writing") return <Spinner className="size-7" />
  if (phase === "verified" || phase === "in-sync") return <span aria-hidden="true" className="sync-pop flex size-7 shrink-0 items-center justify-center rounded-full bg-green-600 text-white"><DrawnCheck className="h-4 w-4" /></span>
  if (phase === "partial") return <span aria-hidden="true" className="sync-pop flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white"><AlertTriangle className="h-3.5 w-3.5" strokeWidth={3} /></span>
  if (phase === "failed") return <span aria-hidden="true" className="sync-pop flex size-7 shrink-0 items-center justify-center rounded-full bg-red-500 text-white"><X className="h-4 w-4" strokeWidth={3} /></span>
  return <span aria-hidden="true" className="size-7 shrink-0 rounded-full border-2 border-dashed border-border" />
}

/** What a target node says, from its stored change set and this screen's requests. */
function nodeText(entry: ResultTarget, error: string | null, note: string | null, stage: ApplyStage | null): { text: string; problems: string[] } {
  const { target, phase } = entry
  const { done, total } = progress(target)
  const problems = [...failedItems(target.changeSet).map((item) => `${item.name}: ${item.message}`), ...(error ? [error] : [])]
  if (!problems.length && phase !== "verified" && target.changeSet?.lastError) problems.push(target.changeSet.lastError)
  switch (phase) {
    case "waiting": return { text: "Waiting", problems: [] }
    case "writing": return { text: stage?.label ?? "Writing", problems: [] }
    case "verified": return { text: `${plural(total, "change", "changes")} verified${target.skipped?.length ? `, ${target.skipped.length} already in sync` : ""}. ${backedUp(target) ? "Backup taken first." : "No backup taken."}`, problems: [] }
    case "in-sync": return { text: "Already in sync, nothing written. No backup taken.", problems: [] }
    case "partial": return { text: `${done} of ${total} synced. ${failedItems(target.changeSet).length || 1} failed:`, problems }
    case "failed": return { text: target.changeSet && !retryable(target) ? "Nothing was synced. Start a new sync to review it again." : "Nothing was synced.", problems }
    default: return { text: `Not synced. ${note ?? excludedReason(target)}`, problems: [] }
  }
}

/** How far a target is, 0 to 1, from its stored stage and verified operations; finished targets count in full. */
function share(entry: ResultTarget): number {
  if (FINISHED.includes(entry.phase)) return 1
  const stage = applyStage(entry.target, !!entry.active)
  if (!stage) return 0
  const { done, total } = progress(entry.target)
  return [0.05, 0.15, 0.25 + 0.6 * (total ? done / total : 0), 0.92][stage.step]!
}

/** The four stages of a writing target: done ones checked, the current one beating, the rest waiting. */
function StageList({ stage }: { stage: ApplyStage }) {
  return (
    <ol aria-label="Stages" className="mt-3 grid grid-cols-4 gap-1.5">
      {stage.steps.map((label, index) => {
        const done = index < stage.step
        const current = index === stage.step
        return (
          <li key={label} aria-current={current ? "step" : undefined} className="min-w-0">
            <span className={cn("block h-1 rounded-full transition-colors duration-500", done ? "bg-green-600" : current ? "bg-coral-500" : "bg-secondary")} />
            <span className={cn("mt-1.5 flex items-center gap-1 truncate text-[11px]", current ? "font-semibold text-gray-900" : done ? "text-gray-600" : "text-gray-400")}>
              {done ? <Check className="h-3 w-3 shrink-0 text-green-600" strokeWidth={3} aria-hidden="true" /> : current ? <span aria-hidden="true" className="sync-beat size-1.5 shrink-0 rounded-full bg-coral-500" /> : null}
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Created, updated, already in sync and failed counts of a finished target, with small icons. */
function Outcome({ target }: { target: SyncTarget }) {
  const counts = outcomeCounts(target)
  const items: Array<[number, string, ReactNode, string]> = [
    [counts.created, "created", <Plus key="c" className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />, "text-green-700"],
    [counts.updated, "updated", <PenLine key="u" className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />, "text-green-700"],
    [counts.skipped, "skipped", <Minus key="s" className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />, "text-gray-600"],
    [counts.failed, "failed", <X key="f" className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />, "text-red-700"],
  ]
  const shown = items.filter(([count]) => count > 0)
  if (!shown.length) return null
  return (
    <ul aria-label="Outcome" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {shown.map(([count, label, icon, tone], index) => (
        <li key={label} className={cn("sync-chip items-center gap-1 font-medium", tone)} style={{ animationDelay: `${index * 60}ms` }}>{icon}{count} {label}</li>
      ))}
    </ul>
  )
}

interface Geometry { x1: number; y1: number; x2: number; y2: number; d: string; mid: { x: number; y: number } }

/**
 * The result of a Sync run as a compact flowchart, centred: the source on the left, one node per
 * target on the right, linked by short curves whose length is capped, so both sides stay close at
 * any window width. Every state is the target's stored change set, polled by the page while a
 * target writes: the link draws in and dots travel along it while writing, then a badge on the
 * link and the node turn green (verified), amber (partly applied) or red (nothing applied). Only a
 * target left out keeps a neutral dashed link.
 */
export function SyncFlowchart({ source, policies, policyCount, targets, errors, notes, platforms, onRetry, retrying, detailsOpen, onDetails }: {
  source: { name: string; domain: string }
  policies: string[]
  policyCount: number
  targets: ResultTarget[]
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
        const x2 = node.offsetLeft
        const y2 = node.offsetTop + node.offsetHeight / 2
        next[id] = { x1, y1, x2, y2, ...linkPath(x1, y1, x2, y2) }
      }
      setLinks(next)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    for (const element of [box.current, sourceNode.current, ...nodes.current.values()]) if (element) observer.observe(element)
    return () => observer.disconnect()
  }, [ids])

  const shownPolicies = policies.slice(0, 3)
  return (
    <div className="@container">
      <div ref={box} className="relative mx-auto grid grid-cols-[minmax(9rem,15rem)_clamp(4.5rem,18cqi,17.5rem)_minmax(12rem,19rem)] items-center justify-center gap-y-4">
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          {targets.map(({ target, phase }) => {
            const link = links[target.targetTenantId]
            if (!link) return null
            const id = `sync-link-${target.targetTenantId}`
            const drawn = phase !== "excluded" && phase !== "waiting"
            return (
              <g key={target.targetTenantId}>
                <defs>
                  <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2}>
                    <stop offset="0" style={{ stopColor: "var(--sync-from)" }} />
                    <stop offset="1" style={{ stopColor: COLOR[phase] }} />
                  </linearGradient>
                </defs>
                <path d={link.d} fill="none" strokeWidth={2} style={{ stroke: "var(--sync-line)" }} strokeDasharray={phase === "excluded" ? "3 5" : undefined} strokeLinecap="round" />
                {drawn && <path d={link.d} pathLength={1} fill="none" strokeWidth={2.5} strokeLinecap="round" stroke={`url(#${id})`} className="sync-link" />}
                <circle cx={link.x1} cy={link.y1} r={3.5} style={{ fill: drawn ? "var(--sync-from)" : "var(--sync-line)" }} />
                <circle cx={link.x2} cy={link.y2} r={3.5} className="transition-[fill] duration-500" style={{ fill: COLOR[phase] }} />
                {FINISHED.includes(phase) && <circle key={phase} cx={link.mid.x} cy={link.mid.y} r={11} fill="none" strokeWidth={2} className="sync-ring" style={{ stroke: COLOR[phase] }} />}
              </g>
            )
          })}
        </svg>
        {targets.map(({ target, phase }) => {
          const link = links[target.targetTenantId]
          if (!link) return null
          if (phase === "writing") {
            return [0, 0.5, 1].map((delay) => <span key={`pulse-${target.targetTenantId}-${delay}`} aria-hidden="true" className="sync-pulse pointer-events-none absolute left-0 top-0 -ml-1 -mt-1 size-2 rounded-full bg-coral-500 shadow-[0_0_0_3px_rgba(228,103,75,0.18)]" style={{ offsetPath: `path("${link.d}")`, animationDelay: `${delay}s` }} />)
          }
          const badge = BADGE[phase]
          if (!badge) return null
          // The end state sits on the link: a check, a warning or a cross.
          return (
            <span key={`badge-${target.targetTenantId}`} aria-hidden="true" className="pointer-events-none absolute z-10 -ml-3 -mt-3" style={{ left: link.mid.x, top: link.mid.y }}>
              <span key={phase} className={cn("sync-pop flex size-6 items-center justify-center rounded-full text-white ring-4 ring-card", badge)}>
                {phase === "partial" ? <AlertTriangle className="h-3 w-3" strokeWidth={3} /> : phase === "failed" ? <X className="h-3.5 w-3.5" strokeWidth={3} /> : <DrawnCheck className="h-3.5 w-3.5" />}
              </span>
            </span>
          )
        })}

        <div ref={sourceNode} className="sync-node relative z-10 min-w-0 self-center rounded-3xl border-2 border-border bg-card p-4 shadow-[0_6px_20px_-8px_rgba(22,21,20,0.25)]" style={{ gridColumn: 1, gridRow: `1 / span ${Math.max(1, targets.length)}` }}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Source</p>
          <div className="mt-2 flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-coral-50 text-[11px] font-bold text-coral-600">{initials(source.name)}</span>
            <span className="min-w-0"><span className="block truncate text-sm font-semibold text-gray-900" title={source.name}>{source.name}</span><span className="block truncate text-xs text-gray-500">{source.domain}</span></span>
          </div>
          <p className="mt-3 text-xs text-gray-600">{plural(policyCount, "policy", "policies")} selected. Does not change.</p>
          {shownPolicies.length > 0 && (
            <ul aria-label="Policies" className="mt-2 space-y-1 border-t border-gray-100 pt-2 text-xs text-gray-700">
              {shownPolicies.map((name, index) => <li key={`${index}-${name}`} className="truncate" title={name}>{name}</li>)}
              {policies.length > shownPolicies.length && <li className="text-gray-500">and {policies.length - shownPolicies.length} more</li>}
            </ul>
          )}
        </div>

        {targets.map((entry, index) => {
          const { target, phase, name, domain } = entry
          const id = target.targetTenantId
          const stage = phase === "writing" ? applyStage(target, !!entry.active) : null
          const { text, problems } = nodeText(entry, errors[id] ?? null, notes[id] ?? null, stage)
          const finished = FINISHED.includes(phase)
          const intune = finished ? intuneLink(target, platforms) : null
          // Verified share of the operations; a finished target that verified everything is full.
          const { done, total } = progress(target)
          const width = phase === "partial" || phase === "failed" ? Math.round((total ? done / total : 0) * 100) : Math.round(share(entry) * 100)
          return (
            <div
              key={id}
              ref={(element) => { if (element) nodes.current.set(id, element); else nodes.current.delete(id) }}
              role="group"
              aria-label={`${name}: ${text}`}
              className={cn("sync-node relative z-10 min-w-0 rounded-3xl border-2 bg-card p-4 shadow-[0_6px_20px_-8px_rgba(22,21,20,0.25)] motion-safe:hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-10px_rgba(22,21,20,0.3)]", NODE[phase])}
              style={{ gridColumn: 3, gridRow: index + 1, animationDelay: `${index * 80}ms` }}
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-bold text-gray-700">{initials(name)}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-gray-900" title={name}>{name}</span><span className="block truncate text-xs text-gray-500">{domain}</span></span>
                <StateIcon key={phase} phase={phase} />
              </div>
              <p className={cn("mt-3 text-xs", phase === "writing" ? "font-medium text-gray-900" : "text-gray-600")}>{text}</p>
              {stage && <StageList stage={stage} />}
              {finished && <Outcome target={target} />}
              {problems.length > 0 && (
                <ul className="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto text-xs text-red-700">
                  {problems.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}
                </ul>
              )}
              {phase !== "excluded" && phase !== "writing" && (
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-secondary">
                  <div className={cn("sync-fill h-full rounded-full", BAR[phase])} style={{ width: `${width}%` }} />
                </div>
              )}
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
                <p id={`retry-${id}`} className="mt-2 text-xs text-gray-500">{backupOf(target) === "none" ? "Retry applies without a backup, as this sync started." : "Retry backs up first."}</p>
              )}
              {mayHaveWritten(target) && !entry.storage && <p className="mt-2 text-xs text-amber-800">{NO_ROLLBACK}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The result view of a Sync run: its status line with the overall progress while targets write,
 * the flowchart, the summary chips once every target finished, the details (change set, results
 * and rollback) of one target, and for a run planned but never approved, the way back to its
 * review or to discard it.
 */
export function SyncResult({ source, policies = [], policyCount, entries, errors, notes, platforms, onRetry, retrying, tenantOf, onChanged, onContinue, onDiscard, discard }: {
  source: { name: string; domain: string }
  /** Names of the selected policies, in run order. */
  policies?: string[]
  policyCount: number
  entries: ResultTarget[]
  errors: Record<string, string>
  notes: Record<string, string>
  platforms: Record<string, string | null>
  onRetry: (target: SyncTarget) => void
  retrying: boolean
  tenantOf: (tenantId: string) => Tenant | undefined
  onChanged: () => void
  /** Reopens this run at Review; offered while a target is still in review and none was approved. */
  onContinue?: () => void
  /** Discards this run; offered while no target was approved or applied. */
  onDiscard?: () => void
  discard?: { busy: boolean; error: string | null }
}) {
  const [detailsOpen, setDetailsOpen] = useState<string | null>(null)
  // The approve button that led here is gone; keyboard and screen reader focus moves to the outcome.
  const statusLine = useRef<HTMLParagraphElement>(null)
  useEffect(() => statusLine.current?.focus(), [])
  const involved = entries.filter((entry) => entry.phase !== "excluded")
  const running = involved.some((entry) => entry.phase === "writing" || entry.phase === "waiting")
  const finishedCount = involved.filter((entry) => FINISHED.includes(entry.phase)).length
  const overall = involved.length ? Math.round((involved.reduce((sum, entry) => sum + share(entry), 0) / involved.length) * 100) : 0
  const verified = involved.filter((entry) => entry.phase === "verified" || entry.phase === "in-sync").length
  const attention = involved.length - verified
  // Targets something was written to; a rollback can run only where the tenant has backup storage.
  const wrote = involved.filter((entry) => mayHaveWritten(entry.target))
  const anyWritten = wrote.length > 0
  // Links come only from verified writes, so the links chip follows verified operations alone.
  const anyLinked = involved.some((entry) => progress(entry.target).done > 0)
  const rollbacks = wrote.filter((entry) => entry.storage).length
  // Targets already in sync wrote nothing, so they took no backup and decide nothing here. The
  // backup chip counts completed backups from the stored evidence, never the requested choice.
  const written = involved.filter((entry) => entry.target.changeSet)
  const attempted = written.filter((entry) => (entry.target.changeSet?.attempts ?? 0) > 0)
  const backups = attempted.filter((entry) => backedUp(entry.target)).length
  const skipped = attempted.some((entry) => backupOf(entry.target) === "none")
  const backupChip = skipped ? <Chip tone="warning">Backup skipped</Chip>
    : !backups ? null
    : backups === attempted.length ? <Chip>Backup taken in each tenant</Chip>
    : <Chip>Backup taken in {backups} of {attempted.length} tenants</Chip>
  const chips = [
    anyLinked && <Chip key="links" tone="success">Links saved for the next sync</Chip>,
    rollbacks > 0 && <Chip key="rollback">{rollbacks === wrote.length ? "Rollback available per tenant" : `Rollback available in ${rollbacks} of ${wrote.length} tenants`}</Chip>,
    backupChip && <span key="backup">{backupChip}</span>,
    <Chip key="audit">Recorded in the audit log</Chip>,
  ].filter(Boolean)
  const open = entries.find((entry) => entry.target.targetTenantId === detailsOpen)
  const openTenant = open ? tenantOf(open.target.targetTenantId) : undefined
  // Planned and never approved: a target still waits in review and every other target was left
  // out or already in sync, so the run is not a dead end.
  const unapproved = entries.some((entry) => awaitingReview(entry.target)) && involved.every((entry) => entry.phase === "in-sync")

  return (
    <div className="space-y-5">
      {unapproved ? (
        <div className="sync-node flex flex-wrap items-start gap-4 rounded-2xl bg-amber-50 p-5">
          <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-card text-amber-700"><Clock className="h-5 w-5" /></span>
          <div className="min-w-60 flex-1">
            <p ref={statusLine} tabIndex={-1} role="status" className="text-base font-semibold text-gray-900 outline-none">Planned, not approved yet</p>
            <p className="mt-1 text-sm text-gray-700">This sync was planned and reviewed, but no target was approved, so nothing was written. Continue to check every target against its live state again and approve, or discard the plan.</p>
            {discard?.error && <p role="alert" className="mt-2 text-sm text-red-700">{discard.error}</p>}
          </div>
          <div className="flex flex-wrap gap-2 self-center">
            {onDiscard && (
              <Button type="button" variant="ghost" disabled={discard?.busy} onClick={onDiscard}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {discard?.busy ? "Discarding" : "Discard"}
              </Button>
            )}
            {onContinue && (
              <Button type="button" disabled={discard?.busy} onClick={onContinue}>
                Continue to review
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          <p ref={statusLine} tabIndex={-1} role="status" className="flex flex-wrap items-center gap-2.5 text-base font-semibold outline-none">
            {running ? (
              <>
                <span aria-hidden="true" className="size-4 rounded-full border-2 border-border border-t-coral-500 motion-safe:animate-spin" />
                <span className="text-gray-900">Syncing to {plural(involved.length, "tenant", "tenants")}</span>
                <span className="text-sm font-normal tabular-nums text-gray-500">{finishedCount} of {involved.length} finished</span>
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
          {running && (
            <div role="progressbar" aria-label="Sync progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall} className="h-1 max-w-md overflow-hidden rounded-full bg-secondary">
              <div className="sync-fill h-full rounded-full bg-coral-500" style={{ width: `${Math.max(4, overall)}%` }} />
            </div>
          )}
          {!running && !involved.length && onDiscard && (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="ghost" size="sm" disabled={discard?.busy} onClick={onDiscard}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {discard?.busy ? "Discarding" : "Discard this plan"}
              </Button>
              {discard?.error && <p role="alert" className="text-sm text-red-700">{discard.error}</p>}
            </div>
          )}
        </div>
      )}
      <SyncFlowchart source={source} policies={policies} policyCount={policyCount} targets={entries} errors={errors} notes={notes} platforms={platforms} onRetry={onRetry} retrying={retrying} detailsOpen={detailsOpen} onDetails={setDetailsOpen} />
      {!running && written.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Summary">
          {chips.map((chip, index) => <span key={index} className="sync-chip" style={{ animationDelay: `${index * 70}ms` }}>{chip}</span>)}
        </div>
      )}
      {open?.target.changeSet && open.target.promotionId && openTenant && (
        <section aria-label={`Details for ${open.name}`} className="sync-node space-y-4 rounded-3xl bg-gray-50 p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-900">Details: {open.name}</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDetailsOpen(null)}>Close</Button>
          </div>
          <ChangeSetFlow
            key={open.target.changeSet.id}
            changeSet={open.target.changeSet}
            actions={syncTargetActions(openTenant, open.target.promotionId, backupOf(open.target) ?? "new")}
            tenantName={open.name}
            onChanged={onChanged}
            decisionFields={false}
            backupSkipped={backupOf(open.target) === "none"}
            intro={<>
              <p className="text-sm text-gray-600">Backup choice of this sync: {backupOf(open.target) === "none" ? "applied without a backup. Rollback uses the saved current versions." : "back up first, with this tenant's backup settings."}</p>
              {!open.storage && <p className="text-sm text-amber-800">{NO_ROLLBACK} A rollback always backs up first, so it cannot run from TenuVault until this tenant has backup storage.</p>}
            </>}
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
    const running = active.has(target.targetTenantId)
    return { target, name: tenant?.name ?? target.targetTenantId, domain: tenant?.domain ?? "", phase: targetPhase(target, running, errors[target.targetTenantId] ?? null), storage: !!tenant?.resources?.storageAccountName, active: running }
  })
}
