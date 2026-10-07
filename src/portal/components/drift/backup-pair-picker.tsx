"use client"

import { ArrowLeftRight, GitCompare, Loader2 } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select"
import { formatDate, TRIGGER_LABEL, type BackupSummary } from "~/components/backup/types"
import { backupCompleteness } from "../../../shared/intune/drift"

/** "Oct 6, 2026, 02:00, Scheduled" with the status when it is not a clean success. */
function optionLabel(backup: BackupSummary): string {
  const trigger = backup.type && backup.type in TRIGGER_LABEL ? TRIGGER_LABEL[backup.type] : "Trigger not recorded"
  const completeness = backupCompleteness(backup.status)
  const status = completeness === "complete" ? "" : completeness === "warnings" ? ", completed with warnings" : backup.status === "running" ? ", running" : ", incomplete"
  return `${formatDate(backup.timestamp)}, ${trigger}${status}`
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
 * Picks the two backups to compare: the baseline (older) and the comparison (newer). Backups that
 * did not complete cannot be chosen; ones that completed with warnings can, and are marked, since
 * items they missed may show as deleted.
 */
export function BackupPairPicker({
  backups,
  loading,
  baseline,
  comparison,
  onChange,
  onCompare,
  busy,
}: {
  backups: BackupSummary[]
  loading: boolean
  baseline: string | null
  comparison: string | null
  onChange: (pair: { baseline: string | null; comparison: string | null }) => void
  onCompare: () => void
  busy: boolean
}) {
  const problem = pairProblem(backups, baseline, comparison)
  const warned = [baseline, comparison].some((id) => backupCompleteness(backups.find((backup) => backup.id === id)?.status) === "warnings")
  const select = (value: string | null, label: string, onValue: (id: string) => void, other: string | null) => (
    <Select value={value ?? undefined} onValueChange={onValue} disabled={loading || busy}>
      <SelectTrigger aria-label={label} className="h-11 w-full min-w-0 sm:w-[300px]">
        <SelectValue placeholder={loading ? "Loading backups..." : "Choose a backup"} />
      </SelectTrigger>
      <SelectContent>
        {backups.map((backup) => (
          <SelectItem key={backup.id} value={backup.id} disabled={backupCompleteness(backup.status) === "incomplete" || backup.id === other}>
            {optionLabel(backup)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
  return (
    <div className="rounded-3xl bg-white p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm text-gray-500">Baseline (older)</span>
          {select(baseline, "Baseline backup", (id) => onChange({ baseline: id, comparison }), comparison)}
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
          {select(comparison, "Comparison backup", (id) => onChange({ baseline, comparison: id }), baseline)}
        </label>
        <Button size="lg" className="bg-coral-600 text-white hover:bg-coral-700 xl:ml-auto" onClick={onCompare} disabled={busy || loading || problem !== null}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <GitCompare className="mr-2 h-4 w-4" />}
          Compare
        </Button>
      </div>
      {!loading && backups.length > 0 && problem && <p className="mt-3 text-xs text-gray-500">{problem}</p>}
      {warned && <p className="mt-3 text-xs text-amber-700">A chosen backup completed with warnings. Items it could not read may show up as deleted or added.</p>}
    </div>
  )
}
