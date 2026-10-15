import { showFeaturePlanError } from "../../lib/plan-dialog"
import { createContext, useContext, useState, type ReactNode } from "react"
import { CheckCircle2, Cloud, Laptop, Monitor, Smartphone, Tablet } from "lucide-react"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { allows, type Feature } from "../../../shared/plans"
import { OIB_PLATFORMS, type OibCatalog, type OibComparison, type OibPlatform, type OibSelection, type OibVersions } from "../../../shared/oib/types"
import { isPrerelease, pickerReleases, platformStatus, selectionLabel, tagChannel, tagVersion } from "../../../shared/oib/versions"
import { tenantLicense, tenantPlan, useLicense } from "../../lib/license"

export const button = "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
export const primary = cn(button, "border-transparent bg-primary text-primary-foreground hover:bg-primary/90")
export const card = "rounded-3xl bg-white p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function oibRequest<T>(body: object): Promise<T> {
  const response = await fetch("/api/oib", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`)
  return result
}

/** "Windows, macOS and BYOD" */
export const listJoin = (items: string[]) => new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" }).format(items)

/** "v4.0" for a release, "main" otherwise. */
export const versionLabel = (value: { tag?: string }) => value.tag ? tagVersion(value.tag) ?? value.tag : "main"

/** "Windows v4.0, macOS main and BYOD v1.0" for the platforms given. */
export const versionsLabel = (values: Array<{ platform: OibPlatform; tag?: string }>) => listJoin(values.map(v => `${OIB_PLATFORMS[v.platform].label} ${versionLabel(v)}`))

/** "Windows" or "Windows and macOS" for platform ids. */
export const platformsLabel = (platforms: OibPlatform[]) => listJoin(platforms.map(p => OIB_PLATFORMS[p].label))

/** The error text of a failed request, with commit hashes shortened. */
export const errorText = (error: unknown, fallback = "The request failed.") => (error instanceof Error && error.message ? error.message : fallback).replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/gi, "$1")

/** "less than a minute ago", "25 minutes ago", "3 hours ago" */
export function minutesAgo(minutes: number): string {
  if (minutes < 1) return "less than a minute ago"
  if (minutes < 60) return `${Math.round(minutes)} ${Math.round(minutes) === 1 ? "minute" : "minutes"} ago`
  const hours = Math.round(minutes / 60)
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`
}

export interface OibTenant {
  tenantId: string
  appId: string
  name: string
  storageAccountName?: string
}

/** The selected tenant and what its plan includes. */
export function useOibTenant() {
  const { selectedTenant } = useSelectedTenant()
  const { status } = useLicense()
  const credentials = selectedTenant?.credentials
  const tenant: OibTenant | null = credentials?.tenantId && credentials.appId
    ? { tenantId: credentials.tenantId, appId: credentials.appId, name: selectedTenant?.name ?? credentials.tenantId, storageAccountName: selectedTenant?.resources?.storageAccountName }
    : null
  const plan = tenantPlan(tenantLicense(status, credentials?.tenantId))
  const can = (feature: Feature) => plan !== null && allows(plan, feature)
  return { tenant, plan, can }
}

/** Runs one request at a time with a status line and an error message; `stage` updates the line. */
export function useTask() {
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError("")
    try { await action() } catch (e) { showFeaturePlanError(e); setError(e instanceof Error ? e.message : "The request failed.") } finally { setBusy("") }
  }
  return { busy, error, setError, run, stage: setBusy }
}

