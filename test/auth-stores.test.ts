import { describe, expect, it } from "vitest"
import { accountStore } from "../src/main/auth/stores"
import type { SecureStore } from "../src/main/storage/secure-store"

const TENANT_A = "11111111-1111-1111-1111-111111111111"
const TENANT_B = "22222222-2222-2222-2222-222222222222"

function fakeStore(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial))
  const store = {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => void values.set(key, value),
    delete: (key: string) => void values.delete(key),
    keys: () => [...values.keys()],
  }
  return { store: store as unknown as SecureStore, values }
}

const valid = (tenantId: string) => JSON.stringify({ tenantId, clientId: "33333333-3333-3333-3333-333333333333", username: "admin@contoso.com", homeAccountId: "home-oid.home-tid" })

describe("accountStore with unreadable stored accounts", () => {
  it("reads a corrupt account as not signed in instead of throwing, so it can still be deleted", () => {
    const { store, values } = fakeStore({ [`auth.account.${TENANT_A}`]: "{corrupt" })
    const accounts = accountStore(store)
    expect(accounts.get(TENANT_A)).toBeNull()
    accounts.delete(TENANT_A)
    expect(values.has(`auth.account.${TENANT_A}`)).toBe(false)
  })

  it("reads a legacy-shaped account missing fields as not signed in", () => {
    const { store } = fakeStore({ [`auth.account.${TENANT_A}`]: JSON.stringify({ tenantId: TENANT_A }) })
    expect(accountStore(store).get(TENANT_A)).toBeNull()
  })

  it("lists only readable accounts, skipping corrupt ones", () => {
    const { store } = fakeStore({
      [`auth.account.${TENANT_A}`]: "{corrupt",
      [`auth.account.${TENANT_B}`]: valid(TENANT_B),
      "other.key": "ignored",
    })
    const listed = accountStore(store).list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ tenantId: TENANT_B, username: "admin@contoso.com" })
    expect(listed[0]).not.toHaveProperty("homeAccountId")
  })
})
