/**
 * Selection math for the Tenants page bulk actions.
 * A selection can include tenants the current search hides; select-all only
 * ever adds or removes the visible ids, so hidden selections stay intact.
 */

export type VisibleSelectionState = "none" | "some" | "all"

export function toggleTenantId(selected: readonly number[], id: number): number[] {
  return selected.includes(id) ? selected.filter((tenantId) => tenantId !== id) : [...selected, id]
}

export function addTenantIds(selected: readonly number[], ids: readonly number[]): number[] {
  const known = new Set(selected)
  const missing = ids.filter((id) => !known.has(id))
  return missing.length ? [...selected, ...missing] : [...selected]
}

export function removeTenantIds(selected: readonly number[], ids: readonly number[]): number[] {
  const removing = new Set(ids)
  return selected.filter((id) => !removing.has(id))
}

export function visibleSelectionState(
  selected: readonly number[],
  visibleIds: readonly number[],
): VisibleSelectionState {
  if (visibleIds.length === 0) return "none"
  const chosen = new Set(selected)
  const visibleChosen = visibleIds.filter((id) => chosen.has(id)).length
  if (visibleChosen === 0) return "none"
  return visibleChosen === visibleIds.length ? "all" : "some"
}

/** Drops ids whose tenant no longer exists, e.g. after a delete. */
export function pruneSelection(selected: readonly number[], existingIds: readonly number[]): number[] {
  const existing = new Set(existingIds)
  return selected.filter((id) => existing.has(id))
}

export function hiddenSelectedCount(selected: readonly number[], visibleIds: readonly number[]): number {
  const visible = new Set(visibleIds)
  return selected.filter((id) => !visible.has(id)).length
}
