import { NoticeCard } from "../NoticeCard"
import { AlertTriangle } from "lucide-react"
import { cn } from "~/lib/utils"
import type { MatchStatus, OibPlatform, OibPolicy, PolicyMatch } from "../../../shared/oib/types"
import type { LoadedPlatform } from "./common"

/** One pack policy with its match in the tenant. */
export type MatchRow = { platform: OibPlatform; policy: OibPolicy; match: PolicyMatch }

export const STATUS_LABELS: Record<MatchStatus, string> = { missing: "New policy", current: "Up to date", outdated: "Update available", newer: "Newer than OIB", duplicate: "Ambiguous match" }
// Ambiguous stands apart from New: outlined, red and with an icon.
const STATUS_TONES: Record<MatchStatus, string> = { missing: "bg-blue-100 text-blue-800", current: "bg-green-100 text-green-800", outdated: "bg-amber-100 text-amber-900", newer: "bg-purple-100 text-purple-800", duplicate: "bg-white text-red-800 ring-1 ring-inset ring-red-300" }

export const rowKey = (row: { platform: OibPlatform; policy: { source: string } }) => `${row.platform}\n${row.policy.source}`

export function joinRows(loaded: LoadedPlatform[]): MatchRow[] {
  return loaded.flatMap(({ catalog, comparison }) => comparison.matches.flatMap(match => {
    const policy = catalog.policies.find(p => p.source === match.source)
    return policy ? [{ platform: catalog.platform, policy, match }] : []
  }))
}

/** "tenant v3.7, OIB v3.6", leaving out a side without a version. */
export const versionText = (match: PolicyMatch) => [match.tenantVersion && `tenant v${match.tenantVersion}`, match.oibVersion && `OIB v${match.oibVersion}`].filter(Boolean).join(", ")

/** Why an ambiguous match is not deployed. */
export function ambiguousReason(match: PolicyMatch): string {
  const count = match.matches?.length ?? 0
  return `${count} tenant policies ${match.method === "oibid" ? "carry this policy's OIBID" : "have this policy's name"} and cannot be told apart by version. Keep one in Intune, then compare again.`
}

export function StatusBadge({ match }: { match: PolicyMatch }) {
  const versions = match.status === "outdated" || match.status === "newer" ? versionText(match) : ""
  return <span className="flex flex-wrap gap-2 text-xs">
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5", STATUS_TONES[match.status])}>{match.status === "duplicate" && <AlertTriangle className="h-3 w-3" aria-hidden="true" />}{STATUS_LABELS[match.status]}{versions && `: ${versions}`}</span>
    {match.method && <span className="rounded-full bg-white px-2 py-0.5 text-gray-600" title={match.method === "oibid" ? "Matched by the OIBID in the policy description" : "Matched by policy name (no OIBID available)"}>{match.method === "oibid" ? "OIBID" : "Name"}</span>}
  </span>
}

/** Ambiguous matches, deprecated policies in the tenant and, with `legacy`, other copies left next to a matched policy. */
export function MatchNotes({ loaded, legacy }: { loaded: LoadedPlatform[]; legacy?: boolean }) {
  const rows = joinRows(loaded)
  const deprecated = loaded.flatMap(l => l.comparison.deprecated)
  const duplicates = rows.filter(r => r.match.status === "duplicate")
  const older = legacy ? rows.filter(r => r.match.legacy.length) : []
  const copies = older.reduce((n, r) => n + r.match.legacy.length, 0)
  if (!deprecated.length && !duplicates.length && !older.length) return null
  return <div className="mt-5 space-y-2">
    {duplicates.length > 0 && <NoticeCard tone="warning"
      summary={`${duplicates.length} ${duplicates.length === 1 ? "policy has" : "policies have"} ambiguous matches. Resolve them in Intune.`}
      details={<ul className="space-y-2">{duplicates.map(r => <li key={rowKey(r)}>
        <p className="font-medium">{r.policy.name}</p>
        <p>{ambiguousReason(r.match)}</p>
        <ul className="list-disc pl-4">{r.match.matches?.map(m => <li key={m.id}>{m.name} <span className="font-mono">{m.id}</span></li>)}</ul>
      </li>)}</ul>} />}
    {older.length > 0 && <NoticeCard tone="warning"
      summary={`${copies} extra ${copies === 1 ? "copy of an OIB policy still applies" : "copies of OIB policies still apply"} settings.`}
      details={<ul className="space-y-2">{older.map(r => <li key={rowKey(r)}>
        <p className="font-medium">{r.policy.name}{r.match.tenant && `, matched to ${r.match.tenant.name}`}</p>
        <ul className="list-disc pl-4">{r.match.legacy.map(l => <li key={l.id}>{l.name} <span className="font-mono">{l.id}</span></li>)}</ul>
      </li>)}</ul>} />}
    {deprecated.length > 0 && <NoticeCard tone="warning"
      summary={`Review ${deprecated.length} deployed OIB ${deprecated.length === 1 ? "policy" : "policies"} for removal.`}
      details={<ul className="space-y-2">{deprecated.map(d => <li key={d.tenant.id}>
        <p className="font-medium">{d.tenant.name} <span className="font-mono font-normal">{d.tenant.id}</span></p>
        {d.replacements.length > 0 && <ul className="list-disc pl-4">{d.replacements.map(r => <li key={r.oibId}>Replacement {r.deployed ? "deployed" : "available in OIB"}: {r.name}</li>)}</ul>}
      </li>)}</ul>} />}
  </div>
}
