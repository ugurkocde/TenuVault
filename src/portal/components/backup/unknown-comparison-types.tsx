import { typeForFolder } from "../../../shared/intune/registry"

export function UnknownComparisonTypes({ folders }: { folders?: string[] }) {
  if (!folders?.length) return null
  return <details className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
    <summary className="cursor-pointer font-medium">Unknown coverage for {folders.length} {folders.length === 1 ? "type" : "types"}</summary>
    <p className="mt-1">Only types read in full by both backups are compared.</p>
    <ul className="mt-2 list-disc pl-5 text-xs">{folders.map(folder => <li key={folder}>{typeForFolder(folder)?.label ?? folder}</li>)}</ul>
  </details>
}