/** The old status line below a card; new flows show status in the ActionBar of FlowShell instead. */
export function Status({ busy, error, progress }: { busy: string; error: string; progress?: { stage: string; done: number; total: number } | null }) {
  return <>
    {busy && <p role="status" className="mt-4 text-sm text-blue-700">{progress ? `${progress.stage}${progress.total ? ` (${progress.done + 1} of ${progress.total})` : ""}` : `${busy}…`}</p>}
    {error && <p role="alert" className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
  </>
}

const ICONS: Record<OibPlatform, typeof Monitor> = { windows: Monitor, macos: Laptop, win365: Cloud, byod: Smartphone, ios: Smartphone, android: Tablet }

export function OptionCard({ selected, disabled, onClick, title, description, icon, badge }: { selected: boolean; disabled?: boolean; onClick: () => void; title: string; description: string; icon?: ReactNode; badge?: ReactNode }) {
  return <button type="button" aria-pressed={selected} disabled={disabled} onClick={onClick}
    className={cn("flex min-h-28 flex-col items-start gap-2 rounded-3xl border p-5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      selected ? "border-primary bg-blue-50/60" : "border-gray-200 bg-white hover:bg-gray-50")}>
    <span className="flex w-full items-center justify-between gap-2">{icon}{selected ? <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" /> : badge}</span>
    <span className="text-sm font-medium text-gray-900">{title}</span>
    <span className="text-xs leading-5 text-gray-600">{description}</span>
  </button>
}

export function PlatformPicker({ value, onChange, disabled }: { value: OibPlatform[]; onChange: (value: OibPlatform[]) => void; disabled?: boolean }) {
  const choice = useContext(VersionsContext)
  // In-development platforms (per releases.json) cannot be scanned; without the manifest, all are offered.
  const inDevelopment = (platform: OibPlatform) => (choice ? platformStatus(choice.versions, platform) : "available") === "in-development"
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="Operating systems">
    {(Object.keys(OIB_PLATFORMS) as OibPlatform[]).map(platform => {
      const Icon = ICONS[platform]
      const pending = inDevelopment(platform)
      return <OptionCard key={platform} selected={value.includes(platform)} disabled={disabled || pending} title={OIB_PLATFORMS[platform].label}
        description={pending ? `${OIB_PLATFORMS[platform].description}. OpenIntuneBaseline has no published ${OIB_PLATFORMS[platform].label} baseline yet, so TenuVault cannot deploy one.` : OIB_PLATFORMS[platform].description}
        icon={<Icon className="h-6 w-6 text-gray-700" aria-hidden="true" />}
        badge={pending ? <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">In development</span> : undefined}
        onClick={() => onChange(value.includes(platform) ? value.filter(p => p !== platform) : [...value, platform])} />
    })}
  </div>
}

export interface LoadedPlatform {
  catalog: OibCatalog
  comparison: OibComparison
}

/** The version chosen for each platform on the OpenIntuneBaseline page. */
export type Selections = Record<OibPlatform, OibSelection>

/** The versions chosen on the OpenIntuneBaseline page; `choose` applies new ones (the open workflow restarts). */
export interface OibVersionChoice {
  versions: OibVersions
  selections: Selections
  choose: (value: Selections) => void
  /** Whether beta prereleases are offered as the latest version by default. */
  allowPrerelease: boolean
  setAllowPrerelease: (value: boolean) => void
}

export const VersionsContext = createContext<OibVersionChoice | null>(null)

/** Loads one platform pack at its selected version; also used to start a download early. */
export const loadCatalog = (tenant: OibTenant, platform: OibPlatform, selection: OibSelection) =>
  oibRequest<OibCatalog>({ action: "oib-load", tenantId: tenant.tenantId, platform, commit: selection.commit, ...(selection.tag ? { tag: selection.tag } : {}) })

const selectValue = (selection: OibSelection) => selection.tag ?? "main"

/** One version select per platform: published releases newest first, then main. Prereleases are offered per the toggle. */
export function VersionPicker({ versions, value, onChange, allowPrerelease = true }: { versions: OibVersions; value: Selections; onChange: (value: Selections) => void; allowPrerelease?: boolean }) {
  // Manifest release dates are date-only (2026-09-30); parse them at local noon so the day does not shift by timezone.
  const date = (iso?: string) => iso ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso).toLocaleDateString() : ""
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    {(Object.keys(OIB_PLATFORMS) as OibPlatform[]).map(platform => {
      const releases = pickerReleases(versions, platform, allowPrerelease)
      const pending = platformStatus(versions, platform) === "in-development"
      return <label key={platform} className="flex flex-col gap-1 text-xs font-medium text-gray-700">{OIB_PLATFORMS[platform].label}{pending ? " (in development)" : ""}
        <select value={selectValue(value[platform])} disabled={pending} className="h-10 rounded-full border border-gray-300 bg-white px-4 text-sm font-normal disabled:cursor-not-allowed disabled:opacity-60"
          onChange={e => {
            const release = releases.find(r => r.tag === e.target.value)
            onChange({ ...value, [platform]: release ? { commit: release.commit, tag: release.tag } : { commit: versions.main.commit } })
          }}>
          {releases.map((release, index) => <option key={release.tag} value={release.tag}>{tagVersion(release.tag)}{tagChannel(release.tag) ? ` ${tagChannel(release.tag)}` : isPrerelease(release) ? " (prerelease)" : release.channel !== "stable" ? ` (${release.channel})` : ""}{index === 0 ? " (latest)" : ""}, {date(release.releaseDate)}</option>)}
          <option value="main">main @ {versions.main.commit.slice(0, 7)}{releases.length ? " (unreleased)" : " (no release yet)"}</option>
        </select>
      </label>
    })}
  </div>
}

/** Compares a loaded pack with the tenant. */
export const compareCatalog = (tenant: OibTenant, catalog: OibCatalog) =>
  oibRequest<OibComparison>({ action: "oib-compare", tenantId: tenant.tenantId, appId: tenant.appId, platform: catalog.platform, commit: catalog.commit, ...(catalog.tag ? { tag: catalog.tag } : {}) })

/** "Windows v4.0 · macOS v1.0 · BYOD main @ 1cc71a9" */
export const selectionSummary = (value: Selections) => (Object.keys(OIB_PLATFORMS) as OibPlatform[]).map(p => `${OIB_PLATFORMS[p].label} ${selectionLabel(value[p])}`).join(" · ")

export function StatCard({ label, value, tone = "gray" }: { label: string; value: number | string; tone?: "gray" | "green" | "amber" | "red" | "blue" }) {
  const tones = { gray: "bg-gray-50", green: "bg-green-50", amber: "bg-amber-50", red: "bg-red-50", blue: "bg-blue-50" }
  return <div className={cn("rounded-2xl px-4 py-3", tones[tone])}><p className="text-2xl font-semibold text-gray-900">{value}</p><p className="text-xs text-gray-600">{label}</p></div>
}

export function Toggle({ checked, onChange, disabled, label, children }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string; children?: ReactNode }) {
  return <label className="flex items-start gap-3 text-sm text-gray-800">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
    <span><span className="font-medium">{label}</span>{children && <span className="mt-1 block text-xs leading-5 text-gray-500">{children}</span>}</span>
  </label>
}
