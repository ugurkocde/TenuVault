import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import type { AuthManager } from "../auth/msal"

type Session = NonNullable<ReturnType<AuthManager["approvalSession"]>>
const tokenKey = (token: string) => createHash("sha256").update(token).digest("hex")

class GraphTokenSessions {
  private readonly active = new AsyncLocalStorage<Map<string, Session>>()
  private readonly recent = new Map<string, { session: Session; expires: number }>()

  run<T>(work: () => T): T {
    return this.active.getStore() ? work() : this.active.run(new Map(), work)
  }

  remember(token: string, session: Session, expiresOn: Date | null): void {
    const time = Date.now()
    for (const [key, entry] of this.recent) if (entry.expires <= time) this.recent.delete(key)
    const key = tokenKey(token)
    // A caller may still need its token after expiry so Graph can return a 401 and trigger refresh.
    this.active.getStore()?.set(key, session)
    this.recent.set(key, { session, expires: expiresOn?.getTime() ?? time + 3_600_000 })
  }

  get(token: string): Session | undefined {
    const key = tokenKey(token)
    return this.active.getStore()?.get(key) ?? this.recent.get(key)?.session
  }
}

export const graphTokenSessions = new GraphTokenSessions()
