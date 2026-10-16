import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { CONTROL_STATUS_LABELS } from "../../../shared/compliance/presentation"
import { formatDate, formatScore, freshData, loadDetail, scopeLabel, unitLabel, type CountedItem, type CountedResult, type RankedGap } from "./api"

/** The groups of the detail, in the order a reader works through a low score. */
const GROUPS: Array<{ result: CountedResult; label: string; open: boolean }> = [
  { result: "different", label: "Different", open: true },
  { result: "missing", label: "Missing", open: true },
  { result: "unknown", label: "Unknown", open: false },
  { result: "matching", label: "Matching", open: false },
  { result: "outsideScope", label: "Outside scope", open: false },
]

/** Every counted item of a saved comparison grouped by its counted result, so each card count can be traced item by item. */
export function groupCounted(items: CountedItem[]): Array<{ result: CountedResult; label: string; open: boolean; items: CountedItem[] }> {
  return GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.result === group.result) }))
}

/**
 * Drill-down of a framework score: every counted capability under its counted result with the
 * reason, the evidence of each gap, and the source controls. Used for the selected tenant and,
 * for MSP, for a tenant picked in the portfolio.
 */
export function ScoreDetail({ tenant, frameworkId, onClose }: { tenant: Tenant; frameworkId: string; onClose: () => void }) {
  const query = useQuery({ queryKey: ["scores-detail", tenant.credentials?.tenantId, frameworkId], queryFn: () => loadDetail(tenant, frameworkId) })
  // Evidence shows only from a successful read; a failed refresh hides it behind the error.
  const current = freshData(query)
  const detail = current?.detail
  const gapsById = new Map((detail?.gaps ?? []).map((gap) => [gap.capabilityId, gap]))

  return (
    <section aria-label="How this score is counted" className="space-y-5 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-medium text-gray-900">{detail ? `${detail.identity.frameworkName}: how the score is counted` : "How this score is counted"}</h3>
          <p className="text-sm text-gray-500">
            {current?.tenantName ?? tenant.name}
            {detail && `, assessed ${formatDate(detail.freshness.assessedAt)}, ${scopeLabel(detail.identity.platforms)}, version ${detail.identity.frameworkVersion}, score ${formatScore(detail.score)}`}
          </p>
          {detail?.versionDetail && <p className="break-all font-mono text-xs text-gray-500">{detail.versionDetail}</p>}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
          Close
        </Button>
      </div>

      {query.isLoading && <div className="h-24 animate-pulse rounded-2xl bg-gray-100" />}
      {query.status === "error" && (
        <div className="flex flex-wrap items-start justify-between gap-3 text-sm text-red-700">
          <p>{query.error instanceof Error ? query.error.message : "The comparison could not be read."}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
            Retry
          </Button>
        </div>
      )}

      {detail && (
        <>
          {detail.incompleteCollection.length > 0 && (
            <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Collection was incomplete ({detail.incompleteCollection.join("; ")}). Missing results in these families may be unknown rather than absent.
            </p>
          )}
          {detail.unassessedNote && <p className="text-xs text-gray-500">{detail.unassessedNote}</p>}

          {detail.items.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-gray-900">Counted {unitLabel(detail.unit, 2)} ({detail.items.length})</h4>
              <p className="text-xs text-gray-500">Each {unitLabel(detail.unit, 1)} counts once, under the result shown, with the reason. Framework references without a configuration check count as unknown. The groups add up to the counts on the score card.</p>
              {groupCounted(detail.items).map((group) => (
                <details key={group.result} open={group.open && group.items.length > 0} className="rounded-2xl bg-gray-50 p-4 text-sm dark:bg-gray-900/40">
                  <summary className="cursor-pointer font-medium text-gray-900">{group.label} ({group.items.length})</summary>
                  {group.items.length === 0 ? (
                    <p className="mt-2 text-gray-600">None.</p>
                  ) : (
                    <ul className="mt-2 space-y-3">
                      {group.items.map((item) => (
                        <CountedRow key={`${item.kind}:${item.id}`} item={item} gap={gapsById.get(item.id)} />
                      ))}
                    </ul>
                  )}
                </details>
              ))}
            </div>
          ) : (
            <div>
              <h4 className="text-sm font-medium text-gray-900">Gaps ({detail.gaps.length})</h4>
              {detail.gaps.length === 0 ? (
                <p className="mt-2 text-sm text-gray-600">No evaluated setting differs or is missing. Unknown results are not counted as matches.</p>
              ) : (
                <ul className="mt-2 space-y-3">
                  {detail.gaps.map((gap) => (
                    <li key={gap.key} className="rounded-2xl bg-gray-50 p-4 text-sm dark:bg-gray-900/40">
                      <span className="font-medium text-gray-900">{gap.capabilityName}</span>
                      <GapEvidence gap={gap} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {detail.controls.length > 0 && (
            <div className="overflow-x-auto">
              <h4 className="text-sm font-medium text-gray-900">Source controls ({detail.controls.length})</h4>
              <table className="mt-2 w-full text-left text-sm">
                <thead className="text-xs text-gray-500">
                  <tr>
                    <th scope="col" className="py-2 pr-4 font-medium">Control</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                    <th scope="col" className="py-2 font-medium">Gaps</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {detail.controls.map((control) => (
                    <tr key={control.id}>
                      <td className="py-2 pr-4 text-gray-800">
                        <span className="font-mono text-xs">{control.id}</span> {control.title}
                      </td>
                      <td className="py-2 pr-4 text-gray-600">{control.unavailable ? `Not checkable: ${control.unavailable}` : CONTROL_STATUS_LABELS[control.status]}</td>
                      <td className="py-2 text-gray-600 tabular-nums">{control.gapCapabilityIds.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

const PLATFORM_LABEL: Record<string, string> = { windows: "Windows", macos: "macOS", ios: "iOS", android: "Android", tenant: "Conditional Access" }

function CountedRow({ item, gap }: { item: CountedItem; gap: RankedGap | undefined }) {
  return (
    <li className="break-words">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-gray-900">{item.name}</span>
        <span className="text-xs text-gray-500">{item.kind === "reference" ? "Framework reference" : item.platform ? PLATFORM_LABEL[item.platform] ?? item.platform : ""}</span>
      </div>
      <p className="mt-0.5 text-gray-600">{item.reason}</p>
      {gap && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-medium text-gray-700">Evidence and priority ({gap.ranking.level})</summary>
          <GapEvidence gap={gap} />
        </details>
      )}
    </li>
  )
}

function GapEvidence({ gap }: { gap: RankedGap }) {
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {gap.mixed && <Chip tone="warning" title="An assigned policy matches part of this capability. Review targeting first.">Mixed evidence</Chip>}
        <Chip tone={gap.ranking.level === "critical" ? "danger" : gap.ranking.level === "high" ? "warning" : "neutral"}>{gap.ranking.level}</Chip>
      </div>
      <p className="text-gray-600">Controls: {gap.controls.map((control) => `${control.id} ${control.title}`).join("; ") || "None mapped"}</p>
      {gap.settings.length > 0 && (
        <ul className="space-y-1 text-xs text-gray-600">
          {gap.settings.map((setting, index) => {
            const policy = gap.policies.find((entry) => entry.policyId === setting.policyId)
            const assignment = policy?.assignment === "notAssigned" ? ", not assigned" : policy?.assignment === "unknown" ? ", assignment unknown" : ""
            return (
              <li key={`${setting.settingId}:${setting.policyId ?? index}`} className="break-words">
                <span className="font-mono text-gray-800">{setting.settingId}</span>: {setting.result === "missing" ? "missing" : `observed ${setting.observed ?? "no value"}`}, expected {setting.expected}
                {setting.policyId ? ` (policy ${policy?.policyName ?? setting.policyId}${assignment})` : ""}
              </li>
            )
          })}
        </ul>
      )}
      {gap.limitations.length > 0 && <p className="text-xs text-amber-800">{gap.limitations.join(" ")}</p>}
      <p className="text-xs text-gray-500">Priority reasons: {gap.ranking.reasons.join(" ")}</p>
    </div>
  )
}
