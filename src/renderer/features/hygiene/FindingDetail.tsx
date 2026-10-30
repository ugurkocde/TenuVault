import { useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { toast } from "../../lib/toast"
import { CLASSIFICATION_LABELS, formatDate, loadFinding, reviewFinding, STATUS_LABELS } from "./api"

const inputClass = "w-full rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

/** One finding: rule, evidence, affected objects, review and history. Review actions only with the plan. */
export function FindingDetail({ tenant, findingId, readOnly, onChanged }: { tenant: Tenant; findingId: string; readOnly: boolean; onChanged: () => void }) {
  const [note, setNote] = useState("")
  const detail = useQuery({ queryKey: ["hygiene-finding", tenant.credentials?.tenantId, findingId], queryFn: () => loadFinding(tenant, findingId) })
  const review = useMutation({
    mutationFn: (action: "acknowledge" | "mark-false-positive" | "reopen") => reviewFinding(tenant, action, findingId, note.trim()),
    onSuccess: () => {
      setNote("")
      toast("Finding updated.", "success")
      onChanged()
      void detail.refetch()
    },
    onError: (error) => toast(error instanceof Error ? error.message : "The finding could not be updated.", "error"),
  })

  if (detail.isLoading) return <div className="h-20 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" />
  if (detail.error || !detail.data) return <p className="text-sm text-red-700 dark:text-red-400">{detail.error instanceof Error ? detail.error.message : "The finding could not be loaded."}</p>
  const { finding, rule, scan } = detail.data
  const reviewed = finding.status === "acknowledged" || finding.status === "false-positive"
  const nameOf = (id: string) => finding.policies.find((policy) => policy.id === id)?.name ?? id

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1">
        <p className="text-gray-800">{finding.explanation}</p>
        <p className="text-gray-600">
          <span className="font-medium text-gray-700">{CLASSIFICATION_LABELS[finding.classification]}.</span>{" "}
          {finding.classification === "definite" ? "A configuration problem in the collected data." : finding.ruleId === "conflicting-setting" ? "Needs group, filter or device context to confirm; unknown membership is not proof either way." : "Needs review; the collected data alone does not confirm it."}
        </p>
        <p className="text-xs text-gray-500">Rule {rule.id}: {rule.description} Limits: {rule.limits}</p>
        <p className="text-xs text-gray-500">Evidence from backup {finding.backupId}, collected {formatDate(finding.collectedAt)}. First seen {formatDate(finding.firstSeenAt)}. Evidence hash {finding.evidenceSha256.slice(0, 16)}.{finding.ruleId === "deprecated-setting" && scan?.catalog?.state === "checked" ? ` Settings Catalog checked ${formatDate(scan.catalog.checkedAt)} (${scan.catalog.total} definitions).` : ""}</p>
      </div>

      <div>
        <p className="font-medium text-gray-800">Affected objects</p>
        <ul className="mt-1 space-y-0.5 text-gray-700">
          {finding.policies.map((policy) => <li key={`${policy.folder}/${policy.id}`} className="break-words">{policy.name} <span className="text-xs text-gray-500">({policy.folder}, {policy.id})</span></li>)}
        </ul>
      </div>

      {finding.settings.map((setting) => (
        <div key={setting.definitionId}>
          <p className="break-all font-medium text-gray-800">{setting.definitionId}</p>
          <table className="mt-1 w-full text-left text-sm">
            <thead className="text-xs text-gray-500"><tr><th scope="col" className="py-1 pr-4 font-medium">Policy</th><th scope="col" className="py-1 font-medium">Value</th></tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {setting.values.map((value) => <tr key={value.policyId}><td className="py-1 pr-4 text-gray-700">{nameOf(value.policyId)}</td><td className="break-all py-1 text-gray-900">{value.display}</td></tr>)}
            </tbody>
          </table>
        </div>
      ))}

      {Object.keys(finding.details).length > 0 && (
        <p className="text-xs text-gray-500">{Object.entries(finding.details).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("; ")}</p>
      )}

      {finding.review && (
        <p className="rounded-2xl bg-gray-50 p-3 text-gray-700 dark:bg-gray-800 dark:text-gray-200">
          {finding.review.action === "false-positive" ? "Marked as false positive" : "Acknowledged"} by {finding.review.by ?? "unknown admin"} on {formatDate(finding.review.at)}{finding.review.note ? `: ${finding.review.note}` : "."}{" "}
          <Link to={`/portal/audit?q=${encodeURIComponent(finding.id)}`} className="font-medium text-gray-900 underline underline-offset-2">View decision in Audit Log</Link>
        </p>
      )}

      {!readOnly && finding.settings[0] && (
        <p className="text-sm">
          <Link to={`/portal/governance/customizations?setting=${encodeURIComponent(finding.settings[0].definitionId)}${finding.policies[0] ? `&policy=${encodeURIComponent(finding.policies[0].name)}` : ""}`} className="font-medium text-gray-900 underline underline-offset-2">Document this setting as a customization</Link>
          <span className="text-gray-500"> when the difference is deliberate; it then appears in Accepted deviations.</span>
        </p>
      )}

      {!readOnly && finding.status !== "resolved" && (
        <div className="space-y-2">
          <label className="block text-xs text-gray-500">
            {reviewed ? "Reason for reopening (optional)" : "Note or false positive reason"}
            <textarea className={`${inputClass} mt-1`} rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            {!reviewed && <Button type="button" size="sm" variant="outline" disabled={review.isPending} onClick={() => review.mutate("acknowledge")}>Acknowledge</Button>}
            {finding.status !== "false-positive" && <Button type="button" size="sm" variant="outline" disabled={review.isPending || !note.trim()} title={note.trim() ? undefined : "Enter the reason first"} onClick={() => review.mutate("mark-false-positive")}>Mark as false positive</Button>}
            {reviewed && <Button type="button" size="sm" variant="outline" disabled={review.isPending} onClick={() => review.mutate("reopen")}>Reopen</Button>}
          </div>
          <p className="text-xs text-gray-500">Reviews never change or delete a policy. A review is reopened automatically when the evidence changes. The decision is recorded in the Audit Log.</p>
        </div>
      )}

      {finding.history && finding.history.length > 0 && (
        <details>
          <summary className="cursor-pointer rounded-full text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">History ({finding.history.length})</summary>
          <ol className="mt-2 space-y-1 text-xs text-gray-600">
            {[...finding.history].reverse().map((entry, index) => (
              <li key={`${entry.at}-${index}`}>{formatDate(entry.at)}, {entry.actor ?? "unknown admin"}: {entry.reason} ({STATUS_LABELS[entry.snapshot.status]}, evidence {entry.snapshot.evidenceSha256.slice(0, 12)})</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}
