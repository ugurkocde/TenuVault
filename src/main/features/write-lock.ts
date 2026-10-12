/** One write owner per tenant across deployments, change sets and framework creation.
 * Refuse overlapping writers rather than queueing them, matching each workflow's existing
 * behavior and requiring the caller to review and retry after the active change finishes.
 * Hold the lock through backup, writes and result recording. Different tenants may run together.
 */
const writers = new Map<string, string>()

export class TenantWriteConflict extends Error {
  readonly status = 409

  constructor(label: string) {
    super(`Another change is being applied to this tenant: ${label}. Try again when it finishes.`)
    this.name = "TenantWriteConflict"
  }
}

/** The active writer, used to protect a framework assessment from deletion during creation. */
export function tenantWriteLabel(tenantId: string): string | undefined {
  return writers.get(tenantId.toLowerCase())
}

export async function withTenantWrite<T>(tenantId: string, label: string, fn: () => Promise<T>): Promise<T> {
  const tenant = tenantId.toLowerCase()
  const active = writers.get(tenant)
  if (active !== undefined) throw new TenantWriteConflict(active)
  writers.set(tenant, label)
  try {
    return await fn()
  } finally {
    writers.delete(tenant)
  }
}
