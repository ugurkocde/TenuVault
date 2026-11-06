import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, ExternalLink, LoaderCircle } from "lucide-react"
import type { OibPolicyChanges, OibPolicySettings, OibSettingRow } from "../../../shared/oib/policy-settings"
import type { OibCatalog, OibPlatform } from "../../../shared/oib/types"
import { SearchInput } from "../FilterControls"
import { errorText, oibRequest, versionLabel, type OibTenant } from "./common"

/**
 * "Show settings" for an OIB policy before it is deployed, and "Show what changes" for a tenant
 * policy an OIB update would replace in place. Both only read: the pack from this device, and
 * the tenant for setting names and the current policy.
 */

/** The OIB docs page of each platform, which explains why the baseline sets what it sets. */
const DOCS: Partial<Record<OibPlatform, string>> = { windows: "windows", macos: "macos", win365: "windows365", byod: "byod", ios: "ios" }
const docsUrl = (platform: OibPlatform) => `https://docs.openintunebaseline.com/${DOCS[platform] ? `platforms/${DOCS[platform]}/` : ""}`

/** Loaded settings by tenant, commit and policy; the pack content of a commit never changes. */
const settingsCache = new Map<string, OibPolicySettings>()
const CACHE_SIZE = 50

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const request = (tenant: OibTenant, catalog: OibCatalog, extra: object) => ({
  tenantId: tenant.tenantId, appId: tenant.appId, platform: catalog.platform, commit: catalog.commit, ...(catalog.tag ? { tag: catalog.tag } : {}), ...extra,
})

/** A toggle that loads its content the first time it opens. */
function useOnDemand<T>(load: () => Promise<T>, initial?: T) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<T | undefined>(initial)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  async function fetchData() {
    setLoading(true); setError("")
    try { setData(await load()) } catch (e) { setError(errorText(e, "The settings could not be read.")) } finally { setLoading(false) }
  }
  function toggle() {
    const next = !open
    setOpen(next)
    if (next && data === undefined && !loading) void fetchData()
  }
  return { open, data, error, loading, toggle, retry: fetchData }
}

function Toggle({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-expanded={open} onClick={onClick} className="inline-flex items-center gap-1 rounded-full text-xs font-medium text-blue-700 hover:underline">
    {open ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}{children}
  </button>
}

function Loading({ text }: { text: string }) {
  return <p role="status" className="mt-2 flex items-center gap-2 text-xs text-gray-600"><LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />{text}</p>
}

function Failure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <p role="alert" className="mt-2 text-xs text-red-700">{error} <button type="button" className="font-medium underline" onClick={onRetry}>Retry</button></p>
}

const NamesNote = () => <p className="mt-2 text-xs text-gray-600">Setting names could not be read from Microsoft Graph, so the names are derived from the setting IDs.</p>

const Lines = ({ lines }: { lines: string[] }) => <span className="block whitespace-pre-wrap break-words">{lines.join("\n")}</span>

/** Rows of settings matching every word of the query in the name, ID or value. */
function filterRows<T extends { id: string; label: string }>(rows: T[], query: string, text: (row: T) => string[]): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rows
  return rows.filter(row => { const haystack = [row.label, row.id, ...text(row)].join("\n").toLowerCase(); return words.every(word => haystack.includes(word)) })
}

/** Long lists get a filter. */
const FILTER_FROM = 10

function SettingList({ rows, total, label }: { rows: OibSettingRow[]; total: number; label: string }) {
  const [query, setQuery] = useState("")
  const shown = filterRows(rows, query, row => row.lines)
  return <div className="mt-2">
    {rows.length >= FILTER_FROM && <div className="mb-2 flex flex-wrap items-center gap-3">
      <SearchInput label={`Filter the settings of ${label}`} value={query} onChange={setQuery} placeholder="Filter settings" />
      {query.trim() && <span role="status" className="text-xs text-gray-500">{shown.length} of {plural(rows.length, "setting", "settings")}</span>}
    </div>}
    {shown.length ? <dl className="divide-y divide-gray-100 rounded-2xl bg-white px-4 text-xs">
      {shown.map(row => <div key={row.id} className="grid gap-1 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-4">
        <dt className="break-words font-medium text-gray-800" title={row.id}>{row.label}</dt>
        <dd className="text-gray-700"><Lines lines={row.lines} /></dd>
      </div>)}
    </dl> : <p className="py-3 text-xs text-gray-500">No settings match the filter.</p>}
    {total > rows.length && <p className="mt-2 text-xs text-gray-600">Showing the first {rows.length} of {total} settings.</p>}
  </div>
}

