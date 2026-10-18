import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { toast } from "../../lib/toast"
import { ChangeSetFlow } from "../shared/ChangeSetFlow"
import { createUpgradeChangeSet, discardUpgrade, KIND_LABEL, resolveUpgrade, workflowChangeActions, type Comparison, type Upgrade } from "./api"
import type { ChangeSet } from "../shared/change-set"

type Choice = "local" | "upstream"

const POLICY_TONE: Record<string, "neutral" | "coral" | "success" | "warning" | "danger"> = { matched: "coral", added: "success", removed: "warning", "local-missing": "warning", unsupported: "neutral", unreadable: "danger" }
const SETTING_TONE = (kind: string): "neutral" | "coral" | "success" | "warning" | "danger" => (kind === "conflict" || kind === "type-changed" || kind === "unknown-base" ? "danger" : kind === "local-kept" ? "coral" : kind.startsWith("upstream") ? "success" : kind === "unsupported" ? "warning" : "neutral")

/**
 * One upgrade: per policy the three-way result, explicit resolutions for conflicting edits,
 * changed data types and unattributable differences, then a change set reviewed, applied and
 * rolled back here. Without the plan it is read-only.
 */
export function UpgradeDetail({ tenant, upgrade, comparison, changeSets, allowed, onChanged }: { tenant: Tenant; upgrade: Upgrade; comparison: Comparison; changeSets: ChangeSet[]; allowed: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [settings, setSettings] = useState<Record<string, Record<string, Choice>>>({})
  const [policyChoices, setPolicyChoices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const editable = allowed && ["review", "ready", "change-set"].includes(upgrade.status)

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await action()
      toast(success, "success")
      setSettings({})
      setPolicyChoices({})
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The request failed.", "error")
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  const pendingChanges = Object.values(settings).some((entry) => Object.keys(entry).length) || Object.keys(policyChoices).length > 0
  const save = () => run(() => resolveUpgrade(tenant, upgrade.id, Object.entries(settings).flatMap(([policyKey, entries]) => Object.entries(entries).map(([settingKey, choice]) => ({ policyKey, settingKey, choice }))), Object.entries(policyChoices).map(([policyKey, choice]) => ({ policyKey, choice }))), "Resolutions saved.")

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{upgrade.title}</h3>
          <p className="text-sm text-gray-500">{upgrade.summary}</p>
          <p className="text-xs text-gray-500">
            Customization version {upgrade.customizationVersionFrom}{upgrade.customizationVersionTo ? ` to ${upgrade.customizationVersionTo}` : ""}. Compared {new Date(upgrade.comparedAt).toLocaleString()}.
            {upgrade.mode === "manual" ? " Manual comparison: the installed source is unknown, so every difference needs your decision." : ""}
          </p>
        </div>
        <Chip tone={upgrade.status === "applied" ? "success" : upgrade.status === "review" || upgrade.status === "stale" ? "warning" : upgrade.status === "uncertain" || upgrade.status === "failed" ? "danger" : "coral"}>{upgrade.status}</Chip>
      </div>

      <ul className="space-y-2" aria-label="Policies">
        {upgrade.policies.map((policy) => {
          const compared = comparison.policies.find((entry) => entry.key === policy.key)?.comparison ?? null
          const expanded = open === policy.key
          return (
            <li key={policy.key} className="rounded-2xl border border-gray-100 p-3 text-sm dark:border-gray-800">
              <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : policy.key)} className="flex w-full flex-wrap items-center gap-2 text-left focus-visible:outline focus-visible:outline-2">
                {expanded ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                <Chip tone={POLICY_TONE[policy.kind] ?? "neutral"}>{policy.kind}</Chip>
                <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{policy.name}</span>
                {policy.unresolved > 0 && <Chip tone="danger">{policy.unresolved} to resolve</Chip>}
                {policy.outcome && <Chip tone={policy.outcome === "verified" ? "success" : policy.outcome === "pending" ? "neutral" : "warning"}>{policy.outcome}</Chip>}
              </button>
              {expanded && (
                <div className="mt-3 space-y-3">
                  {policy.blockers.map((blocker) => <p key={blocker} className="rounded-2xl bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{blocker}</p>)}
                  {(policy.kind === "added" || policy.kind === "removed") && (
                    <label className="flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                      {policy.kind === "added" ? "New in the release:" : "Removed by the release:"}
                      <select disabled={!editable || !!policy.batch} value={policyChoices[policy.key] ?? policy.choice ?? ""} onChange={(event) => setPolicyChoices({ ...policyChoices, [policy.key]: event.target.value })} className="rounded-full border border-gray-200 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-900">
                        {policy.kind === "added" ? <><option value="include">create it</option><option value="skip">skip it</option></> : <><option value="keep">keep the tenant policy</option><option value="delete">delete the tenant policy</option></>}
                      </select>
                    </label>
                  )}
                  {compared && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="text-gray-500"><tr><th className="py-1 pr-2 font-medium">Setting</th><th className="py-1 pr-2 font-medium">Outcome</th><th className="py-1 pr-2 font-medium">Installed</th><th className="py-1 pr-2 font-medium">Tenant</th><th className="py-1 pr-2 font-medium">Release</th><th className="py-1 font-medium">Use</th></tr></thead>
                        <tbody>
                          {compared.settings.filter((setting) => setting.kind !== "unchanged").map((setting) => {
                            const chosen = settings[policy.key]?.[setting.key] ?? policy.resolutions[setting.key]
                            return (
                              <tr key={setting.key} className="border-t border-gray-100 align-top dark:border-gray-800">
                                <td className="break-all py-1 pr-2 font-mono text-gray-800 dark:text-gray-200">{setting.key}{policy.documented.includes(setting.key) ? <span className="ml-1 font-sans text-gray-500">(documented)</span> : null}</td>
                                <td className="py-1 pr-2"><Chip tone={SETTING_TONE(setting.kind)} title={setting.note ?? undefined}>{KIND_LABEL[setting.kind] ?? setting.kind}</Chip></td>
                                <td className="break-all py-1 pr-2 font-mono text-gray-600 dark:text-gray-400">{setting.base ?? "absent"}</td>
                                <td className="break-all py-1 pr-2 font-mono text-gray-600 dark:text-gray-400">{setting.local ?? "absent"}</td>
                                <td className="break-all py-1 pr-2 font-mono text-gray-600 dark:text-gray-400">{setting.upstream ?? "absent"}</td>
                                <td className="py-1">
                                  {setting.needsResolution ? (
                                    <select aria-label={`Resolution for ${setting.key}`} disabled={!editable || !!policy.batch} value={chosen ?? ""} onChange={(event) => setSettings({ ...settings, [policy.key]: { ...settings[policy.key], [setting.key]: event.target.value as Choice } })} className="rounded-full border border-gray-200 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-900">
                                      <option value="" disabled>choose</option>
                                      <option value="local">keep tenant value</option>
                                      <option value="upstream">take release value</option>
                                    </select>
                                  ) : <span className="text-gray-500">{setting.kind === "local-kept" || setting.kind === "unsupported" ? "tenant" : "release"}</span>}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      {compared.counts.unchanged > 0 && <p className="mt-1 text-xs text-gray-500">{compared.counts.unchanged} unchanged settings are not listed.</p>}
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
          <Button type="button" variant="outline" disabled={busy || !pendingChanges} onClick={() => void save()}>Save resolutions</Button>
          <Button type="button" disabled={busy || upgrade.status !== "ready" && upgrade.status !== "change-set" || pendingChanges} onClick={() => void run(() => createUpgradeChangeSet(tenant, upgrade.id, null), "Change set created. Review it below.")}>Create change set</Button>
          {!upgrade.batches.length && <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => discardUpgrade(tenant, upgrade.id, "Discarded by the admin"), "Upgrade discarded.")}>Discard</Button>}
        </div>
      )}
      <p className="text-xs text-gray-500">Assignments are never changed by an upgrade. Unresolved settings stop the upgrade; nothing is written until a change set is approved and applied with its pre-change backup.</p>

      {changeSets.map((changeSet) => (
        <div key={changeSet.id} className="rounded-3xl border border-gray-100 p-4 dark:border-gray-800">
          <ChangeSetFlow changeSet={changeSet} actions={allowed ? workflowChangeActions("/api/baseline-upgrades", "", tenant, upgrade.id, changeSet.id) : null} tenantName={tenant.name} onChanged={onChanged} rollbackHint="Rollback change set created. Review and apply it below." />
        </div>
      ))}
    </div>
  )
}
