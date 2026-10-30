import { Chip } from "~/components/dashboard/tiles"
import { formatDate } from "../scores/api"

/**
 * Where the evidence on a Governance screen came from and how old it is, in one line.
 * Every Governance tab reads a different snapshot (a saved comparison, a backup, a
 * stored assessment), so each names its source instead of reading as live truth.
 */
export function FreshnessStrip({ source, at, stale = false, staleLabel = "Stale" }: { source: string; at: string | null; stale?: boolean; staleLabel?: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
      <span>
        Source: {source}
        {at ? `, ${formatDate(at)}` : ", no evidence yet"}.
      </span>
      {stale && at && <Chip tone="warning">{staleLabel}</Chip>}
    </p>
  )
}
