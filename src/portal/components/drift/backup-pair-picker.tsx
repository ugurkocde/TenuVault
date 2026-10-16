"use client"

import { ArrowLeftRight, GitCompare, Loader2 } from "lucide-react"
import { Link } from "react-router-dom"
import { Button } from "~/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select"
import { formatDate, TRIGGER_LABEL, type BackupSummary } from "~/components/backup/types"
import { backupCompleteness } from "../../../shared/intune/drift"

/** "Oct 6, 2026, 02:00, Scheduled", the trigger left out when it was not recorded, and marked when it completed with warnings. */
export function optionLabel(backup: BackupSummary): string {
  const trigger = backup.type && backup.type in TRIGGER_LABEL ? `, ${TRIGGER_LABEL[backup.type]}` : ""
  const warnings = backupCompleteness(backup.status) === "warnings" ? ", completed with warnings" : ""
  return `${formatDate(backup.timestamp)}${trigger}${warnings}`
}

/** Backups drift can compare: complete ones and ones that completed with warnings, newest first as listed. */
export function comparableBackups(backups: BackupSummary[]): BackupSummary[] {
  return backups.filter((backup) => backupCompleteness(backup.status) !== "incomplete")
}

type Pair = { baseline: string | null; comparison: string | null }

/**
 * The pair after choosing a backup on one side. Choosing the backup already on the other side swaps
 * them, and the older of the two is kept as the baseline, so a choice never leaves the pair reversed.
 */
export function choose(pair: Pair, side: "baseline" | "comparison", id: string, backups: BackupSummary[]): Pair {
  const other = side === "baseline" ? "comparison" : "baseline"
  const next = (pair[other] === id ? { [side]: id, [other]: pair[side] } : { ...pair, [side]: id }) as Pair
  const time = (backupId: string | null) => Date.parse(backups.find((backup) => backup.id === backupId)?.timestamp ?? "")
  return time(next.baseline) > time(next.comparison) ? { baseline: next.comparison, comparison: next.baseline } : next
}

/** Why the chosen pair cannot be compared, or null. */
export function pairProblem(backups: BackupSummary[], baseline: string | null, comparison: string | null): string | null {
  if (!baseline || !comparison) return "Choose a baseline and a comparison backup."
  if (baseline === comparison) return "Choose two different backups."
  const older = backups.find((backup) => backup.id === baseline)
  const newer = backups.find((backup) => backup.id === comparison)
  if (!older || !newer) return "Choose backups from the list."
  if (Date.parse(older.timestamp) >= Date.parse(newer.timestamp)) return "The baseline must be older than the comparison. Swap them to compare."
  return null
}

/**
 * Picks the two backups to compare: the baseline (older) and the comparison (newer). Only backups that
 * can be compared are offered; the ones that did not finish or could not be read are counted below the
 * picker instead of being listed as unavailable. Ones that completed with warnings are offered and
 * marked, since items they missed may show as deleted.
 */
export function BackupPairPicker({
  backups,
  loading,
  loaded,
  baseline,
  comparison,
  onChange,
  onCompare,
  onBackUp,
  busy,
  latest,
}: {
  backups: BackupSummary[]
  loading: boolean
  /** Whether a backup list has arrived; before that, or when reading it failed, there is nothing to count. */
  loaded: boolean
  baseline: string | null
  comparison: string | null
  onChange: (pair: { baseline: string | null; comparison: string | null }) => void
  onCompare: () => void
  /** Starts a backup of the tenant, offered when there are too few backups to choose between. */
  onBackUp?: () => void
  busy: boolean
  /** The two newest complete backups, offered when another pair is chosen. */
  latest: { baseline: string; comparison: string } | null
}) {
  const offered = comparableBackups(backups)
  const hidden = backups.length - offered.length
  const problem = pairProblem(offered, baseline, comparison)
  const warned = [baseline, comparison].some((id) => backupCompleteness(offered.find((backup) => backup.id === id)?.status) === "warnings")
  const select = (side: "baseline" | "comparison", label: string) => {
    // A chosen backup that is no longer offered (for example from an earlier result) shows the placeholder.
    const chosen = side === "baseline" ? baseline : comparison
    return (
      <Select value={offered.some((backup) => backup.id === chosen) ? chosen! : ""} onValueChange={(id) => onChange(choose({ baseline, comparison }, side, id, offered))} disabled={loading || busy}>
        <SelectTrigger aria-label={label} className="h-11 w-full min-w-0 sm:w-[300px]">
          <SelectValue placeholder={loading ? "Loading backups..." : "Choose a backup"} />
        </SelectTrigger>
        <SelectContent>
          {offered.map((backup) => (
            <SelectItem key={backup.id} value={backup.id}>
              {optionLabel(backup)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  return (
    <div className="rounded-3xl bg-white p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm text-gray-500">Baseline (older)</span>
          {select("baseline", "Baseline backup")}
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="self-start rounded-full xl:self-auto"
          aria-label="Swap baseline and comparison"
          title="Swap baseline and comparison"
          disabled={busy || !baseline || !comparison}
          onClick={() => onChange({ baseline: comparison, comparison: baseline })}
        >
          <ArrowLeftRight className="h-4 w-4" />
        </Button>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm text-gray-500">Comparison (newer)</span>
          {select("comparison", "Comparison backup")}
        </label>
        <Button size="lg" className="bg-coral-600 text-white hover:bg-coral-700 xl:ml-auto" onClick={onCompare} disabled={busy || loading || problem !== null}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <GitCompare className="mr-2 h-4 w-4" />}
          Compare
        </Button>
      </div>
      {latest && (latest.baseline !== baseline || latest.comparison !== comparison) && (
        <button type="button" className="mt-3 text-xs font-medium text-blue-700 hover:underline disabled:opacity-50" disabled={busy || loading} onClick={() => onChange(latest)}>
          Use the latest two backups
        </button>
      )}
      {!loading && offered.length > 0 && problem && <p className="mt-3 text-xs text-gray-500">{problem}</p>}
      {warned && <p className="mt-3 text-xs text-amber-700">A chosen backup completed with warnings. Items it could not read may show up as deleted or added.</p>}
      {loaded && !loading && offered.length < 3 && (
        <p className="mt-3 text-xs text-gray-500">
          {fewNote(offered.length)}
          {onBackUp && (
            <>
              {" "}
              <button type="button" className="font-medium text-blue-700 hover:underline disabled:opacity-50" disabled={busy} onClick={onBackUp}>
                Back up now
              </button>
            </>
          )}
        </p>
      )}
      {loaded && !loading && hidden > 0 && (
        <p className="mt-3 text-xs text-gray-500">
          {hiddenNote(hidden)}{" "}
          <Link to="/portal/backup" className="font-medium text-blue-700 hover:underline">
            See them in Backup & Restore
          </Link>
        </p>
      )}
    </div>
  )
}

/** What to do when there are too few backups to choose a different pair. */
export function fewNote(count: number): string {
  if (count === 2) return "These are the only two backups that can be compared. A new backup can be compared with either of them."
  return `${count === 1 ? "Only one backup" : "No backup"} can be compared yet. Drift detection needs two complete backups.`
}

/** Why some backups are missing from the lists. */
export function hiddenNote(count: number): string {
  return count === 1
    ? "1 backup is not listed because it did not finish or its details could not be read."
    : `${count} backups are not listed because they did not finish or their details could not be read.`
}
