export interface RetryOutcome {
  path: string
  success: boolean
  action?: string
  targetTenantId?: string
  retryable?: boolean
  retryJobId?: string
}

const key = (item: RetryOutcome) => `${item.targetTenantId?.toLowerCase() ?? ''}\n${item.path}`

interface RetryBatch {
  targetTenantId?: string
  retryOf?: string
  paths: string[]
}

/** Retry only confirmed failures in their original target, never successful copies. */
export function retryBatches(outcomes: RetryOutcome[]): RetryBatch[] {
  const groups = new Map<string, RetryBatch>()
  for (const outcome of outcomes) {
    if (outcome.success || outcome.action === 'skipped' || outcome.retryable === false) continue
    const tenant = outcome.targetTenantId?.toLowerCase() ?? ''
    const group = groups.get(tenant) ?? { ...(tenant ? { targetTenantId: tenant } : {}), ...(outcome.retryJobId ? { retryOf: outcome.retryJobId } : {}), paths: [] }
    // Mixed jobs still share the tenant's retry request. Only name a common audit parent.
    if (group.retryOf !== outcome.retryJobId) delete group.retryOf
    if (!group.paths.includes(outcome.path)) group.paths.push(outcome.path)
    groups.set(tenant, group)
  }
  return [...groups.values()]
}

export function mergeOutcomes<T extends RetryOutcome>(previous: T[], updates: T[]): T[] {
  const merged = new Map(previous.map((item) => [key(item), item]))
  for (const item of updates) merged.set(key(item), item)
  return [...merged.values()]
}
