import { useEffect, useId, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "~/lib/utils"
import { GROUP_SEARCH_LIMIT, type GroupCounts, type GroupSearchResult, type TenantGroup } from "../../shared/group-access"

const KIND_LABEL: Record<TenantGroup["kind"], string> = { security: "Security", microsoft365: "Microsoft 365", other: "Distribution" }

export function groupKindLabel(group: TenantGroup) {
  return `${KIND_LABEL[group.kind]}${group.dynamic ? ", dynamic" : ""}`
}

export interface GroupDirectory {
  tenantKey: string
  enabled: boolean
  search: (query: string) => Promise<GroupSearchResult>
  counts: (ids: string[]) => Promise<{ counts: Record<string, GroupCounts> }>
  onRefused: () => void
}

export function useGroupCounts(directory: GroupDirectory, ids: string[]) {
  const wanted = [...new Set(ids)].sort()
  const query = useQuery({
    queryKey: ["group-counts", directory.tenantKey, wanted],
    queryFn: () => directory.counts(wanted),
    enabled: directory.enabled && wanted.length > 0,
    retry: false,
    staleTime: 5 * 60_000,
  })
  return query.data?.counts
}

export function GroupCountLabel({ counts, scope }: { counts?: GroupCounts; scope?: "device" | "user" }) {
  if (!counts) return null
  const { devices, users, groups } = counts
  const labels = [
    devices && `${devices} ${devices === 1 ? "device" : "devices"}`,
    users && `${users} ${users === 1 ? "user" : "users"}`,
    groups && `${groups} nested ${groups === 1 ? "group" : "groups"}`,
  ].filter(Boolean)
  const mismatch = scope === "device" && users > 0 && !devices && !groups ? "Has only users"
    : scope === "user" && devices > 0 && !users && !groups ? "Has only devices" : ""
  return <span className={cn("text-xs", labels.length && !mismatch ? "text-gray-500" : "text-amber-800 dark:text-amber-300")}>
    {labels.join(", ") || "No members"}{mismatch && <> · {mismatch}</>}
  </span>
}

export function GroupSearch({ directory, label, scope, disabled, unavailable, candidate, onPick }: {
  directory: GroupDirectory
  label: string
  scope?: "device" | "user"
  disabled?: boolean
  unavailable?: ReadonlyMap<string, string>
  candidate?: { targetId: string; targetName: string } | null
  onPick: (group: TenantGroup) => void
}) {
  const id = useId()
  const [text, setText] = useState("")
  const [answer, setAnswer] = useState<{ key: string; groups: TenantGroup[]; error?: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const handlers = useRef(directory)
  const { enabled, tenantKey } = directory
  const query = text.trim()
  const key = `${tenantKey}:\n${query}`
  const searching = enabled && !disabled && query.length >= 2
  const current = searching && answer?.key === key ? answer : null
  const results = current?.groups ?? []
  const counts = useGroupCounts(directory, results.map(group => group.id))

  useEffect(() => { handlers.current = directory }, [directory])
  useEffect(() => {
    setAnswer(null)
    if (!searching) return
    let live = true
    const timer = setTimeout(() => {
      void handlers.current.search(query).then(result => {
        if (!live) return
        if (!result.readable) handlers.current.onRefused()
        else setAnswer({ key, groups: result.groups })
      }).catch(error => {
        if (live) setAnswer({ key, groups: [], error: error instanceof Error ? error.message : "Groups could not be searched." })
      })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [key, query, searching])

  const reason = (group: TenantGroup) => group.kind === "other" ? "Distribution list. Cannot be assigned." : unavailable?.get(group.id)
  const pick = (group: TenantGroup) => {
    if (reason(group)) return
    onPick(group)
    setText("")
    setAnswer(null)
    input.current?.focus()
  }

  return <div className="mt-2">
    {candidate && <button type="button" disabled={disabled} className="mb-1 text-left text-xs text-blue-700 underline dark:text-blue-300" onClick={() => {
      setText(candidate.targetId)
      input.current?.focus()
    }}>Search for same-name candidate "{candidate.targetName}"</button>}
    <input ref={input} aria-label={label} value={text} disabled={disabled} onChange={event => setText(event.target.value)} autoComplete="off"
      onKeyDown={event => {
        if (event.key !== "Enter") return
        event.preventDefault()
        if (results.length === 1) pick(results[0]!)
      }}
      placeholder="Search by the start of a group name, or paste an object ID"
      className="h-10 w-full rounded-full border border-gray-300 bg-white px-4 text-sm dark:border-gray-700 dark:bg-gray-900" aria-describedby={id} />
    <p id={id} role="status" className="mt-1 text-xs text-gray-500">
      {searching && (current?.error ? <span className="text-red-700">{current.error}</span>
        : !current ? "Searching…" : !results.length ? "No matching groups." : results.length >= GROUP_SEARCH_LIMIT ? "Showing the first 15 matches. Type more to narrow." : "")}
    </p>
    {results.length > 0 && <ul className="mt-1 max-h-56 overflow-auto rounded-2xl border border-gray-200 bg-white p-1 shadow-sm dark:border-gray-700 dark:bg-gray-900" aria-label={`Groups matching ${query}`}>
      {results.map(group => <li key={group.id}>
        <button type="button" disabled={!!reason(group)} onClick={() => pick(group)} className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-gray-800">
          <span className="min-w-0 truncate" title={group.id}>{group.displayName}</span>
          <span className="text-xs text-gray-500">{reason(group) ?? groupKindLabel(group)}</span>
          <GroupCountLabel counts={counts?.[group.id]} scope={scope} />
        </button>
      </li>)}
    </ul>}
  </div>
}
