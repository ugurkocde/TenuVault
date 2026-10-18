import { Search } from "lucide-react"
import { cn } from "~/lib/utils"

/** Filter controls shared by list pages: a search pill, toggle chips with counts, and a select. */

export function SearchInput({ value, onChange, label, placeholder, className }: { value: string; onChange: (value: string) => void; label: string; placeholder: string; className?: string }) {
  return <div className={cn("relative w-full sm:w-80", className)}>
    <Search className="pointer-events-none absolute left-4 top-3 h-4 w-4 text-gray-400" aria-hidden="true" />
    <input type="search" aria-label={label} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="h-10 w-full rounded-full border border-gray-200 bg-white pl-10 pr-4 text-sm" />
  </div>
}

export interface FilterChip<T extends string> {
  value: T
  label: string
  count?: number
  /** Background class of a colored dot before the label, such as "bg-green-600". */
  dot?: string
}

export function FilterChips<T extends string>({ options, value, onChange, label }: { options: FilterChip<T>[]; value: T; onChange: (value: T) => void; label: string }) {
  return <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
    {options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)} className={cn("inline-flex h-10 items-center rounded-full border px-3.5 text-sm transition-colors", value === option.value ? "border-transparent bg-primary text-primary-foreground" : "border-gray-200 text-gray-600 hover:bg-gray-50")}>
      {option.dot && <span className={cn("mr-1.5 h-2 w-2 rounded-full", option.dot)} aria-hidden="true" />}
      {option.label}
      {option.count !== undefined && <span className="ml-1 tabular-nums font-semibold">{option.count}</span>}
    </button>)}
  </div>
}

export function FilterSelect<T extends string>({ options, value, onChange, label }: { options: Array<{ value: T; label: string }>; value: T; onChange: (value: T) => void; label: string }) {
  return <select aria-label={label} value={value} onChange={e => onChange(e.target.value as T)} className="h-10 w-full rounded-full border border-gray-200 bg-white px-3 text-sm sm:w-auto sm:max-w-xs">
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>
}
