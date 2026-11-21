import { describe, expect, it, vi } from "vitest"
import { assertTenantStorageUpdates, changeTenantAccount, RENDERER_STORAGE_VALUE_LIMIT, rendererStorageKey, rendererStorageValue } from "../src/main/renderer-storage"
import { OmissionPolicyStore } from "../src/main/backup/omission-policy"
import { localStorageAccountName } from "../src/shared/constants"

describe("renderer storage bounds", () => {
  it("accepts ordinary keys and values", () => {
    expect(rendererStorageKey("tenuvault_tenants")).toBe("tenuvault_tenants")
    expect(rendererStorageValue("[]")).toBe("[]")
    expect(rendererStorageValue("x".repeat(RENDERER_STORAGE_VALUE_LIMIT))).toHaveLength(RENDERER_STORAGE_VALUE_LIMIT)
  })

  it("refuses non-string, empty and oversized keys", () => {
    expect(() => rendererStorageKey(42)).toThrow("storage key")
    expect(() => rendererStorageKey("")).toThrow("storage key")
    expect(() => rendererStorageKey("k".repeat(257))).toThrow("storage key")
  })

  it("refuses non-string and oversized values", () => {
    expect(() => rendererStorageValue(42)).toThrow("too large")
    expect(() => rendererStorageValue(null)).toThrow("too large")
    expect(() => rendererStorageValue("x".repeat(RENDERER_STORAGE_VALUE_LIMIT + 1))).toThrow("too large")
  })
})

describe("desktop storage moves", () => {
  const tenant = "11111111-2222-3333-4444-555555555555"
  const old = { storageAccountName: "oldacct", subscriptionId: "sub", subscriptionName: "", resourceGroupName: "rg", automationAccountName: "" }
  const next = { ...old, storageAccountName: "newacct" }

  function setup(enrolled = true) {
    const initial = JSON.stringify([{ credentials: { tenantId: tenant, appId: "client" }, resources: old }])
    let profiles = initial
    const values = new Map(enrolled ? [[`backup.omission.${tenant}.enrolled.oldacct`, "true"]] : [])
    const fetchPolicy = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404, headers: { "x-ms-error-code": "BlobNotFound" } }))
    const policies = new OmissionPolicyStore({ get: key => values.get(key) ?? null, set: (key, value) => { values.set(key, value) }, delete: key => { values.delete(key) } }, fetchPolicy)
    const deps = {
      readProfiles: () => profiles,
      writeProfiles: vi.fn((value: string) => { profiles = value }),
      enrolled: (id: string, account: string) => policies.hasStorageEnrollment(id, account),
      destinationEnabled: async (account: string) => (await policies.read(tenant, account, async () => "storage-token")).enabled,
      confirmOff: vi.fn(async () => false),
    }
    return { initial, deps, fetchPolicy }
  }

  it("requires explicit confirmation for an enrolled move to missing policy, and guards the ordinary profile write", async () => {
    const { initial, deps } = setup()
    expect(() => assertTenantStorageUpdates(initial, JSON.stringify([{ credentials: { tenantId: tenant }, resources: next }]), deps.enrolled)).toThrow("Use Change storage")
    await expect(changeTenantAccount(tenant, "oldacct", next, deps)).resolves.toBe(false)
    expect(deps.confirmOff).toHaveBeenCalledWith("newacct")
    expect(deps.readProfiles()).toBe(initial)
    deps.confirmOff.mockResolvedValue(true)
    await expect(changeTenantAccount(tenant, "oldacct", next, deps)).resolves.toBe(true)
    expect(JSON.parse(deps.readProfiles())[0]).toMatchObject({ resources: next, previousAzureStorage: old })
  })

  it("refuses an unreadable destination, and accepts a verified enabled destination without prompting", async () => {
    const { initial, deps, fetchPolicy } = setup()
    fetchPolicy.mockResolvedValueOnce(new Response(null, { status: 403 }))
    await expect(changeTenantAccount(tenant, "oldacct", next, deps)).rejects.toThrow("Backup storage was not changed")
    expect(deps.readProfiles()).toBe(initial)
    fetchPolicy.mockResolvedValueOnce(Response.json({ version: 1, tenantId: tenant, enabled: true, scripts: false, generation: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }))
    await expect(changeTenantAccount(tenant, "oldacct", next, deps)).resolves.toBe(true)
    expect(deps.confirmOff).not.toHaveBeenCalled()
  })

  it("keeps the existing path for a never-enrolled account", async () => {
    const { deps, fetchPolicy } = setup(false)
    await expect(changeTenantAccount(tenant, "oldacct", next, deps)).resolves.toBe(true)
    expect(fetchPolicy).not.toHaveBeenCalled()
    expect(deps.confirmOff).not.toHaveBeenCalled()
  })

  it("keeps ordinary profile saves usable when a local omission policy is malformed", async () => {
    const local = localStorageAccountName(tenant)
    const profile = { credentials: { tenantId: tenant, appId: "client" }, resources: { ...old, storageAccountName: local } }
    const policies = new OmissionPolicyStore({ get: () => "{invalid", set: vi.fn(), delete: vi.fn() }, vi.fn())
    const enrolled = (id: string, account: string) => policies.hasStorageEnrollment(id, account)
    expect(() => assertTenantStorageUpdates(JSON.stringify([profile]), JSON.stringify([{ ...profile, resources: next }]), enrolled)).not.toThrow()
    await expect(policies.read(tenant, local, async () => "")).rejects.toThrow()
  })
})
