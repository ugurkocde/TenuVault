import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { toast } from "../../lib/toast"
import { KIND_LABEL } from "../baseline-upgrades/api"
import { applyRebase, checkReleases, compareRebase, discardRebase, resolveRebase, type Baseline, type Rebase } from "./api"

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"
const SETTING_TONE = (kind: string): "neutral" | "coral" | "success" | "warning" | "danger" => (kind === "conflict" || kind === "type-changed" || kind === "unknown-base" ? "danger" : kind === "local-kept" ? "coral" : kind.startsWith("upstream") ? "success" : kind === "unsupported" ? "warning" : "neutral")
const POLICY_LABEL: Record<string, string> = { matched: "compared", added: "new in the release", removed: "removed by the release", "local-missing": "removed by you" }

/**
 * Newer OpenIntuneBaseline releases: a three-way comparison of the original release (base), your
 * current version (local) and the new release (upstream). Conflicting edits, changed data types
 * and policies whose platform or template changed need a decision; the result is a new version
 * based on the new release. No tenant is read or changed.
 */
export function RebasePanel({ tenant, baseline, rebases, allowed, onChanged }: { tenant: Tenant; baseline: Baseline; rebases: Rebase[]; allowed: boolean; onChanged: () => void }) {
  const [releases, setReleases] = useState<Array<{ tag: string; commit: string; reference: string }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [settings, setSettings] = useState<Record<string, Record<string, "local" | "upstream">>>({})
  const [policies, setPolicies] = useState<Record<string, string>>({})
  const active = rebases.find((entry) => entry.status === "review" || entry.status === "ready") ?? null

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true)
    try {
      await action()
      if (success) toast(success, "success")
      setSettings({})
      setPolicies({})
      onChanged()
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The request failed.", "error")
    } finally {
      setBusy(false)
    }
  }
  const pending = Object.values(settings).some((entry) => Object.keys(entry).length) || Object.keys(policies).length > 0

  if (baseline.origin !== "oib") return <section className={card}><p className="text-sm text-gray-600 dark:text-gray-400">This company baseline comes from a tenant snapshot and has no upstream release. Compare it with frameworks under Compare.</p></section>

  return (
    <div className="space-y-6">
      <section aria-label="Releases" className={card}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Latest OpenIntuneBaseline version</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">Current base: {baseline.provenance.reference}. Rebasing onto the latest OpenIntuneBaseline main commit keeps your edits, takes upstream changes you did not touch, and asks you to decide where both changed. The exact commit is recorded as the new base.</p>
        {allowed && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => void run(async () => {
              const result = await checkReleases(tenant, baseline.id)
              setReleases(result.releases)
              if (!result.releases.length) toast(result.warning ?? "The baseline is already based on the latest OpenIntuneBaseline version.", "info")
            })}>Check the latest OpenIntuneBaseline version</Button>
            {(releases ?? []).map((release) => (
              <Button key={release.commit} type="button" disabled={busy || !!active} onClick={() => void run(() => compareRebase(tenant, baseline.id, release.commit), "Compared. Review the decisions below.")}>Compare with {release.tag}</Button>
            ))}
          </div>
        )}
      </section>

      {rebases.map((rebase) => {
        const editable = allowed && (rebase.status === "review" || rebase.status === "ready")
        return (
          <section key={rebase.id} aria-label={rebase.title} className={card}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{rebase.title}</h3>
                <p className="text-sm text-gray-500">{rebase.summary}</p>
              </div>
              <Chip tone={rebase.status === "applied" ? "success" : rebase.status === "review" ? "warning" : rebase.status === "discarded" ? "neutral" : "coral"}>{rebase.status}</Chip>
            </div>
            <ul className="space-y-2">
              {rebase.entries.map((entry) => {
                const expanded = open === `${rebase.id}:${entry.key}`
                const choices = entry.kind === "added" ? [["include", "add it"], ["skip", "skip it"]] : entry.kind === "removed" ? [["keep", "keep your policy"], ["drop", "drop it"]] : entry.kind === "matched" && entry.blockers.length ? [["local", "keep your policy"], ["upstream", "take the release policy"]] : []
                return (
                  <li key={entry.key} className="rounded-2xl border border-gray-100 p-3 text-sm dark:border-gray-800">
                    <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : `${rebase.id}:${entry.key}`)} className="flex w-full flex-wrap items-center gap-2 text-left focus-visible:outline focus-visible:outline-2">
                      {expanded ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                      <Chip tone={entry.kind === "matched" ? "coral" : "neutral"}>{POLICY_LABEL[entry.kind] ?? entry.kind}</Chip>
                      <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{entry.name}</span>
                      {entry.unresolved > 0 && <Chip tone="danger">{entry.unresolved} to decide</Chip>}
                    </button>
                    {expanded && (
                      <div className="mt-3 space-y-3">
                        {entry.blockers.map((blocker) => <p key={blocker} className="rounded-2xl bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{blocker}</p>)}
                        {choices.length > 0 && (
                          <label className="flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-300">Decision
                            <select disabled={!editable} value={policies[entry.key] ?? entry.choice ?? ""} onChange={(event) => setPolicies({ ...policies, [entry.key]: event.target.value })} className="rounded-full border border-gray-200 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-900">
                              <option value="" disabled>choose</option>
                              {choices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                          </label>
                        )}
                        {entry.comparison && !entry.blockers.length && (
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs">
                              <thead className="text-gray-500"><tr><th className="py-1 pr-2 font-medium">Setting</th><th className="py-1 pr-2 font-medium">Outcome</th><th className="py-1 pr-2 font-medium">Original release</th><th className="py-1 pr-2 font-medium">Your version</th><th className="py-1 pr-2 font-medium">New release</th><th className="py-1 font-medium">Use</th></tr></thead>
                              <tbody>
                                {entry.comparison.settings.filter((setting) => setting.kind !== "unchanged").map((setting) => (
                                  <tr key={setting.key} className="border-t border-gray-100 align-top dark:border-gray-800">
                                    <td className="break-all py-1 pr-2 font-mono text-gray-800 dark:text-gray-200">{setting.key}</td>
                                    <td className="py-1 pr-2"><Chip tone={SETTING_TONE(setting.kind)} title={setting.note ?? undefined}>{(KIND_LABEL[setting.kind] ?? setting.kind).replace("your customization", "your edit")}</Chip></td>
                                    <td className="break-all py-1 pr-2 font-mono text-gray-600 dark:text-gray-400">{setting.base ?? "absent"}</td>
                                    <td className="break-all py-1 pr-2 font-mono text-gray-600 dark:text-gray-400">{setting.local ?? "absent"}</td>
                                    <td className="break-all py-1 pr-2 font-mono text-gray-600 dark:text-gray-400">{setting.upstream ?? "absent"}</td>
                                    <td className="py-1">
                                      {setting.needsResolution ? (
                                        <select aria-label={`Decision for ${setting.key}`} disabled={!editable} value={settings[entry.key]?.[setting.key] ?? entry.resolutions[setting.key] ?? ""} onChange={(event) => setSettings({ ...settings, [entry.key]: { ...settings[entry.key], [setting.key]: event.target.value as "local" | "upstream" } })} className="rounded-full border border-gray-200 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-900">
                                          <option value="" disabled>choose</option>
                                          <option value="local">keep your value</option>
                                          <option value="upstream">take release value</option>
                                        </select>
                                      ) : <span className="text-gray-500">{setting.kind === "local-kept" || setting.kind === "unsupported" ? "yours" : "release"}</span>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {entry.comparison.counts.unchanged > 0 && <p className="mt-1 text-xs text-gray-500">{entry.comparison.counts.unchanged} unchanged settings are not listed.</p>}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            {editable && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={busy || !pending} onClick={() => void run(() => resolveRebase(tenant, rebase.id, Object.entries(settings).flatMap(([policyKey, entries]) => Object.entries(entries).map(([settingKey, choice]) => ({ policyKey, settingKey, choice }))), Object.entries(policies).map(([policyKey, choice]) => ({ policyKey, choice }))), "Decisions saved.")}>Save decisions</Button>
                <Button type="button" disabled={busy || pending || rebase.status !== "ready"} onClick={() => void run(() => applyRebase(tenant, rebase.id), "Rebased version saved. Deploy it when you are ready.")}>Create rebased version</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => discardRebase(tenant, rebase.id), "Discarded.")}>Discard</Button>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
