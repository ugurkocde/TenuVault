import { showFeaturePlanError } from "../../lib/plan-dialog"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { toast } from "../../lib/toast"
import { ChangeSetFlow } from "../shared/ChangeSetFlow"
import { DiffList } from "../shared/DiffList"
import { workflowChangeActions } from "../baseline-upgrades/api"
import { assessAdoption, configureAdoption, getAdoption, planAdoption, previewAdoption, type AdoptionPreview, type Standard } from "./api"

const input = "h-9 w-full rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
const area = "min-h-24 w-full rounded-2xl border border-gray-200 bg-white p-3 font-mono text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

/**
 * One customer's adoption of a standard: parameters, mappings and overlay (with approved
 * exceptions) kept apart from the base, a preview of the effective settings and conflicts,
 * then a reviewed change set. Moving to a newer version is the same reviewed flow.
 */
export function AdoptionPanel({ tenant, adoptionId, standards, canWrite, onChanged }: { tenant: Tenant; adoptionId: string; standards: Standard[]; canWrite: boolean; onChanged: () => void }) {
  const detail = useQuery({ queryKey: ["standards", "adoption", tenant.credentials?.tenantId, adoptionId], queryFn: () => getAdoption(tenant, adoptionId) })
  const [preview, setPreview] = useState<AdoptionPreview | null>(null)
  const [acknowledge, setAcknowledge] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ parameters: Record<string, string>; mappings: Record<string, string>; overlay: string } | null>(null)
  const data = detail.data
  if (!data) return detail.isLoading ? <div className="h-16 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" /> : null
  const { adoption, state, changeSets } = data
  const version = standards.find((entry) => entry.id === adoption.versionId)
  const latest = standards.find((entry) => entry.standardKey === adoption.standardKey)
  const current = draft ?? {
    parameters: Object.fromEntries(Object.entries(adoption.parameters).map(([key, value]) => [key, String(value ?? "")])),
    mappings: Object.fromEntries(adoption.mappings.map((mapping) => [mapping.policyKey, mapping.objectId ?? "new"])),
    overlay: JSON.stringify(adoption.overlay, null, 2),
  }
  const refresh = () => {
    void detail.refetch()
    onChanged()
  }
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
      refresh()
    }
  }
  const save = () => run(async () => {
    let overlay: unknown
    try {
      overlay = JSON.parse(current.overlay)
    } catch {
      throw new Error("The overlay is not valid JSON.")
    }
    const parameters = Object.fromEntries(Object.entries(current.parameters).filter(([, value]) => value !== "").map(([key, value]) => [key, version?.parameters.find((def) => def.name === key)?.type === "integer" && /^-?\d+$/.test(value) ? Number(value) : value]))
    const mappings = (version?.policies ?? []).filter((policy) => current.mappings[policy.key]).map((policy) => ({ policyKey: policy.key, objectId: current.mappings[policy.key] === "new" ? null : current.mappings[policy.key]!.trim() }))
    await configureAdoption(tenant, adoption.id, { parameters, mappings, overlay })
    setDraft(null)
    setPreview(null)
  }, "Saved. Preview before adopting.")

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{adoption.title}</h3>
          <p className="text-sm text-gray-500">{adoption.summary}</p>
          <p className="text-xs text-gray-500">Adopted: {state.adoptedVersion ? `v${state.adoptedVersion}` : "not yet"}. Configured: v{state.configuredVersion}. Latest: {state.latestVersion ? `v${state.latestVersion}` : "unknown"}. Overlay version {adoption.overlayVersion}.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip tone={adoption.status === "adopted" ? "success" : adoption.status === "draft" ? "neutral" : "warning"}>{adoption.status}</Chip>
          {state.pendingUpgrade && <Chip tone="coral">upgrade available</Chip>}
          <Chip tone={state.freshness === "fresh" ? "success" : "warning"}>{state.freshness === "unknown" ? "deviation not assessed" : state.freshness === "stale" ? "assessment stale" : `${state.deviations ?? 0} deviation(s)`}</Chip>
        </div>
      </div>
      {adoption.lastAssessment && (
        <p className="text-xs text-gray-600 dark:text-gray-400">Last assessment {new Date(adoption.lastAssessment.at).toLocaleString()}: {adoption.lastAssessment.counts.match} match, {adoption.lastAssessment.counts.differs} differ, {adoption.lastAssessment.counts.missing} missing, {adoption.lastAssessment.counts.extra} extra, {adoption.lastAssessment.counts.excepted} under an approved exception{state.unknownPolicies ? `, ${state.unknownPolicies} policies unknown (unmapped, missing or unreadable)` : ""}.</p>
      )}
      {adoption.migrationNotes.length > 0 && (
        <ul className="list-disc space-y-1 rounded-2xl bg-amber-50 p-3 pl-8 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{adoption.migrationNotes.map((note, index) => <li key={index}>{note.message}</li>)}</ul>
      )}

      {canWrite && version && !adoption.pending && (
        <div className="space-y-3 rounded-2xl border border-gray-100 p-4 dark:border-gray-800">
          {latest && latest.id !== version.id && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(() => configureAdoption(tenant, adoption.id, { versionId: latest.id }), `Configured for ${latest.title}. Preview the reviewed diff.`)}>Configure for {latest.title}</Button>}
          {version.parameters.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {version.parameters.map((def) => (
                <label key={def.name} className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
                  <span>{def.label} ({def.type}{def.required ? ", required" : ""}{def.default !== null ? `, default ${String(def.default)}` : ""})</span>
                  {def.type === "choice" ? (
                    <select className={input} value={current.parameters[def.name] ?? ""} onChange={(event) => setDraft({ ...current, parameters: { ...current.parameters, [def.name]: event.target.value } })}>
                      <option value="">default</option>
                      {def.options.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : <input className={input} value={current.parameters[def.name] ?? ""} placeholder={def.type === "reference" ? "Reusable setting ID in this tenant" : ""} onChange={(event) => setDraft({ ...current, parameters: { ...current.parameters, [def.name]: event.target.value } })} />}
                </label>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Customer policy for each standard policy</p>
            {version.policies.map((policy) => {
              const value = current.mappings[policy.key] ?? ""
              return (
                <div key={policy.key} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="min-w-48 flex-1 text-gray-800 dark:text-gray-200">{policy.name}</span>
                  <select aria-label={`Target of ${policy.name}`} className={`${input} max-w-44`} value={value === "" ? "" : value === "new" ? "new" : "existing"} onChange={(event) => setDraft({ ...current, mappings: { ...current.mappings, [policy.key]: event.target.value === "existing" ? " " : event.target.value } })}>
                    <option value="">not chosen</option>
                    <option value="new">create a new policy</option>
                    <option value="existing">update an existing policy</option>
                  </select>
                  {value !== "" && value !== "new" && <input aria-label={`Policy ID for ${policy.name}`} className={`${input} max-w-sm`} placeholder="Existing policy ID" value={value.trim()} onChange={(event) => setDraft({ ...current, mappings: { ...current.mappings, [policy.key]: event.target.value || " " } })} />}
                </div>
              )
            })}
          </div>
          <label className="block space-y-1 text-xs text-gray-600 dark:text-gray-400">
            <span>Overlay (JSON: settings as policyKey and setting instance, removals, exceptions with reason, approver and expiry). Kept separate from the standard.</span>
            <textarea className={area} value={current.overlay} onChange={(event) => setDraft({ ...current, overlay: event.target.value })} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy || !draft} onClick={() => void save()}>Save configuration</Button>
            <Button type="button" variant="outline" disabled={busy || !!draft} onClick={() => void run(async () => setPreview(await previewAdoption(tenant, adoption.id)), "Preview ready.")}>Preview effective settings</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => assessAdoption(tenant, adoption.id), "Deviation assessed.")}>Assess deviation</Button>
          </div>
        </div>
      )}

      {preview && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">{preview.notice}{preview.version.latest ? "" : ` A newer version exists: ${preview.version.latestTitle}.`}</p>
          {preview.problems.length > 0 && (
            <ul className="space-y-1 text-xs">
              {preview.problems.map((problem, index) => <li key={index} className={problem.kind === "warning" ? "text-gray-600 dark:text-gray-400" : "text-red-700 dark:text-red-400"}>{problem.kind}: {problem.message}</li>)}
            </ul>
          )}
          {preview.versionDiff.length > 0 && (
            <div><p className="text-xs font-medium text-gray-700 dark:text-gray-300">Changes from the adopted version</p><ul className="list-disc pl-5 text-xs text-gray-600 dark:text-gray-400">{preview.versionDiff.map((entry, index) => <li key={index}>{entry.message}</li>)}</ul></div>
          )}
          {preview.policies.map((policy) => (
            <div key={policy.key} className="space-y-1">
              <p className="text-xs text-gray-800 dark:text-gray-200"><Chip tone={policy.action === "blocked" ? "danger" : policy.action === "none" ? "neutral" : "coral"}>{policy.action}</Chip> {policy.name}</p>
              {policy.action !== "blocked" && policy.action !== "none" && <DiffList entries={policy.diff} truncated={policy.truncated} />}
            </div>
          ))}
          {canWrite && (
            <div className="flex flex-wrap items-center gap-3">
              {adoption.migrationNotes.some((note) => note.kind === "removed") && (
                <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300"><input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} />Removed parameter values no longer apply</label>
              )}
              <Button type="button" disabled={busy || !preview.ready} onClick={() => void run(async () => { await planAdoption(tenant, adoption.id, acknowledge); setPreview(null) }, "Change set created. Review it below.")}>Create change set</Button>
            </div>
          )}
        </div>
      )}

      {changeSets.map((changeSet) => (
        <div key={changeSet.id} className="rounded-3xl border border-gray-100 p-4 dark:border-gray-800">
          <ChangeSetFlow changeSet={changeSet} actions={canWrite ? workflowChangeActions("/api/standards", "standard-", tenant, adoption.id, changeSet.id) : null} tenantName={tenant.name} onChanged={refresh} rollbackHint="Rollback change set created. Review and apply it below." />
        </div>
      ))}
    </div>
  )
}
