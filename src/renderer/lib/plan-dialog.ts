import type { Feature } from "../../shared/plans"
import { CommunityLimitError } from "../../shared/plan-errors"
import { FeatureApiError } from "./feature-api"

export type PlanDialogError = FeatureApiError | CommunityLimitError
let current: PlanDialogError | null = null
const listeners = new Set<() => void>()

export const planDialogError = () => current
export function subscribePlanDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function open(error: PlanDialogError) {
  current = error
  for (const listener of listeners) listener()
}

/** Keeps inline plan notes as the explanation when they already cover this feature. */
export function showFeaturePlanError(error: unknown, explained: readonly Feature[] = []): boolean {
  if (!(error instanceof FeatureApiError) || error.status !== 402 || !error.upgrade || explained.includes(error.upgrade)) return false
  open(error)
  return true
}

export function showCommunityLimitError(error: unknown): boolean {
  if (!(error instanceof CommunityLimitError) || error.code !== "community_tenant_limit") return false
  open(error)
  return true
}

export function closePlanDialog() {
  current = null
  for (const listener of listeners) listener()
}
