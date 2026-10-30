import type { ICachePlugin } from "@azure/msal-node"
import type { SignedInAccount } from "../../shared/ipc"
import type { SecureStore } from "../storage/secure-store"
import type { AuthHost } from "./msal"

/** MSAL token cache for one client id, persisted in the encrypted token store. */
export function secureCachePlugin(store: SecureStore, clientId: string): ICachePlugin {
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

type StoredAccount = SignedInAccount & { homeAccountId: string }

const PREFIX = "auth.account."

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

export function accountStore(store: SecureStore): AuthHost["accountStore"] {
  return {
    get: (tenantId) => parseStoredAccount(store.get(PREFIX + tenantId.toLowerCase())),
    set: (account) => store.set(PREFIX + account.tenantId.toLowerCase(), JSON.stringify(account)),
    delete: (tenantId) => store.delete(PREFIX + tenantId.toLowerCase()),
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
