import { RestoreWriteDeferredError } from "../../shared/intune/restore-guards"

// The desktop directory service owns one in-process guard per tenant. A new service
// after restart recovers only durable evidence, just like its retained outcomes.
export class DirectoryPendingPublications {
  private readonly tenants = new Map<string, Set<{ save: () => void; retryAt?: number }>>()
  constructor(private readonly now: () => number = Date.now) {}
  forTenant(tenant: string) {
    const now = this.now
    const key = tenant.toLowerCase()
    let pending = this.tenants.get(key)
    if (!pending) { pending = new Set(); this.tenants.set(key, pending) }
    const publish = (entry: { save: () => void; retryAt?: number }) => { entry.save(); pending.delete(entry) }
    return {
      retain(save: () => void, retryAt?: number) {
        const entry = { save, retryAt }
        pending.add(entry)
        publish(entry)
      },
      flush() {
        let failure: unknown
        for (const entry of pending) {
          try { publish(entry) } catch (error) { failure ??= error }
        }
        if (failure) throw failure
      },
      beforeSend() {
        let retryAt = 0
        for (const entry of pending) {
          if ((entry.retryAt ?? 0) <= now()) delete entry.retryAt
          retryAt = Math.max(retryAt, entry.retryAt ?? 0)
        }
        if (retryAt) throw new RestoreWriteDeferredError("An unsaved Microsoft Graph Retry-After deadline defers directory writes for this tenant. Resume after the deadline.", retryAt)
      },
    }
  }
}
