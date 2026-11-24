import type { ICachePlugin } from "@azure/msal-node"
import type { SignedInAccount } from "../../shared/ipc"
import type { SecureStore } from "../storage/secure-store"
import type { AuthHost } from "./msal"

/** MSAL token cache for one client id, persisted in the encrypted token store. */
export function secureCachePlugin(store: Pick<SecureStore, "get" | "set">, clientId: string): ICachePlugin {
  const key = `msal.${clientId}`
  return {
    beforeCacheAccess: async (context) => {
      const serialized = store.get(key)
      if (serialized) context.tokenCache.deserialize(serialized)
    },
    afterCacheAccess: async (context) => {
      if (context.cacheHasChanged) store.set(key, context.tokenCache.serialize())
    },
  }
}

export type StoredAccount = SignedInAccount & { homeAccountId: string }

const PREFIX = "auth.account."
export const storedAccountKey = (tenantId: string) => PREFIX + tenantId.toLowerCase()

export function storedAccountEntry(account: StoredAccount): Record<string, string> {
  return { [storedAccountKey(account.tenantId)]: JSON.stringify(account) }
}

/** New sign-ins can move one cache into the same encrypted file as the connection. */
export function connectionCache(appStore: SecureStore, tokenStore: SecureStore): Pick<SecureStore, "get" | "set"> {
  return {
    get: key => appStore.get(key) ?? tokenStore.get(key),
    set: (key, value) => (appStore.get(key) === null ? tokenStore : appStore).set(key, value),
  }
}

export function stageConnectionCache(store: Pick<SecureStore, "get">, clientId: string) {
  const key = `msal.${clientId}`
  const before = store.get(key)
  let staged = before
  return {
    plugin: secureCachePlugin({ get: () => staged, set: (_key, value) => { staged = value } }, clientId),
    cacheWrites: () => {
      if (staged === null) throw new Error("Microsoft did not save this sign-in. Try again.")
      if (store.get(key) !== before) throw new Error("The saved sign-in changed during this request. Try again.")
      return { [key]: staged }
    },
  }
}

/** A stored account, or null when the stored value is unreadable or legacy-shaped. */
function parseStoredAccount(raw: string | null): StoredAccount | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== "object") return null
  const account = parsed as Partial<StoredAccount>
  // A corrupt or old-schema profile reads as "not signed in" instead of throwing a raw parse
  // error, so token acquisition asks for sign-in and sign-out can still delete the profile.
  if (typeof account.tenantId !== "string" || typeof account.clientId !== "string" || typeof account.username !== "string" || typeof account.homeAccountId !== "string") return null
  return account as StoredAccount
}

export function accountStore(store: SecureStore, changed?: (tenantId: string) => void): AuthHost["accountStore"] {
  return {
    get: (tenantId) => parseStoredAccount(store.get(storedAccountKey(tenantId))),
    set: (account) => {
      store.set(storedAccountKey(account.tenantId), JSON.stringify(account))
      changed?.(account.tenantId)
    },
    delete: (tenantId) => {
      store.delete(storedAccountKey(tenantId))
      changed?.(tenantId)
    },
    list: () =>
      store
        .keys()
        .filter((key) => key.startsWith(PREFIX))
        .flatMap((key) => {
          const account = parseStoredAccount(store.get(key))
          if (!account) return []
          const { homeAccountId: _homeAccountId, ...listed } = account
          return [listed]
        }),
  }
}
