import { RestoreWriteDeferredError } from "../../shared/intune/restore-guards"

// The desktop directory service owns one in-process guard per tenant. A new service
// after restart recovers only durable evidence, just like its retained outcomes.
export class DirectoryPendingPublications {
  private readonly tenants = new Map<string, Set<{ save: () => void; retryAt?: number; pageId?: string }>>()
  constructor(private readonly now: () => number = Date.now) {}
  forTenant(tenant: string) {
    const now = this.now
    const key = tenant.toLowerCase()
    let pending = this.tenants.get(key)
    if (!pending) { pending = new Set(); this.tenants.set(key, pending) }
    const publish = (entry: { save: () => void; retryAt?: number; pageId?: string }) => { entry.save(); pending.delete(entry) }
    return {
      retain(save: () => void, retryAt?: number, pageId?: string) {
        const entry = { save, retryAt, pageId }
        pending.add(entry)
        publish(entry)
      },
      flush(pageId?: string) {
        let failure: unknown
        for (const entry of pending) {
          try { publish(entry) } catch (error) {
            if (entry.retryAt === undefined || entry.retryAt > now() || (pageId !== undefined && entry.pageId === pageId)) failure ??= error
          }
        }
        if (failure) throw failure
      },
      beforeSend() {
        let retryAt = 0
        for (const entry of pending) {
          if ((entry.retryAt ?? 0) <= now()) continue
          retryAt = Math.max(retryAt, entry.retryAt ?? 0)
        }
        if (retryAt) throw new RestoreWriteDeferredError("An unsaved Microsoft Graph Retry-After deadline defers directory writes for this tenant. Resume after the deadline.", retryAt)
      },
    }
  }
}
