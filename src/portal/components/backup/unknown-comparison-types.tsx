import { LEGACY_COMPARISON_NOTICE } from "../../../shared/intune/backup-read-coverage"
import { typeForFolder } from "../../../shared/intune/registry"

export function UnknownComparisonTypes({ folders, legacyReadFailure }: { folders?: string[]; legacyReadFailure?: boolean }) {
  return <>
    {legacyReadFailure && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">{LEGACY_COMPARISON_NOTICE}</p>}
    {!!folders?.length && <details className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <summary className="cursor-pointer font-medium">{folders.length} {folders.length === 1 ? "type" : "types"} not compared</summary>
      <p className="mt-1">These types were outside the scope or could not be confirmed as read in both backups.</p>
      <ul className="mt-2 list-disc pl-5 text-xs">{folders.map(folder => <li key={folder}>{typeForFolder(folder)?.label ?? folder}</li>)}</ul>
    </details>}
  </>
}
