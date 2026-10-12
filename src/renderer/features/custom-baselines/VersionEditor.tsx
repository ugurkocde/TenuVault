import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useState } from "react"
import { ChevronDown, ChevronRight, Trash2, Undo2 } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { toast } from "../../lib/toast"
import { saveVersion, type Baseline, type EditInput, type SettingView, type VersionView } from "./api"

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"
const inputClass = "h-9 w-full rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
const cellInput = "h-8 w-full min-w-40 rounded-full border border-gray-200 bg-white px-3 font-mono text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

type Leaf = SettingView["leaves"][number]
const editKey = (policyKey: string, settingKey: string, path: string) => `${policyKey}\u0000${settingKey}\u0000${path}`

/**
 * The settings of one version with readable names (derived from the setting ID; the full ID is
 * shown too). On the current version choice, text and whole-number values can be edited and
 * settings or policies removed; saving creates a new version with a change note. Secret and
 * tenant-specific values are never editable.
 */
export function VersionEditor({ tenant, baseline, version, allowed, onViewVersion, onSaved }: { tenant: Tenant; baseline: Baseline; version: VersionView; allowed: boolean; onViewVersion: (version: number | null) => void; onSaved: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [removedSettings, setRemovedSettings] = useState<Set<string>>(new Set())
  const [removedPolicies, setRemovedPolicies] = useState<Set<string>>(new Set())
  const [name, setName] = useState(version.name)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const current = version.version === baseline.currentVersion

  const edits: EditInput[] = [
    ...Object.entries(values).map(([key, value]) => {
      const [policyKey, settingKey, path] = key.split("\u0000") as [string, string, string]
      return { type: "set" as const, policyKey, settingKey, path, value }
    }).filter((edit) => !removedPolicies.has(edit.policyKey) && !removedSettings.has(`${edit.policyKey}\u0000${edit.settingKey}`)),
    ...[...removedSettings].map((key) => { const [policyKey, settingKey] = key.split("\u0000") as [string, string]; return { type: "remove-setting" as const, policyKey, settingKey } }).filter((edit) => !removedPolicies.has(edit.policyKey)),
    ...[...removedPolicies].map((policyKey) => ({ type: "remove-policy" as const, policyKey })),
  ]
  const renamed = name.trim() && name.trim() !== version.name
  const dirty = edits.length > 0 || !!renamed

  const save = async () => {
    setBusy(true)
    try {
      await saveVersion(tenant, baseline.id, { fromVersion: version.version, ...(renamed ? { name: name.trim() } : {}), note: note.trim(), edits })
      toast(`Saved as version ${baseline.currentVersion + 1}.`, "success")
      setValues({})
      setRemovedSettings(new Set())
      setRemovedPolicies(new Set())
      setNote("")
      onSaved()
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The version could not be saved.", "error")
    } finally {
      setBusy(false)
    }
  }

  const editor = (policyKey: string, setting: SettingView, leaf: Leaf) => {
    const key = editKey(policyKey, setting.key, leaf.path)
    const pending = values[key]
    const label = `${leaf.label} (${leaf.definitionId})`
    if (!allowed || !current || removedSettings.has(`${policyKey}\u0000${setting.key}`)) return <span className="font-mono text-gray-700 dark:text-gray-300">{leaf.kind === "secret" ? "(secret, not stored)" : String(leaf.value ?? "(not shown)")}</span>
    if (leaf.kind === "boolean-choice") {
      return (
        <select aria-label={label} className={cellInput} value={pending ?? leaf.raw ?? ""} onChange={(event) => setValues({ ...values, [key]: event.target.value })}>
          {leaf.options!.map((option) => <option key={option} value={option}>{option.slice(leaf.definitionId.length + 1)}</option>)}
        </select>
      )
    }
    if (leaf.kind === "choice" || leaf.kind === "string" || leaf.kind === "integer") {
      return <input aria-label={label} className={cellInput} inputMode={leaf.kind === "integer" ? "numeric" : undefined} value={pending ?? String(leaf.value ?? "")} maxLength={4096} onChange={(event) => setValues({ ...values, [key]: event.target.value })} />
    }
    return <span className="font-mono text-gray-500">{leaf.kind === "secret" ? "(secret, not stored)" : leaf.kind === "reference" ? `${String(leaf.value ?? "")} (tenant-specific)` : "(not editable here)"}</span>
  }

  return (
    <section aria-label="Settings" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Version {version.version}{current ? " (current)" : " (read-only)"}</h3>
          <p className="text-sm text-gray-500">{version.note}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">Version
          <select className="h-9 rounded-full border border-gray-200 bg-white px-3 dark:border-gray-700 dark:bg-gray-900" value={version.version} onChange={(event) => onViewVersion(Number(event.target.value) === baseline.currentVersion ? null : Number(event.target.value))}>
            {[...baseline.versions].reverse().map((entry) => <option key={entry.version} value={entry.version}>v{entry.version}</option>)}
          </select>
        </label>
      </div>
      <p className="text-xs text-gray-500">Setting names are derived from the Settings Catalog setting ID; the pack carries no display names. Choices show the option after the setting ID.</p>

      <ul className="space-y-2" aria-label="Policies">
        {version.policies.map((policy) => {
          const expanded = open === policy.key
          const removed = removedPolicies.has(policy.key)
          return (
            <li key={policy.key} className="rounded-2xl border border-gray-100 p-3 text-sm dark:border-gray-800">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : policy.key)} className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline focus-visible:outline-2">
                  {expanded ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
                  <span className={`min-w-0 flex-1 truncate ${removed ? "text-gray-400 line-through" : "text-gray-900 dark:text-gray-100"}`}>{policy.name}</span>
                </button>
                <span className="text-xs text-gray-500">{policy.settings.length} settings · {policy.platforms}</span>
                {policy.nonPortable.length > 0 && <Chip tone="warning" title={policy.nonPortable.map((entry) => entry.note).join(" ")}>{policy.nonPortable.length} not portable</Chip>}
                {allowed && current && (
                  <Button type="button" size="sm" variant="outline" onClick={() => { const next = new Set(removedPolicies); removed ? next.delete(policy.key) : next.add(policy.key); setRemovedPolicies(next) }}>
                    {removed ? <><Undo2 className="h-4 w-4" />Keep policy</> : <><Trash2 className="h-4 w-4" />Remove policy</>}
                  </Button>
                )}
              </div>
              {expanded && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-gray-500"><tr><th className="py-1 pr-2 font-medium">Setting</th><th className="pr-2 font-medium">Value</th><th className="font-medium"><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {policy.settings.map((setting) => {
                        const removedSetting = removedSettings.has(`${policy.key}\u0000${setting.key}`)
                        return setting.leaves.map((leaf, index) => (
                          <tr key={`${setting.key}:${leaf.path}`} className="border-t border-gray-100 align-top dark:border-gray-800">
                            <td className={`py-1.5 pr-2 ${index ? "pl-4" : ""}`}>
                              <span className={removedSetting ? "text-gray-400 line-through" : "text-gray-900 dark:text-gray-100"}>{leaf.label}</span>
                              <span className="block break-all font-mono text-[11px] text-gray-500">{leaf.definitionId}</span>
                              {index === 0 && setting.nonPortable && <span className="block text-amber-800 dark:text-amber-300">{setting.nonPortable.note}</span>}
                            </td>
                            <td className="py-1.5 pr-2">{editor(policy.key, setting, leaf)}</td>
                            <td className="py-1.5">
                              {index === 0 && allowed && current && !removed && (
                                <button type="button" className="text-blue-700 hover:underline dark:text-blue-400" aria-label={`${removedSetting ? "Keep" : "Remove"} ${setting.label}`} onClick={() => { const next = new Set(removedSettings); const key = `${policy.key}\u0000${setting.key}`; removedSetting ? next.delete(key) : next.add(key); setRemovedSettings(next) }}>{removedSetting ? "Keep" : "Remove"}</button>
                              )}
                            </td>
                          </tr>
                        ))
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {allowed && current && (
        <div className="grid gap-3 rounded-2xl bg-gray-50 p-4 sm:grid-cols-2 dark:bg-gray-900">
          <label className="flex flex-col gap-1 text-xs text-gray-500">Baseline name<input className={inputClass} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} /></label>
          <label className="flex flex-col gap-1 text-xs text-gray-500">Change note (required)<input className={inputClass} value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="What changed and why" /></label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="button" disabled={busy || !dirty || !note.trim()} onClick={() => void save()}>{busy ? "Saving" : `Save as version ${baseline.currentVersion + 1}`}</Button>
            <span className="text-xs text-gray-500">{edits.length} change{edits.length === 1 ? "" : "s"}{renamed ? " and a new name" : ""}. Values are checked by type when saved; nothing is written to the tenant.</span>
          </div>
        </div>
      )}
    </section>
  )
}
