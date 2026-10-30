import { Chip, Fact } from "~/components/dashboard/tiles"
import { formatDate, GROUP_READ_OPT_IN_HINT, type Scan } from "./api"

const REASONS: Record<string, string> = { excluded: "left out of the backup scope", skipped: "skipped, missing permission", failed: "could not be read", unreadable: "backup files unreadable" }

/** The latest scan: source backup, collection date, coverage and the checks that could not be made. */
export function ScanSummary({ scan, ruleName }: { scan: Scan; ruleName: (id: string) => string }) {
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Collected">{formatDate(scan.collectedAt)}</Fact>
        <Fact label="Source backup">{scan.backupId}</Fact>
        <Fact label="Objects inspected">{scan.itemCount}</Fact>
        <Fact label="Findings">{scan.counts.definite} definite, {scan.counts.possible} possible</Fact>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={scan.completeness === "complete" ? "success" : "warning"}>{scan.completeness === "complete" ? "Complete collection" : "Partial collection"}</Chip>
        <Chip tone={scan.notCollected.length ? "warning" : "neutral"}>{scan.covered.length} types collected, {scan.notCollected.length} not collected</Chip>
        <Chip tone={scan.groupResolution.state === "resolved" || scan.groupResolution.state === "none" ? "neutral" : "warning"}>Groups: {scan.groupResolution.state === "resolved" ? "checked" : scan.groupResolution.state === "none" ? "none referenced" : "unknown"}</Chip>
        {scan.catalog && <Chip tone={scan.catalog.state === "checked" ? "neutral" : "warning"}>Settings Catalog: {scan.catalog.state === "checked" ? `checked ${formatDate(scan.catalog.checkedAt)}, ${scan.catalog.total} definitions` : "not checked"}</Chip>}
      </div>
      {scan.partialReason && <p className="text-sm text-amber-800 dark:text-amber-300">{scan.partialReason}</p>}
      {scan.notCollected.length > 0 && (
        <details className="text-sm text-gray-600">
          <summary className="cursor-pointer rounded-full text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Not collected (not clean, just not inspected)</summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {scan.notCollected.map((entry) => <li key={entry.folder}>{entry.label}: {REASONS[entry.reason] ?? entry.reason}</li>)}
          </ul>
        </details>
      )}
      {scan.unknowns.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-medium text-gray-800">Checks that could not be made</p>
          <ul className="space-y-1 text-gray-600">
            {scan.unknowns.map((unknown) => <li key={unknown.ruleId}>{ruleName(unknown.ruleId)}: {unknown.reason} ({unknown.count} objects, shown as unknown){unknown.ruleId === "missing-group" && !unknown.reason.includes("Group.Read.All") && <span className="block">{GROUP_READ_OPT_IN_HINT}</span>}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
