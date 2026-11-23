import { useState } from "react"
import { GroupAccessCard, useGroupAccessMissing } from "../../components/GroupAccess"
import { GroupCountLabel, GroupSearch, groupKindLabel, useGroupCounts, type GroupDirectory } from "../../components/GroupSearch"
import type { TenantGroup } from "../../../shared/group-access"
import { useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip } from "~/components/dashboard/tiles"
import { KIND_LABEL, STATE_TONE, targetGroupCounts, targetGroups, targetObjects, type Mapping, type ReferenceKind, type ReferenceResolution } from "./api"

const fieldClass = "h-9 w-full rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

/**
 * Maps each tenant-specific reference to a target-tenant object. A same-name candidate can be
 * copied in, but a mapping only counts once "Confirmed" is ticked: a name match is never
 * proof. Group choices come from the destination directory.
 */
export function MappingEditor({ tenant, references, mappings, onChange }: { tenant: Tenant; references: ReferenceResolution[]; mappings: Mapping[]; onChange: (mappings: Mapping[]) => void }) {
  const kinds = new Set(references.map((reference) => reference.kind))
  const credentials = tenant.credentials
  const tenantId = credentials?.tenantId
  const tenantKey = `${tenantId}:${credentials?.appId}`
  const [lastRead, setLastRead] = useState<{ tenantKey: string; refused: boolean; reviewed: ReferenceResolution[] } | null>(null)
  const [chosenGroups, setChosenGroups] = useState<Record<string, TenantGroup>>({})
  const graphRefused = lastRead?.tenantKey === tenantKey && lastRead.refused
  const planRefused = lastRead?.reviewed !== references && references.some(reference => reference.kind === "group" && reference.state === "mapped-unverified")
  const accessMissing = useGroupAccessMissing(kinds.has("group") ? credentials ?? null : null, graphRefused || planRefused ? false : null)
  const directory: GroupDirectory = {
    tenantKey,
    enabled: Boolean(credentials && !accessMissing),
    search: query => targetGroups(tenant, query),
    counts: ids => targetGroupCounts(tenant, ids),
    onRefused: () => setLastRead({ tenantKey, refused: true, reviewed: references }),
  }
  const useTargetList = (kind: Exclude<ReferenceKind, "group">) => useQuery({ queryKey: ["promotion", "objects", tenantId, kind], queryFn: () => targetObjects(tenant, kind), enabled: kinds.has(kind) })
  const lists = { filter: useTargetList("filter"), scopeTag: useTargetList("scopeTag"), reusableSetting: useTargetList("reusableSetting") }
  const unique = references.filter((reference, index) => reference.state !== "portable" && references.findIndex((entry) => entry.kind === reference.kind && entry.sourceId.toLowerCase() === reference.sourceId.toLowerCase()) === index)
  if (!unique.length) return <p className="text-sm text-gray-600">No tenant-specific references need a mapping.</p>

  const current = (reference: ReferenceResolution) => mappings.find((mapping) => mapping.kind === reference.kind && mapping.sourceId.toLowerCase() === reference.sourceId.toLowerCase())
  const set = (reference: ReferenceResolution, change: Partial<Mapping>) => {
    const existing = current(reference) ?? { kind: reference.kind, sourceId: reference.sourceId, targetId: "", confirmed: false }
    const next = { ...existing, ...change }
    // Changing the target always clears the confirmation.
    if (change.targetId !== undefined && change.targetId !== existing.targetId) next.confirmed = false
    onChange([...mappings.filter((mapping) => mapping !== current(reference)), next].filter((mapping) => mapping.targetId))
  }

  return (
    <div className="space-y-2">
      {credentials && kinds.has("group") && accessMissing && <GroupAccessCard tenant={{ ...credentials, name: tenant.name }}
        context="Group mappings are unavailable until TenuVault can read groups in the destination."
        onRecheck={() => setLastRead({ tenantKey, refused: false, reviewed: references })} />}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-xs text-gray-500">
            <tr><th className="py-2 pr-3 font-normal">Reference</th><th className="py-2 pr-3 font-normal">Resolution</th><th className="py-2 pr-3 font-normal">Target object</th><th className="py-2 font-normal">Confirmed</th></tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {unique.map((reference) => {
              const mapping = current(reference)
              const list = reference.kind === "group" ? null : lists[reference.kind]
              const selectedGroup = mapping && chosenGroups[`${tenantKey}:${mapping.targetId}`]
              return (
                <tr key={`${reference.kind}:${reference.sourceId}`}>
                  <td className="py-2 pr-3 align-top">
                    <span className="block text-gray-900 dark:text-gray-100">{KIND_LABEL[reference.kind]}: {reference.sourceName ?? "name unknown"}</span>
                    <span className="block font-mono text-xs text-gray-500">{reference.sourceId}</span>
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <Chip tone={STATE_TONE[reference.state]}>{reference.state}</Chip>
                    {reference.suggestion && !mapping && (
                      <button type="button" className="mt-1 block text-xs text-blue-700 underline dark:text-blue-300" onClick={() => set(reference, { targetId: reference.suggestion!.targetId })}>
                        Same name in target: "{reference.suggestion.targetName}". Use as candidate
                      </button>
                    )}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    {reference.kind === "group" ? (
                      <div hidden={accessMissing}>
                        <TargetGroupPicker directory={directory} label={`Target group for ${reference.sourceName ?? reference.sourceId}`}
                          selectedId={mapping?.targetId} selectedName={selectedGroup?.displayName ?? (mapping?.targetId === reference.targetId ? reference.targetName : null)}
                          selectedKind={selectedGroup && groupKindLabel(selectedGroup)}
                          onPick={group => {
                            setChosenGroups(groups => ({ ...groups, [`${tenantKey}:${group.id}`]: group }))
                            set(reference, { targetId: group.id })
                          }} onClear={() => set(reference, { targetId: "", confirmed: false })} />
                      </div>
                    ) : list?.data && !list.data.readable ? (
                      <span className="text-xs text-amber-800 dark:text-amber-300">Target objects could not be read: {list.data.reason}</span>
                    ) : (
                      <select className={fieldClass} aria-label={`Target for ${reference.sourceName ?? reference.sourceId}`} value={mapping?.targetId ?? ""} onChange={(event) => set(reference, { targetId: event.target.value })}>
                        <option value="">Not mapped</option>
                        {reference.kind === "scopeTag" && <option value="0">Default (built in)</option>}
                        {(list?.data?.objects ?? []).filter((object) => !(reference.kind === "scopeTag" && object.id === "0")).map((object) => <option key={object.id} value={object.id}>{object.name} ({object.id})</option>)}
                      </select>
                    )}
                  </td>
                  <td className="py-2 align-top">
                    <input type="checkbox" className="h-4 w-4" aria-label={`Confirm mapping for ${reference.sourceName ?? reference.sourceId}`} disabled={!mapping?.targetId || (reference.kind === "group" && accessMissing)} checked={!!mapping?.confirmed} onChange={(event) => set(reference, { confirmed: event.target.checked })} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-500">Only confirmed mappings are used. New policies use Default for source scope tags without a usable mapping. Updates keep the destination's scope tags. Other unmapped references block promotion.</p>
    </div>
  )
}

function TargetGroupPicker({ directory, label, selectedId, selectedName, selectedKind, onPick, onClear }: {
  directory: GroupDirectory
  label: string
  selectedId?: string
  selectedName?: string | null
  selectedKind?: string
  onPick: (group: TenantGroup) => void
  onClear: () => void
}) {
  const counts = useGroupCounts(directory, selectedId ? [selectedId] : [])
  return <div className="min-w-72">
    {selectedId && <div className="flex flex-wrap items-center gap-2 text-xs">
      <span title={selectedId}>{selectedName ?? selectedId}</span>
      {selectedKind && <span className="text-gray-500">{selectedKind}</span>}
      <GroupCountLabel counts={counts?.[selectedId]} />
      <button type="button" className="underline" aria-label={`Clear ${label.toLowerCase()}`} onClick={onClear}>Clear</button>
    </div>}
    <GroupSearch directory={directory} label={label} onPick={onPick} />
  </div>
}
