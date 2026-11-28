import type { ReactElement, ReactNode } from "react"
import { typeForFolder } from "../../shared/intune/registry"
import { COVERAGE_ISSUE_TEXT, coverageIssue } from "../../shared/services/backup-coverage"
import { BACKUP_SERVICES, backupServiceForFolder } from "../../shared/services/presentation"
import type { BackupScopeCoverage } from "../../shared/tenant-connection"
import { NoticeCard } from "./NoticeCard"

export type BackupTypeDetail = {
  folder: string
  label?: string
  detail: ReactNode
}

export function BackupTypeDetails({ entries }: { entries: readonly BackupTypeDetail[] }) {
  const unique = [...new Map(entries.map(entry => [entry.folder, entry])).values()]
  return [...BACKUP_SERVICES, { id: undefined, label: "Other types" }].map(({ id, label }) => {
    const group = unique.filter(entry => backupServiceForFolder(entry.folder) === id)
    if (!group.length) return null
    return <section key={label} className="space-y-1" aria-label={label}>
      <p className="font-medium">{label} ({group.length})</p>
      <ul className="space-y-1">{group.map(entry => <li key={entry.folder}>
        <p className="font-medium first-letter:uppercase">{entry.label ?? typeForFolder(entry.folder)?.label ?? entry.folder}</p>
        {entry.detail && <div className="text-muted-foreground">{entry.detail}</div>}
      </li>)}</ul>
    </section>
  })
}

export function BackupCoverage({ coverage, emptyLabel, countsOnly, action }: {
  coverage: readonly BackupScopeCoverage[]
  emptyLabel?: string
  countsOnly?: boolean
  action?: ReactElement | false | null
}) {
  const rows = BACKUP_SERVICES.flatMap(({ id }) => coverage.filter(row => row.service === id && (row.folders.length || emptyLabel)))
  if (!rows.length) return null
  const issues = rows.flatMap(row => [...new Set(row.folders)].flatMap(folder => {
    const cause = coverageIssue(row, folder)
    return cause ? [{ folder, cause, detail: cause === "role" ? `${COVERAGE_ISSUE_TEXT.role}. Ask your administrator to review your role.`
      : cause === "license" ? `${COVERAGE_ISSUE_TEXT.license}. Check the service license and setup in Microsoft 365.`
      : COVERAGE_ISSUE_TEXT[cause] }] : []
  }))
  const access = issues.filter(issue => issue.cause !== "unknown").length
  const unknown = issues.length - access
  const counts = <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs" aria-label="Backup coverage">
    {rows.map(row => <div className="flex gap-2" key={row.service} aria-label={`${BACKUP_SERVICES.find(service => service.id === row.service)?.label} backup coverage`}>
      <dt className="font-medium">{BACKUP_SERVICES.find(service => service.id === row.service)?.label}</dt>
      <dd className="text-muted-foreground">{!row.folders.length ? emptyLabel : row.readable === null ? "Unknown" : `${new Set(row.readable).size} of ${new Set(row.folders).size} readable`}</dd>
    </div>)}
  </dl>
  if (!issues.length || countsOnly) return counts
  return <NoticeCard summary={[access ? `Needs access for ${access} backup ${access === 1 ? "type" : "types"}.` : "", unknown ? `Coverage unknown for ${unknown}.` : ""].filter(Boolean).join(" ")}
    action={action} details={<>{counts}<BackupTypeDetails entries={issues} /></>} />
}
