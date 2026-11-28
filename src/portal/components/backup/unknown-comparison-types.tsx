import { LEGACY_COMPARISON_NOTICE } from "../../../shared/intune/backup-read-coverage"
import type { DriftWarning } from "../../../shared/intune/drift"
import { BackupTypeDetails } from "@desktop/components/BackupCoverage"
import { NoticeCard } from "@desktop/components/NoticeCard"

export const NO_CHANGES_IN_COMPARED_TYPES = "No changes found in the types compared."

export function typesNotCompared(count: number): string {
  return `${count} ${count === 1 ? "type" : "types"} not compared`
}

export function UnknownComparisonTypes({ folders = [], legacyReadFailure, warnings = [] }: {
  folders?: string[]
  legacyReadFailure?: boolean
  warnings?: readonly DriftWarning[]
}) {
  const unique = [...new Set(folders)]
  const files = [...new Map(warnings.map(warning => [`${warning.backup}/${warning.file}`, warning])).values()]
  if (!unique.length && !legacyReadFailure && !files.length) return null
  const summary = [
    unique.length && `${typesNotCompared(unique.length)}.`,
    files.length && `${files.length} ${files.length === 1 ? "file" : "files"} could not be read.`,
  ].filter(Boolean).join(" ") || "Some older backup files could not be compared."
  return <NoticeCard summary={summary} tone={files.length ? "error" : "neutral"} details={<>
    {legacyReadFailure && <p>{LEGACY_COMPARISON_NOTICE}</p>}
    {unique.length > 0 && <p>These types were outside the scope or could not be confirmed as read in both backups.</p>}
    <BackupTypeDetails entries={unique.map(folder => ({ folder, detail: null }))} />
    {files.length > 0 && <ul className="space-y-1">{files.map(warning => <li key={`${warning.backup}/${warning.file}`}>
      <span className="font-mono">{warning.backup}/{warning.file}</span>: {warning.message}
    </li>)}</ul>}
  </>} />
}
