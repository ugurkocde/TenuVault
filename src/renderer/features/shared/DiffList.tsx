import type { DiffEntry } from "./change-set"
import type { SettingNames } from "../../../shared/intune/drift"
import { readableDiffEntry } from "../../../shared/frameworks/cis-display"

/**
 * A bounded list of configuration differences; values are shortened, never secrets. With
 * `names`, Settings Catalog differences read by setting and option name, with the raw path below.
 */
export function DiffList({ entries, truncated, names }: { entries: DiffEntry[]; truncated?: boolean; names?: SettingNames }) {
  if (!entries.length) return <p className="text-sm text-gray-500">No configuration differences.</p>
  return (
    <div className="space-y-1">
      <ul className={`max-h-72 space-y-1 overflow-y-auto rounded-2xl bg-gray-50 p-3 text-xs dark:bg-gray-900 ${names ? "" : "font-mono"}`}>
        {entries.map((entry, index) => {
          const shown = names ? readableDiffEntry(entry, names) : { label: entry.path, before: entry.before, after: entry.after }
          return (
            <li key={index} className="break-all">
              <span className={entry.change === "added" ? "text-green-700 dark:text-green-400" : entry.change === "removed" ? "text-red-700 dark:text-red-400" : "text-amber-800 dark:text-amber-300"}>
                {entry.change === "added" ? "added" : entry.change === "removed" ? "removed" : "changed"}
              </span>{" "}
              <span className="text-gray-800 dark:text-gray-200">{shown.label}</span>
              {shown.before !== undefined && <span className="text-gray-500">: {shown.before}</span>}
              {shown.after !== undefined && <span className="text-gray-700 dark:text-gray-300">{shown.before !== undefined ? " to " : ": "}{shown.after}</span>}
              {names && <span className="block font-mono text-[11px] text-gray-400">{entry.path}</span>}
            </li>
          )
        })}
      </ul>
      {truncated && <p className="text-xs text-gray-500">More differences exist than are listed here.</p>}
    </div>
  )
}
