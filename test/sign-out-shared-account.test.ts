import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SignedInAccount } from "../src/shared/ipc"

const msal = vi.hoisted(() => ({ signOut: vi.fn(async () => undefined), accounts: [] as Array<{ homeAccountId: string }> }))

vi.mock("@azure/msal-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/msal-node")>()
  class PublicClientApplication {
    getAllAccounts = async () => msal.accounts
    signOut = msal.signOut
  }
  return { ...actual, PublicClientApplication }
})

const { AuthManager } = await import("../src/main/auth/msal")

type Profile = SignedInAccount & { homeAccountId: string }
const TENANT_A = "11111111-1111-1111-1111-111111111111"
const TENANT_B = "22222222-2222-2222-2222-222222222222"
const CLIENT = "33333333-3333-3333-3333-333333333333"
const OTHER_CLIENT = "44444444-4444-4444-4444-444444444444"
const HOME = "home-oid.home-tid"

function manager(profiles: Profile[]) {
  const store = new Map(profiles.map((profile) => [profile.tenantId, profile]))
  const auth = new AuthManager({
    cachePlugin: () => ({ beforeCacheAccess: async () => undefined, afterCacheAccess: async () => undefined }),
    openBrowser: async () => undefined,
    accountStore: {
      get: (tenantId) => store.get(tenantId) ?? null,
      set: (profile) => void store.set(profile.tenantId, profile),
      delete: (tenantId) => void store.delete(tenantId),
      list: () => [...store.values()],
    },
  })
  return { auth, store }
}

const profile = (tenantId: string, clientId = CLIENT, homeAccountId = HOME): Profile => ({ tenantId, clientId, username: "admin@contoso.com", homeAccountId })

beforeEach(() => {
  msal.signOut.mockClear()
  msal.accounts = [{ homeAccountId: HOME }]
})

describe("AuthManager.signOut", () => {
  it("keeps the cached sign-in while another tenant uses the same account and app registration", async () => {
    const { auth, store } = manager([profile(TENANT_A), profile(TENANT_B)])
    await auth.signOut(TENANT_B)
    expect(store.has(TENANT_B)).toBe(false)
    expect(msal.signOut).not.toHaveBeenCalled()
  })

  it("signs the account out when no other tenant uses it", async () => {
    const { auth } = manager([profile(TENANT_A)])
    await auth.signOut(TENANT_A)
    expect(msal.signOut).toHaveBeenCalledWith({ account: { homeAccountId: HOME } })
  })

  it("signs the account out when the other tenant uses another account or app registration", async () => {
    for (const other of [profile(TENANT_A, OTHER_CLIENT), profile(TENANT_A, CLIENT, "other-oid.other-tid")]) {
      msal.signOut.mockClear()
      const { auth } = manager([other, profile(TENANT_B)])
      await auth.signOut(TENANT_B)
      expect(msal.signOut).toHaveBeenCalledTimes(1)
    }
  })
})
