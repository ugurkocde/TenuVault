"use client"

import { useEffect, useId, useRef, useState } from "react"
import { AlertTriangle, CircleStop, Check, ChevronDown, ChevronRight, Copy, FileText, LoaderCircle, MinusCircle, XCircle } from "lucide-react"
import { cn } from "~/lib/utils"
import { formatBackupDuration, summarizeBackupResults, typeHeading, type BackupJobDisplay } from "~/lib/backup-job-display"
import { MAX_ITEM_ERRORS, type BackupTypeResult } from "../../../shared/backup-results"

interface BackupResultsProps {
  job: Pick<BackupJobDisplay, "status" | "startTime" | "endTime" | "output" | "results" | "isComplete">
  /** The floating panel's narrow layout: totals, problems and the first few types only. */
  compact?: boolean
  /** Shown under the raw log, for support. */
  jobId?: string | null
}

const COMPACT_ROWS = 5

/**
 * What a backup saved, per type, with problems first and the raw log folded away. Without per type
 * results (a job that has not started or failed before listing anything) only the raw log is offered.
 */
export function BackupResults({ job, compact = false, jobId }: BackupResultsProps) {
  const results = job.results
  if (!results) return job.output ? <RawLog output={job.output} jobId={jobId} live={!job.isComplete} compact={compact} /> : null

  const summary = summarizeBackupResults(results, job.isComplete)
  const duration = formatBackupDuration(job.startTime, job.endTime)
  const rows = compact ? summary.rows.slice(0, COMPACT_ROWS) : summary.rows
  const hidden = summary.rows.length - rows.length
  const problems = summary.unreadable.length + summary.skipped.length + summary.partial.length + summary.warnings.length + summary.notReached.length
  // Red only for a failed run; a run that completed with warnings or that the user cancelled stays amber.
  const severe = job.isComplete && job.status === "Failed"
  const extras = summary.inventory.map((entry) => `${entry.count} ${entry.label}`)

  return (
    <div className="space-y-3">
      {compact ? (
        <p className="text-xs text-foreground">
          <span className="font-semibold tabular-nums">{summary.policies}</span> {summary.policies === 1 ? "policy" : "policies"} {job.isComplete ? "saved" : "saved so far"}
          <span className="text-muted-foreground"> across {summary.typesBackedUp} type{summary.typesBackedUp === 1 ? "" : "s"}{duration ? `, ${duration}` : ""}</span>
        </p>
      ) : (
        <dl className="grid grid-cols-3 gap-2">
          <Stat label={job.isComplete ? "Policies saved" : "Saved so far"} value={String(summary.policies)} />
          <Stat label="Types backed up" value={String(summary.typesBackedUp)} />
          <Stat label={job.isComplete ? "Duration" : "Elapsed"} value={duration || "-"} />
        </dl>
      )}
      {extras.length > 0 && <p className="text-xs text-muted-foreground">Also saved: {extras.join(", ")}.</p>}

      {problems > 0 && (
        <div className={cn("rounded-2xl px-3.5 py-3", severe ? "bg-red-50" : "bg-amber-50")}>
          <p className={cn("flex items-center gap-2 text-sm font-medium", severe ? "text-red-700" : "text-amber-800")}>
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            Needs attention
          </p>
          <ul className="mt-2 space-y-1.5 text-xs text-foreground">
            {summary.unreadable.map((type) => (
              <Problem key={type.folder} title={`Could not read ${type.label}`} detail={type.reason} compact={compact} />
            ))}
            {summary.notReached.length > 0 && (
              <Problem
                title={`${summary.notReached.length} type${summary.notReached.length === 1 ? " was" : "s were"} not read before the backup stopped`}
                detail={summary.notReached.map((type) => typeHeading(type.label)).join(", ")}
                compact={compact}
              />
            )}
            {summary.partial.map((type) => (
              <Problem
                key={type.folder}
                title={type.state === "reading"
                  ? `${type.failed} ${type.label} could not be saved before the backup stopped`
                  : `${type.failed} of ${type.found ?? type.saved + type.failed} ${type.label} could not be saved`}
                items={type.errors}
                more={type.failed - (type.errors?.length ?? 0)}
                compact={compact}
              />
            ))}
            {summary.skipped.map((type) => (
              <Problem key={type.folder} title={`${typeHeading(type.label)} left out`} detail={type.reason} compact={compact} />
            ))}
            {summary.warnings.map((message, index) => (
              <Problem key={index} title={message} />
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <ul aria-label="Backed up types" className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {rows.map((type) => <TypeRow key={type.folder} type={type} finished={job.isComplete} />)}
        </ul>
      )}
      {hidden > 0 && <p className="text-xs text-muted-foreground">and {hidden} more type{hidden === 1 ? "" : "s"}</p>}
      {!job.isComplete && summary.pending > 0 && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Reading {summary.pending} more type{summary.pending === 1 ? "" : "s"}...
        </p>
      )}

      {!compact && job.isComplete && summary.empty.length > 0 && (
        <Disclosure label={`${summary.empty.length} type${summary.empty.length === 1 ? "" : "s"} had nothing to back up`}>
          <p className="text-xs text-muted-foreground">{summary.empty.map((type) => typeHeading(type.label)).join(", ")}.</p>
        </Disclosure>
      )}

      {!compact && summary.info.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {summary.info.map((message, index) => <li key={index}>{message}</li>)}
        </ul>
      )}

      {job.output && <RawLog output={job.output} jobId={jobId} live={!job.isComplete} compact={compact} />}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-muted px-3 py-2">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums tracking-tight text-foreground">{value}</dd>
    </div>
  )
}

/** A type the job is backing up, or, once it has ended, stopped part way through. */
function TypeRow({ type, finished }: { type: BackupTypeResult; finished: boolean }) {
  const unfinished = type.state === "reading"
  const active = unfinished && !finished
  const stopped = unfinished && finished
  const state = active ? "in progress" : stopped ? "stopped before it finished" : type.saved === 0 ? `none saved, ${type.failed} failed` : type.failed > 0 ? "saved with failures" : "saved"
  return (
    <li className="flex items-center gap-2.5 bg-card px-3 py-2 text-sm">
      {active ? (
        <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-coral-500" aria-hidden="true" />
      ) : stopped ? (
        <CircleStop className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : type.saved === 0 ? (
        <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
      ) : type.failed > 0 ? (
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
      ) : (
        <Check className="h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate text-foreground" title={typeHeading(type.label)}>{typeHeading(type.label)}</span>
      {stopped && <span className="shrink-0 text-xs text-muted-foreground">Stopped</span>}
      {type.failed > 0 && <span className="shrink-0 text-xs text-amber-800">{type.failed} failed</span>}
      <span className="shrink-0 tabular-nums font-medium text-foreground">
        {unfinished ? <span className="text-muted-foreground">{type.saved} of {type.found}</span> : type.saved}
      </span>
      <span className="sr-only">{state}</span>
    </li>
  )
}

function Problem({ title, detail, items, more = 0, compact = false }: { title: string; detail?: string; items?: string[]; more?: number; compact?: boolean }) {
  return (
    <li>
      <p className="font-medium">{title}</p>
      {detail && !compact && <p className="text-muted-foreground">{detail}</p>}
      {items && items.length > 0 && !compact && (
        <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
          {items.slice(0, MAX_ITEM_ERRORS).map((item, index) => <li key={index} className="break-words">{item}</li>)}
          {more > 0 && <li>and {more} more, listed in the raw log</li>}
        </ul>
      )}
    </li>
  )
}

function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        <MinusCircle className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </button>
      {open && <div id={id} className="pl-5">{children}</div>}
    </div>
  )
}

function RawLog({ output, jobId, live, compact }: { output: string; jobId?: string | null; live: boolean; compact: boolean }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const id = useId()
  const log = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  // While the backup runs, an open log follows the newest line.
  useEffect(() => {
    if (open && live) log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [open, live, output])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          {open ? "Hide raw log" : "Show raw log"}
        </button>
        {open && (
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? "Copied" : "Copy log"}
          </button>
        )}
        <span className="sr-only" aria-live="polite">{copied ? "Log copied" : ""}</span>
      </div>
      {open && (
        <div id={id} className="space-y-1">
          <pre ref={log} className={cn("overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground", compact ? "max-h-40" : "max-h-60")}>
            {output}
          </pre>
          {jobId && <p className="text-[11px] text-muted-foreground">Job ID <span className="font-mono">{jobId}</span></p>}
        </div>
      )}
    </div>
  )
}
