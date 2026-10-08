"use client"

import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "~/lib/utils"
import type { DriftChange, SettingNames } from "../../../shared/intune/drift"
import { formatValue, LONG_VALUE, settingLabel } from "../../../shared/intune/drift-format"

/** One before or after value: plain text cut at LONG_VALUE with "Show more", objects as collapsible JSON. */
function ValueView({ value, definitionId, names, tone }: { value: unknown; definitionId?: string; names?: SettingNames; tone: "before" | "after" }) {
  const [open, setOpen] = useState(false)
  const formatted = formatValue(value, definitionId, names)
  const color = tone === "before" ? "bg-red-50 text-red-800" : "bg-green-50 text-green-800"
  if (formatted.kind === "empty") return <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs italic text-gray-500">{formatted.text}</span>
  if (formatted.kind === "json") {
    return (
      <div className="min-w-0 flex-1">
        <button type="button" onClick={(event) => { event.stopPropagation(); setOpen(!open) }} className={cn("inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-left text-xs", color)} aria-expanded={open}>
          <span className="truncate">{formatted.summary ?? (Array.isArray(value) ? `List of ${value.length}` : "Object")}</span>
          <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
        {open && <pre className="mt-1 max-h-80 overflow-auto rounded-xl bg-white p-3 font-mono text-[11px] leading-5 text-gray-700">{formatted.text}</pre>}
      </div>
    )
  }
  const long = formatted.text.length > LONG_VALUE
  return (
    <span className={cn("min-w-0 break-words rounded-md px-2 py-0.5 font-mono text-xs", color)} title={formatted.raw}>
      {long && !open ? `${formatted.text.slice(0, LONG_VALUE)}...` : formatted.text}
      {long && (
        <button type="button" onClick={(event) => { event.stopPropagation(); setOpen(!open) }} className="ml-2 font-sans font-medium underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </span>
  )
}

/** Every changed setting of a modified item, with a readable name and its value before and after. */
export function ChangeList({ changes, names }: { changes: DriftChange[]; names?: SettingNames }) {
  return (
    <div className="space-y-3">
      {changes.map((change, index) => {
        const { label, path, definitionId } = settingLabel(change, names)
        return (
          <div key={`${change.field}-${index}`} className="border-l-2 border-gray-300 pl-3">
            <p className="text-sm font-medium text-gray-800">{label}</p>
            <p className="mb-1.5 break-all font-mono text-[11px] text-gray-400">{path}</p>
            <div className="space-y-1">
              <div className="flex items-start gap-2">
                <span className="w-12 shrink-0 pt-0.5 text-xs text-gray-500">Before</span>
                <ValueView value={change.oldValue} definitionId={definitionId} names={names} tone="before" />
              </div>
              <div className="flex items-start gap-2">
                <span className="w-12 shrink-0 pt-0.5 text-xs text-gray-500">After</span>
                <ValueView value={change.newValue} definitionId={definitionId} names={names} tone="after" />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
