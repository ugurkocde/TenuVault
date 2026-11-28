import { useState } from "react"
import { ChevronDown, ChevronRight, Info } from "lucide-react"
import { Checkbox } from "~/components/ui/checkbox"
import { cn } from "~/lib/utils"
import { DEFAULT_SELECTION, type ServiceSelection } from "../../shared/services/modules"
import { includedTypes, normalizeScope, presetOf, scopeForPreset, type BackupScope, type ScopePreset } from "../../shared/intune/scope"

import { BACKUP_SERVICE_AREAS } from "../lib/backup-service"

const PRESETS: Array<{ id: ScopePreset; title: string; text: string }> = [
  { id: "policies", title: "Everything except apps", text: "Configuration from all enabled services, excluding Intune app details." },
  { id: "everything", title: "Everything", text: "Also app details and assignments. Installer files are never included." },
  { id: "custom", title: "Custom", text: "Choose areas and individual types." },
]

interface BackupScopePickerProps {
  selection?: ServiceSelection
  value: BackupScope
  onChange: (scope: BackupScope) => void
  /** Items per type in the latest backup, shown as a guide to how much each type holds. */
  counts?: Record<string, number>
  /** Types the latest backup left out, so their counts are unknown. */
  uncounted?: string[]
  disabled?: boolean
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Chooses what a backup covers: a preset, or areas and types. */
export function BackupScopePicker({ selection = DEFAULT_SELECTION, value, onChange, counts, uncounted = [], disabled }: BackupScopePickerProps) {
  const preset = presetOf(value)
  const [custom, setCustom] = useState(preset === "custom")
  const [open, setOpen] = useState<Set<string>>(new Set())
  const selectedPreset: ScopePreset = custom ? "custom" : preset
  const excluded = new Set(value.excluded)
  const available = includedTypes({ excluded: [] }, selection)
  const offered = new Set(available.map(type => type.folder))
  const areas = BACKUP_SERVICE_AREAS.flatMap(service => service.areas.map(group => ({ ...group, service, types: group.types.filter(type => offered.has(type.folder)) })).filter(group => group.types.length))
  const included = includedTypes(value, selection)

  const setExcluded = (folders: string[], exclude: boolean) => {
    const next = new Set(excluded)
    for (const folder of folders) (exclude ? next.add(folder) : next.delete(folder))
    onChange(normalizeScope({ excluded: [...next] }))
  }

  const choose = (id: ScopePreset) => {
    setCustom(id === "custom")
    if (id !== "custom") onChange(scopeForPreset(id))
  }

  const toggleArea = (area: string) => setOpen((current) => {
    const next = new Set(current)
    if (next.has(area)) next.delete(area)
    else next.add(area)
    return next
  })

  const known = counts !== undefined
  const unknown = new Set(uncounted)
  const countOf = (folder: string) => (known && !unknown.has(folder) ? (counts[folder] ?? 0) : null)
  const estimate = known && included.every((type) => !unknown.has(type.folder)) ? included.reduce((sum, type) => sum + (counts[type.folder] ?? 0), 0) : null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3" role="radiogroup" aria-label="What to back up">
        {PRESETS.map((option) => (
          <label
            key={option.id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors",
              selectedPreset === option.id ? "border-blue-200 bg-blue-50" : "border-gray-200 hover:bg-gray-50",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <input type="radio" name="backup-scope" className="mt-1" checked={selectedPreset === option.id} disabled={disabled} onChange={() => choose(option.id)} />
            <span>
              <span className="block text-sm font-medium text-gray-900">{option.title}</span>
              <span className="mt-0.5 block text-xs text-gray-500">{option.text}</span>
            </span>
          </label>
        ))}
      </div>

      {selectedPreset === "custom" && (
        <div className="divide-y divide-gray-100 rounded-2xl border border-gray-200">
          {areas.map(({ area, service, types }) => {
            const key = `${service.id}/${area}`
            const chosen = types.filter((type) => !excluded.has(type.folder)).length
            const expanded = open.has(key)
            const areaItems = known && types.every((type) => !unknown.has(type.folder)) ? types.reduce((sum, type) => sum + (counts[type.folder] ?? 0), 0) : null
            return (
              <div key={key}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <Checkbox
                    aria-label={`Back up ${area}`}
                    checked={chosen === types.length ? true : chosen === 0 ? false : "indeterminate"}
                    indeterminate={chosen > 0 && chosen < types.length}
                    className="data-[state=indeterminate]:border-coral-600 data-[state=indeterminate]:bg-coral-600 data-[state=indeterminate]:text-white"
                    disabled={disabled}
                    onCheckedChange={() => setExcluded(types.map((type) => type.folder), chosen === types.length)}
                  />
                  <button type="button" className="flex flex-1 items-center justify-between gap-3 text-left" onClick={() => toggleArea(key)} aria-expanded={expanded}>
                    <span className="text-sm font-medium text-gray-900">{service.label}: {area}</span>
                    <span className="flex items-center gap-2 text-xs text-gray-500">
                      {chosen} of {types.length} types{areaItems !== null ? `, ${areaItems} items last time` : ""}
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                  </button>
                </div>
                {expanded && (
                  <div className="space-y-2 px-4 pb-3 pl-11">
                    {types.map((type) => (
                      <label key={type.folder} className="flex cursor-pointer items-center justify-between gap-3 text-sm text-gray-700">
                        <span className="flex items-center gap-3">
                          <Checkbox
                            checked={!excluded.has(type.folder)}
                            disabled={disabled}
                            onCheckedChange={(checked) => setExcluded([type.folder], checked !== true)}
                          />
                          {capitalize(type.label)}
                        </span>
                        {known && <span className="text-xs text-gray-500">{countOf(type.folder) ?? "not in the latest backup"}</span>}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-xs text-gray-500">
        {included.length === available.length ? "All" : included.length} of {available.length} types
        {estimate !== null && `, about ${estimate} items based on the latest backup`}.
      </p>

      {included.some(type => type.folder === "Apps") && (
        <div className="flex gap-3 rounded-2xl bg-gray-50 px-4 py-3 text-xs text-gray-600">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p>
            Apps are saved as their Intune details and assignments, which makes them the slowest type to back up. Installer files
            are never downloaded, so Win32 and line-of-business apps cannot be recreated from a backup; store, web and Microsoft 365 apps can.
          </p>
        </div>
      )}
    </div>
  )
}