/** "Show settings": every setting of the OIB policy as the selected version sets it. */
export function PolicySettings({ tenant, catalog, source, name }: { tenant: OibTenant; catalog: OibCatalog; source: string; name: string }) {
  const key = `${tenant.tenantId}\n${catalog.commit}\n${source}`
  const view = useOnDemand(async () => {
    const result = await oibRequest<OibPolicySettings>(request(tenant, catalog, { action: "oib-policy-settings", source }))
    settingsCache.delete(key)
    settingsCache.set(key, result)
    while (settingsCache.size > CACHE_SIZE) settingsCache.delete(settingsCache.keys().next().value!)
    return result
  }, settingsCache.get(key))
  const data = view.data
  return <div className="mt-2">
    <Toggle open={view.open} onClick={view.toggle}>{view.open ? "Hide settings" : "Show settings"}</Toggle>
    {view.open && <div className="mt-1 rounded-2xl bg-gray-100 p-3">
      {view.loading && <Loading text="Reading the policy settings" />}
      {view.error && <Failure error={view.error} onRetry={() => void view.retry()} />}
      {data && <>
        <p className="text-xs text-gray-600">{data.total ? `${plural(data.total, "setting", "settings")} in OpenIntuneBaseline ${versionLabel(catalog)}.` : "This policy sets no settings."}{" "}
          <a href={docsUrl(catalog.platform)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-blue-700 underline">Why OIB sets them<ExternalLink className="h-3 w-3" aria-hidden="true" /></a></p>
        {data.namesMissing && <NamesNote />}
        {data.total > 0 && <SettingList rows={data.settings} total={data.total} label={name} />}
      </>}
    </div>}
  </div>
}

function ChangeGroup({ title, count, shown, children }: { title: string; count: number; shown: number; children: ReactNode }) {
  if (!count) return null
  return <div className="mt-3">
    <h4 className="text-xs font-semibold text-gray-800">{title} ({count})</h4>
    {children}
    {count > shown && <p className="mt-1 text-xs text-gray-600">Showing the first {shown}.</p>}
  </div>
}

/** "Show what changes": the tenant policy's settings now, next to the selected OIB version, for the settings that differ. */
export function PolicyChanges({ tenant, catalog, source, targetId, targetName }: { tenant: OibTenant; catalog: OibCatalog; source: string; targetId: string; targetName: string }) {
  const view = useOnDemand(() => oibRequest<OibPolicyChanges>(request(tenant, catalog, { action: "oib-policy-changes", source, targetId })))
  const data = view.data
  const version = `OIB ${versionLabel(catalog)}`
  const none = data?.supported && !data.counts.changed && !data.counts.added && !data.counts.removed
  return <div className="mt-2">
    <Toggle open={view.open} onClick={view.toggle}>{view.open ? "Hide what changes" : "Show what changes"}</Toggle>
    {view.open && <div className="mt-1 rounded-2xl bg-gray-100 p-3">
      {view.loading && <Loading text={`Reading ${targetName} from the tenant`} />}
      {view.error && <Failure error={view.error} onRetry={() => void view.retry()} />}
      {data && !data.supported && <p className="text-xs text-gray-600">This policy type is not compared setting by setting.</p>}
      {data?.supported && <>
        <p className="text-xs text-gray-600">{none
          ? `The settings of ${data.tenantPolicyName} already match ${version}.`
          : `${data.tenantPolicyName} as it is in the tenant now, compared with ${version}. ${plural(data.unchanged, "setting stays", "settings stay")} the same.`}
          {" "}Update in place replaces its settings with {version} and keeps its assignments; Create alongside leaves it unchanged.</p>
        {data.namesMissing && <NamesNote />}
        <ChangeGroup title="Changed" count={data.counts.changed} shown={data.changed.length}>
          <div className="mt-1 overflow-x-auto rounded-2xl bg-white px-4"><table className="w-full table-fixed text-left text-xs">
            <thead><tr className="text-gray-500"><th className="w-2/5 py-2 pr-3 font-medium">Setting</th><th className="py-2 pr-3 font-medium">In the tenant now</th><th className="py-2 font-medium">{version}</th></tr></thead>
            <tbody>{data.changed.map(change => <tr key={change.id} className="border-t border-gray-100 align-top">
              <td className="break-words py-2 pr-3 font-medium text-gray-800" title={change.id}>{change.label}</td>
              <td className="py-2 pr-3 text-gray-700"><Lines lines={change.before} /></td>
              <td className="py-2 text-gray-900"><Lines lines={change.after} /></td>
            </tr>)}</tbody>
          </table></div>
        </ChangeGroup>
        <ChangeGroup title={`Added by ${version}`} count={data.counts.added} shown={data.added.length}><SettingList rows={data.added} total={data.added.length} label={`settings added by ${version}`} /></ChangeGroup>
        <ChangeGroup title={`Only in ${data.tenantPolicyName}, not in ${version}`} count={data.counts.removed} shown={data.removed.length}><SettingList rows={data.removed} total={data.removed.length} label={`settings only in ${data.tenantPolicyName}`} /></ChangeGroup>
      </>}
    </div>}
  </div>
}
