import { type ReactNode } from "react"
import { typeForFolder } from "../../shared/intune/registry"
import { COVERAGE_ISSUE_TEXT, coverageIssue } from "../../shared/services/backup-coverage"
import { BACKUP_SERVICES } from "../../shared/services/presentation"
import type { BackupScopeCoverage } from "../../shared/tenant-connection"

export function BackupCoverage({ coverage, emptyLabel, action }: {
  coverage: readonly BackupScopeCoverage[]
  emptyLabel?: string
  action?: (row: BackupScopeCoverage) => ReactNode
}) {
  if (!coverage.length) return null
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(min(8rem,100%),1fr))] gap-2" aria-label="Backup coverage">
    {BACKUP_SERVICES.map(({ id, label }) => {
      const row = coverage.find(entry => entry.service === id)
      if (!row || (!row.folders.length && !emptyLabel)) return null
      const issues = row.folders.flatMap(folder => {
        const cause = coverageIssue(row, folder)
        return cause ? [{ folder, cause }] : []
      })
      const unknown = issues.filter(issue => issue.cause === "unknown").length
      const allUnknown = unknown > 0 && unknown === row.folders.length
      const count = !row.folders.length ? emptyLabel : allUnknown ? "Unknown" : `${row.readable?.length ?? 0} of ${row.folders.length}`
      return <section key={id} aria-label={`${label} backup coverage`} className="min-w-0 space-y-1 rounded-xl border border-border px-3 py-2">
        <h4 className="text-xs font-medium text-gray-700">{label}</h4>
        <p className="text-base font-medium text-gray-900">{count}</p>
        {unknown > 0 && !allUnknown && <p className="text-xs text-gray-600">{unknown} unknown</p>}
        {issues.length > 0 && <details className="text-xs text-gray-600">
          <summary className="cursor-pointer">{issues.every(issue => issue.cause === "permission") ? `Backup types missing permissions (${issues.length})` : "Coverage details"}</summary>
          <ul className="mt-2 space-y-2">{issues.map(({ folder, cause }) => <li key={folder}>
            <span className="block break-words font-medium text-gray-700">{typeForFolder(folder)?.label ?? folder}</span>
            {COVERAGE_ISSUE_TEXT[cause]}
          </li>)}</ul>
        </details>}
        {action?.(row)}
      </section>
    })}
  </div>
}
