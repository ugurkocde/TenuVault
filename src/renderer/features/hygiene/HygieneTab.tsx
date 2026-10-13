import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, ScanSearch } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { toast } from "../../lib/toast"
import type { FeatureTabProps } from "../types"
import { CLASSIFICATION_LABELS, formatDate, loadList, runScan, STATUS_LABELS, type Classification, type FindingStatus } from "./api"
import { FindingDetail } from "./FindingDetail"
import { FleetSummary } from "./FleetSummary"
import { ScanSummary } from "./ScanSummary"
import { GovernanceExportButtons } from "../shared/GovernanceExportButtons"
import { hygieneCsv, hygieneJson } from "../shared/governance-export"

const STATUS_TONE: Record<FindingStatus, "danger" | "neutral" | "warning" | "success"> = { open: "danger", acknowledged: "warning", "false-positive": "neutral", resolved: "success" }
const SEVERITY_TONE = { high: "danger", medium: "warning", low: "neutral" } as const

const selectClass = "h-9 rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

/**
 * Conflicts and hygiene (#139). Findings come from the latest complete backup; the collection
 * date and coverage are always shown. Without the plan it lists stored findings read-only and
 * renders nothing when there are none. Nothing here changes or deletes a policy.
 */
export default function HygieneTab({ tenant, plan, allowed }: FeatureTabProps) {
  const [status, setStatus] = useState<FindingStatus | "active" | "all">("active")
  const [classification, setClassification] = useState<Classification | "all">("all")
  const [ruleId, setRuleId] = useState("all")
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  const list = useQuery({ queryKey: ["hygiene", tenant.credentials?.tenantId], queryFn: () => loadList(tenant) })
  const scan = useMutation({
    mutationFn: () => runScan(tenant),
    onSuccess: () => {
      toast("Hygiene scan finished.", "success")
      void list.refetch()
    },
    onError: (error) => toast(error instanceof Error ? error.message : "The scan failed.", "error"),
  })

  const findings = list.data?.findings ?? []
  const rules = list.data?.rules ?? []
  const latest = list.data?.scans[0]
  const shown = useMemo(() => {
    const text = search.trim().toLowerCase()
    return findings.filter((finding) =>
      (status === "all" || (status === "active" ? finding.status === "open" || finding.status === "acknowledged" : finding.status === status)) &&
      (classification === "all" || finding.classification === classification) &&
      (ruleId === "all" || finding.ruleId === ruleId) &&
      (!text || finding.title.toLowerCase().includes(text) || finding.policies.some((policy) => policy.name.toLowerCase().includes(text))))
  }, [findings, status, classification, ruleId, search])

  if (!allowed && !findings.length && !latest) return null
  const refresh = () => void list.refetch()
  const ruleName = (id: string) => rules.find((rule) => rule.id === id)?.name ?? id

  return (
    <div className="space-y-6">
      <section aria-label="Latest hygiene scan" className="space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-medium text-gray-900">{allowed ? "Policy conflicts and hygiene" : "Stored hygiene findings (read-only)"}</h3>
            <p className="max-w-3xl text-sm text-gray-500">Built from the latest complete backup. Types that were not collected are shown as not collected, not as clean. Group membership, filters and device state are not collected, so overlaps that depend on them stay possible, never proven.</p>
          </div>
          {allowed && (
            <Button type="button" size="sm" disabled={scan.isPending} onClick={() => scan.mutate()}>
              <ScanSearch className="h-4 w-4" />
              {scan.isPending ? "Scanning backup" : "Scan latest backup"}
            </Button>
          )}
        </div>
        {list.isLoading && <div className="h-24 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" />}
        {list.error && <p className="text-sm text-red-700 dark:text-red-400">{list.error instanceof Error ? list.error.message : "Findings could not be loaded."}</p>}
        {list.data && !latest && <p className="text-sm text-gray-600">No scan yet. A scan reads the latest complete backup; it does not read or change the tenant apart from checking whether referenced groups exist.</p>}
        {latest && <ScanSummary scan={latest} ruleName={ruleName} />}
      </section>

      {(findings.length > 0 || latest) && (
        <section aria-label="Hygiene findings" className="space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              Status
              <select className={selectClass} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
                <option value="active">Open and acknowledged</option>
                <option value="all">All</option>
                {(Object.keys(STATUS_LABELS) as FindingStatus[]).map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              Classification
              <select className={selectClass} value={classification} onChange={(event) => setClassification(event.target.value as typeof classification)}>
                <option value="all">All</option>
                <option value="definite">Definite</option>
                <option value="possible">Possible overlap</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              Rule
              <select className={selectClass} value={ruleId} onChange={(event) => setRuleId(event.target.value)}>
                <option value="all">All rules</option>
                {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
              </select>
            </label>
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-gray-500">
              Search
              <input className={`${selectClass} rounded-full`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Finding or policy name" />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-gray-500" aria-live="polite">{shown.length} of {findings.length} findings shown.</p>
            <GovernanceExportButtons kind="hygiene" tenantName={tenant.name} disabled={shown.length === 0} buildCsv={() => hygieneCsv(shown, ruleName)} buildJson={(exportedAt) => hygieneJson(shown, ruleName, tenant.name, exportedAt)} />
          </div>
          {shown.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {shown.map((finding) => {
                const open = expanded === finding.id
                return (
                  <li key={finding.id} className="py-3">
                    <button type="button" aria-expanded={open} onClick={() => setExpanded(open ? null : finding.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {open ? <ChevronDown className="h-4 w-4 text-gray-500" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 text-gray-500" aria-hidden="true" />}
                      <span className="min-w-0 flex-1">
                        <span className="block break-words font-medium text-gray-900">{finding.title}</span>
                        <span className="block text-sm text-gray-500">{ruleName(finding.ruleId)}, collected {formatDate(finding.collectedAt)}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Chip tone={finding.classification === "definite" ? "danger" : "warning"}>{CLASSIFICATION_LABELS[finding.classification]}</Chip>
                        <Chip tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Chip>
                        <Chip tone={STATUS_TONE[finding.status]}>{STATUS_LABELS[finding.status]}</Chip>
                      </span>
                    </button>
                    {open && <div className="pl-7 pt-3"><FindingDetail key={finding.lastSeenAt + finding.status} tenant={tenant} findingId={finding.id} readOnly={!allowed} onChanged={refresh} /></div>}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {allowed && <FleetSummary tenant={tenant} plan={plan} />}
    </div>
  )
}
