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
    const groupId = `${tenant}\n${outcome.retryJobId ?? ''}`
    const group = groups.get(groupId) ?? { ...(tenant ? { targetTenantId: tenant } : {}), ...(outcome.retryJobId ? { retryOf: outcome.retryJobId } : {}), paths: [] }
    if (!group.paths.includes(outcome.path)) group.paths.push(outcome.path)
    groups.set(groupId, group)
  }
  return [...groups.values()]
}

export function mergeOutcomes<T extends RetryOutcome>(previous: T[], updates: T[]): T[] {
  const merged = new Map(previous.map((item) => [key(item), item]))
  for (const item of updates) merged.set(key(item), item)
  return [...merged.values()]
}
