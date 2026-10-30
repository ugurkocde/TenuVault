import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useEffect, useMemo, useState } from "react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { toast } from "../../lib/toast"
import { OIB_PLATFORMS, type OibPlatform, type OibVersions } from "../../../shared/oib/types"
import { defaultSelection, platformStatus, selectionLabel } from "../../../shared/oib/versions"
import { adoptStandard, createStandard, diffStandards, publishStandardVersion, type Standard, type VersionDiffEntry } from "./api"

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"
const input = "h-9 w-full rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
const area = "min-h-24 w-full rounded-2xl border border-gray-200 bg-white p-3 font-mono text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

function parseJson(text: string, what: string): unknown {
  if (!text.trim()) return []
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what} is not valid JSON.`)
  }
}

/** Appends one structured entry to a JSON array field; the field stays the source of truth. */
export function appendJsonEntry(text: string, entry: Record<string, unknown>, what: string): string {
  const parsed = parseJson(text, what)
  if (!Array.isArray(parsed)) throw new Error(`${what} must be a JSON array.`)
  return JSON.stringify([...parsed, entry], null, 2)
}

/** Setting IDs named by pasted policy exports, for binding suggestions; invalid JSON suggests nothing. */
export function settingIdsOf(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return []
    const ids = new Set<string>()
    for (const policy of parsed as Array<{ settings?: Array<{ settingInstance?: { settingDefinitionId?: unknown }; settingDefinitionId?: unknown }> }>) {
      for (const setting of policy?.settings ?? []) {
        const id = setting?.settingInstance?.settingDefinitionId ?? setting?.settingDefinitionId
        if (typeof id === "string") ids.add(id)
      }
    }
    return [...ids].sort()
  } catch {
    return []
  }
}

/**
 * The MSP's reusable standards (shared by all customers, no tenant evidence): immutable versions
 * with provenance, parameters and change notes. A new version is published from the latest one;
 * adopting it for a customer happens per customer and never automatically.
 */
export function StandardsLibrary({ tenant, standards, adoptedKeys, canWrite, onChanged }: { tenant: Tenant; standards: Standard[]; adoptedKeys: string[]; canWrite: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [from, setFrom] = useState<Standard | null>(null)
  const [diff, setDiff] = useState<{ id: string; entries: VersionDiffEntry[] } | null>(null)
  const [form, setForm] = useState({ standardKey: "", name: "", changeNotes: "", sourceType: "manual", reference: "", platform: "windows", policies: "", parameters: "", bindings: "" })
  // Structured builders for the JSON fields below: one entry at a time, appended to the
  // JSON, which stays editable and remains what is submitted.
  const [parameter, setParameter] = useState({ name: "", label: "", type: "string", required: false, options: "", defaultValue: "" })
  const [binding, setBinding] = useState({ policyKey: "", settingDefinitionId: "", parameter: "" })
  const settingSuggestions = useMemo(() => settingIdsOf(form.policies), [form.policies])
  // The OpenIntuneBaseline versions the main process resolved; the only ones it loads.
  const [oibVersions, setOibVersions] = useState<OibVersions | null>(null)
  const oibPlatform = Object.hasOwn(OIB_PLATFORMS, form.platform) ? form.platform as OibPlatform : null
  const oibUnavailable = !!(oibVersions && oibPlatform && platformStatus(oibVersions, oibPlatform) === "in-development")
  const oibSelection = oibVersions && oibPlatform && !oibUnavailable ? defaultSelection(oibVersions, oibPlatform) : null
  const oibCommit = oibSelection?.commit ?? null
  useEffect(() => {
    if (form.sourceType !== "oib" || oibVersions) return
    void fetch("/api/oib", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "oib-versions" }) })
      .then((response) => response.json())
      .then((result: Partial<OibVersions>) => setOibVersions(result.main && Array.isArray(result.releases) && Array.isArray(result.platforms) ? result as OibVersions : null))
      .catch(() => setOibVersions(null))
  }, [form.sourceType, oibVersions])
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await action()
      toast(success, "success")
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The request failed.", "error")
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  const submit = () => run(async () => {
    if (form.sourceType === "oib" && !oibCommit) throw new Error("The latest OpenIntuneBaseline version could not be read. Check the connection and try again.")
    const source = form.sourceType === "oib" ? { type: "oib", platform: form.platform, commit: oibCommit } : { type: "manual", reference: form.reference }
    const body = { name: form.name, changeNotes: form.changeNotes, source, policies: form.sourceType === "oib" ? undefined : parseJson(form.policies, "Policies"), parameters: parseJson(form.parameters, "Parameters"), bindings: parseJson(form.bindings, "Bindings") }
    if (from) await publishStandardVersion(tenant, { ...body, previousVersionId: from.id })
    else await createStandard(tenant, { ...body, standardKey: form.standardKey })
    setFrom(null)
  }, from ? "New version published. Customers keep their adopted version until you adopt it for them." : "Standard published.")
  const latestIds = new Set(standards.filter((version, index) => standards.findIndex((candidate) => candidate.standardKey === version.standardKey) === index).map((version) => version.id))

  return (
    <section aria-label="Golden standards" className={card}>
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Golden standards</h3>
        <p className="max-w-3xl text-sm text-gray-500">Reusable across customers and stored without tenant evidence. Versions are immutable; tenant-specific values are parameters, and tenant references must be bound to a reference parameter.</p>
      </div>
      {!standards.length && <p className="text-sm text-gray-600">No standards published yet.</p>}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {standards.map((version) => (
          <li key={version.id} className="space-y-2 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block text-gray-900 dark:text-gray-100">{version.title}</span>
                <span className="block text-xs text-gray-500">Source: {version.source.reference}. {version.policies.length} policies, {version.parameters.length} parameters. {version.changeNotes}</span>
              </span>
              {latestIds.has(version.id) ? <Chip tone="success">latest</Chip> : <Chip tone="neutral">older</Chip>}
              {version.previousVersionId && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => setDiff({ id: version.id, entries: (await diffStandards(tenant, version.previousVersionId!, version.id)).diff }), "Diff loaded.")}>What changed</Button>}
              {canWrite && latestIds.has(version.id) && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setFrom(version); setForm({ ...form, name: version.title.replace(/ v\d+$/, "") }) }}>New version</Button>}
              {canWrite && !adoptedKeys.includes(version.standardKey) && <Button type="button" size="sm" disabled={busy} onClick={() => void run(() => adoptStandard(tenant, version.id), `Adoption started for ${tenant.name}. Configure and preview it below.`)}>Adopt for {tenant.name}</Button>}
            </div>
            {diff?.id === version.id && (
              <ul className="list-disc space-y-1 rounded-2xl bg-gray-50 p-3 pl-8 text-xs text-gray-700 dark:bg-gray-900 dark:text-gray-300">
                {diff.entries.length ? diff.entries.map((entry, index) => <li key={index}>{entry.message}</li>) : <li>No differences.</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {canWrite && (
        <form className="space-y-3 rounded-2xl border border-gray-100 p-4 dark:border-gray-800" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{from ? `New version of ${from.title}` : "New standard"}</p>
          <div className="grid gap-3 md:grid-cols-3">
            {!from && <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Key (lowercase, hyphens)</span><input className={input} value={form.standardKey} onChange={(event) => setForm({ ...form, standardKey: event.target.value })} /></label>}
            <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Name</span><input className={input} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Source</span>
              <select className={input} value={form.sourceType} onChange={(event) => setForm({ ...form, sourceType: event.target.value })}><option value="manual">Settings Catalog exports</option><option value="oib">OpenIntuneBaseline (latest release)</option></select>
            </label>
          </div>
          {form.sourceType === "oib" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Platform</span><select className={input} value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value })}>{(Object.keys(OIB_PLATFORMS) as OibPlatform[]).map((id) => <option key={id} value={id} disabled={oibVersions ? platformStatus(oibVersions, id) === "in-development" : false}>{OIB_PLATFORMS[id].label}{oibVersions && platformStatus(oibVersions, id) === "in-development" ? " (in development)" : ""}</option>)}</select></label>
              <p className="self-end text-xs text-gray-500">{oibSelection ? `Version: ${selectionLabel(oibSelection)}. The exact commit is recorded with the standard.` : oibUnavailable ? "OpenIntuneBaseline has no published baseline for this platform yet." : "Reading the latest OpenIntuneBaseline version."}</p>
            </div>
          ) : (
            <>
              <label className="block space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Source reference</span><input className={input} value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} /></label>
              <label className="block space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Policies (JSON array of Settings Catalog exports)</span><textarea className={area} value={form.policies} onChange={(event) => setForm({ ...form, policies: event.target.value })} /></label>
              <label className="block space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Or load the policies from an export file</span><input type="file" accept=".json,application/json" className={input} onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then((text) => setForm((current) => ({ ...current, policies: text }))).catch(() => toast("The file could not be read.", "error")) }} /></label>
            </>
          )}
          <fieldset className="space-y-2" onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault() }}>
            <legend className="text-xs font-medium text-gray-600 dark:text-gray-400">Add a parameter</legend>
            <div className="grid gap-3 md:grid-cols-4">
              <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Name</span><input className={input} value={parameter.name} onChange={(event) => setParameter({ ...parameter, name: event.target.value })} /></label>
              <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Label</span><input className={input} value={parameter.label} onChange={(event) => setParameter({ ...parameter, label: event.target.value })} /></label>
              <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Type</span><select className={input} value={parameter.type} onChange={(event) => setParameter({ ...parameter, type: event.target.value })}><option value="string">string</option><option value="integer">integer</option><option value="choice">choice</option><option value="reference">reference</option></select></label>
              <label className="flex items-center gap-2 pt-5 text-sm text-gray-700"><input type="checkbox" className="size-4" checked={parameter.required} onChange={(event) => setParameter({ ...parameter, required: event.target.checked })} />Required</label>
              {parameter.type === "choice" && <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Options (comma separated, required for choice)</span><input className={input} value={parameter.options} onChange={(event) => setParameter({ ...parameter, options: event.target.value })} /></label>}
              <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Default (optional)</span><input className={input} value={parameter.defaultValue} onChange={(event) => setParameter({ ...parameter, defaultValue: event.target.value })} /></label>
            </div>
            <Button type="button" size="sm" variant="outline" disabled={!parameter.name.trim() || !parameter.label.trim() || (parameter.type === "choice" && !parameter.options.trim())} onClick={() => { try { const options = parameter.options.split(",").map((value) => value.trim()).filter(Boolean); const entry: Record<string, unknown> = { name: parameter.name.trim(), label: parameter.label.trim(), type: parameter.type, required: parameter.required }; if (parameter.type === "choice") entry.options = options; if (parameter.defaultValue.trim()) entry.default = parameter.type === "integer" && Number.isSafeInteger(Number(parameter.defaultValue)) ? Number(parameter.defaultValue) : parameter.defaultValue.trim(); setForm((current) => ({ ...current, parameters: appendJsonEntry(current.parameters, entry, "Parameters") })); setParameter({ name: "", label: "", type: "string", required: false, options: "", defaultValue: "" }) } catch (error) { toast(error instanceof Error ? error.message : "The parameter could not be added.", "error") } }}>Add parameter to the JSON below</Button>
          </fieldset>
          <label className="block space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Parameters (JSON array: name, label, type string, integer, choice or reference, required, default, min, max, options, renamedFrom)</span><textarea className={area} value={form.parameters} onChange={(event) => setForm({ ...form, parameters: event.target.value })} /></label>
          <fieldset className="space-y-2" onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault() }}>
            <legend className="text-xs font-medium text-gray-600 dark:text-gray-400">Add a binding</legend>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Policy key</span><input className={input} value={binding.policyKey} onChange={(event) => setBinding({ ...binding, policyKey: event.target.value })} /></label>
              <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Setting definition ID</span><input className={input} list="standard-setting-ids" autoComplete="off" spellCheck={false} value={binding.settingDefinitionId} onChange={(event) => setBinding({ ...binding, settingDefinitionId: event.target.value })} /></label>
              <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Parameter</span><input className={input} value={binding.parameter} onChange={(event) => setBinding({ ...binding, parameter: event.target.value })} /></label>
            </div>
            <datalist id="standard-setting-ids">{settingSuggestions.map((value) => <option key={value} value={value} />)}</datalist>
            <Button type="button" size="sm" variant="outline" disabled={!binding.policyKey.trim() || !binding.settingDefinitionId.trim() || !binding.parameter.trim()} onClick={() => { try { setForm((current) => ({ ...current, bindings: appendJsonEntry(current.bindings, { policyKey: binding.policyKey.trim(), settingDefinitionId: binding.settingDefinitionId.trim(), parameter: binding.parameter.trim() }, "Bindings") })); setBinding({ policyKey: "", settingDefinitionId: "", parameter: "" }) } catch (error) { toast(error instanceof Error ? error.message : "The binding could not be added.", "error") } }}>Add binding to the JSON below</Button>
          </fieldset>
          <label className="block space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Bindings (JSON array: policyKey, settingDefinitionId, parameter)</span><textarea className={area} value={form.bindings} onChange={(event) => setForm({ ...form, bindings: event.target.value })} /></label>
          <label className="block space-y-1 text-xs text-gray-600 dark:text-gray-400"><span>Change notes</span><input className={input} value={form.changeNotes} onChange={(event) => setForm({ ...form, changeNotes: event.target.value })} /></label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !form.name || !form.changeNotes || (form.sourceType === "oib" && oibUnavailable)}>{from ? "Publish version" : "Publish standard"}</Button>
            {from && <Button type="button" variant="outline" onClick={() => setFrom(null)}>Cancel</Button>}
          </div>
        </form>
      )}
    </section>
  )
}
