import type { DiffEntry } from "./change-set"
import type { SettingNames } from "../../../shared/intune/drift"
import { INLINE_SETTING_VALUES, omittedSettingValues, readableDiffEntry, type ReadableSettingValues } from "../../../shared/frameworks/cis-display"

/**
 * The setting values of one side of a difference: the first ones inline, every recorded one
 * behind an expand, and a plain statement when the side holds more than was recorded, so a
 * partial list never reads as the whole change.
 */
function SettingValues({ values, side }: { values: ReadableSettingValues; side: "before" | "after" }) {
  const inline = values.shown.slice(0, INLINE_SETTING_VALUES)
  const missing = values.total - values.shown.length
  return <span className="block text-gray-700 dark:text-gray-300">
    {side === "before" && <span className="text-gray-500">Before: </span>}{inline.join("; ")}
    {values.total > inline.length && <span className="block text-gray-600">Showing {inline.length} of {values.total} settings.</span>}
    {values.shown.length > inline.length && <details className="mt-1"><summary className="cursor-pointer font-medium text-gray-700">Show all {values.shown.length} listed settings</summary><ul className="mt-1 space-y-0.5">{values.shown.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
    {missing > 0 && <span className="block font-medium text-amber-800 dark:text-amber-300">{missing} more {missing === 1 ? "setting is" : "settings are"} not listed here. Inspect the policy content before you approve.</span>}
  </span>
}

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
              {"beforeValues" in shown && shown.beforeValues && <SettingValues values={shown.beforeValues} side="before" />}
              {"afterValues" in shown && shown.afterValues && <SettingValues values={shown.afterValues} side="after" />}
              {shown.before !== undefined && <span className="text-gray-500">: {shown.before}</span>}
              {shown.after !== undefined && <span className="text-gray-700 dark:text-gray-300">{shown.before !== undefined ? " to " : ": "}{shown.after}</span>}
              {names && <span className="block font-mono text-[11px] text-gray-400">{entry.path}</span>}
            </li>
          )
        })}
      </ul>
      {truncated && <p className="text-xs text-gray-500">More differences exist than are listed here.</p>}
      {names && omittedSettingValues(entries) > 0 && <p className="text-xs font-medium text-amber-800 dark:text-amber-300">{omittedSettingValues(entries)} setting values of this operation are not listed here.</p>}
    </div>
  )
}
