import { ACKNOWLEDGEMENT_REQUIRED, DISCLAIMER_VERSION, type AcknowledgementRequired, type DisclaimerAcknowledgement } from "../shared/disclaimer"
import { tenantWriteTargets } from "../shared/tenant-writes"
import type { KeyValueStore } from "./storage/secure-store"

const KEY = "disclaimer.acknowledgements"

/** The disclaimer acceptances on this machine, one per tenant, kept in the encrypted app store. */
export class DisclaimerAcknowledgements {
  constructor(private readonly store: KeyValueStore, private readonly version = DISCLAIMER_VERSION) {}

  /** The tenants among `tenantIds` that have not accepted the current version. */
  missing(tenantIds: string[]): string[] {
    const stored = this.all()
    const ids = [...new Set(tenantIds.map((id) => id.toLowerCase()))]
    return ids.filter((id) => (stored[id]?.version ?? 0) < this.version)
  }

  /** Native IPC writes use the same stored acceptance as HTTP API writes. */
  async run<T>(tenantIds: string[], action: () => Promise<T>): Promise<T | AcknowledgementRequired> {
    const required = this.required(tenantIds)
    return required ?? action()
  }

  required(tenantIds: string[]): AcknowledgementRequired | null {
    const missing = this.missing(tenantIds)
    return missing.length ? {
      error: "No changes were made. Accept the disclaimer before TenuVault changes this tenant.",
      acknowledgement: { version: DISCLAIMER_VERSION, tenantIds: missing },
    } : null
  }

  accept(tenantIds: string[], account: (tenantId: string) => string | null, now = new Date()): void {
    const stored = this.all()
    for (const id of new Set(tenantIds.map((tenantId) => tenantId.toLowerCase()))) {
      stored[id] = { version: this.version, acceptedAt: now.toISOString(), account: account(id) }
    }
    this.store.set(KEY, JSON.stringify(stored))
  }

  private all(): Record<string, DisclaimerAcknowledgement> {
    try {
      const parsed: unknown = JSON.parse(this.store.get(KEY) ?? "{}")
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, DisclaimerAcknowledgement>) : {}
    } catch {
      return {}
    }
  }
}

/**
 * An ApiHost guard that refuses a request writing to a tenant until that tenant has accepted
 * the current disclaimer. The renderer shows the disclaimer on this answer and sends the
 * request again once it is accepted.
 */
export function disclaimerGuard(acknowledgements: DisclaimerAcknowledgements) {
  return async (request: Request): Promise<Response | null> => {
    if (request.method !== "POST") return null
    const pathname = new URL(request.url).pathname.replace(/\/$/, "")
    let body: unknown
    try {
      body = await request.clone().json()
    } catch {
      return null
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null
    const answer = acknowledgements.required(tenantWriteTargets(pathname, body as Record<string, unknown>))
    if (!answer) return null
    return Response.json(answer, { status: ACKNOWLEDGEMENT_REQUIRED })
  }
}
