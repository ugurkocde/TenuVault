import { describe, expect, it, vi } from "vitest"
import { CommunityChoicePendingError } from "../src/shared/plan-errors"
import { MAX_REFUSALS, RefusalLog, refuseUnlicensedBackup } from "../src/main/backup/refusals"
import { memoryStore } from "./helpers"

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER = "33333333-3333-3333-3333-333333333333"

describe("RefusalLog", () => {
  it("records refusals newest first and keeps them in the store", () => {
    const store = memoryStore()
    let now = new Date("2026-09-25T02:00:00Z")
    const onChange = vi.fn()
    const log = new RefusalLog(store, onChange, () => now)
    log.record({ tenantId: TENANT.toUpperCase(), tenantName: "Contoso", trigger: "scheduled", reason: "A license is required." })
    now = new Date("2026-09-26T02:00:00Z")
    log.record({ tenantId: TENANT, tenantName: "Contoso", trigger: "tray", reason: "Tenant limit reached." })

    expect(onChange).toHaveBeenCalledTimes(2)
    const reopened = new RefusalLog(store)
    expect(reopened.list(TENANT)).toEqual([
      { at: "2026-09-26T02:00:00.000Z", tenantId: TENANT, tenantName: "Contoso", trigger: "tray", reason: "Tenant limit reached." },
      { at: "2026-09-25T02:00:00.000Z", tenantId: TENANT, tenantName: "Contoso", trigger: "scheduled", reason: "A license is required." },
    ])
  })

  it("filters by tenant", () => {
    const log = new RefusalLog(memoryStore())
    log.record({ tenantId: TENANT, tenantName: "Contoso", trigger: "scheduled", reason: "a" })
    log.record({ tenantId: OTHER, tenantName: "Fabrikam", trigger: "scheduled", reason: "b" })
    expect(log.list(OTHER).map((entry) => entry.tenantName)).toEqual(["Fabrikam"])
    expect(log.list()).toHaveLength(2)
  })

  it("keeps only the most recent entries and bounds their text", () => {
    const log = new RefusalLog(memoryStore())
    for (let i = 0; i < MAX_REFUSALS + 25; i++) {
      log.record({ tenantId: TENANT, tenantName: "Contoso", trigger: "scheduled", reason: `refusal ${i}` })
    }
    const entries = log.list()
    expect(entries).toHaveLength(MAX_REFUSALS)
    expect(entries[0]!.reason).toBe(`refusal ${MAX_REFUSALS + 24}`)
    expect(entries.at(-1)!.reason).toBe("refusal 25")

    log.record({ tenantId: TENANT, tenantName: "x".repeat(2000), trigger: "tray", reason: "y".repeat(2000) })
    expect(log.list()[0]!.reason.length).toBeLessThanOrEqual(500)
    expect(log.list()[0]!.tenantName.length).toBeLessThanOrEqual(500)
  })

  it("starts over from an unreadable log instead of failing the backup check", () => {
    const store = memoryStore()
    store.set("backup.refusals", "not json")
    const log = new RefusalLog(store)
    expect(log.list()).toEqual([])
    log.record({ tenantId: TENANT, tenantName: "Contoso", trigger: "scheduled", reason: "a" })
    expect(log.list()).toHaveLength(1)
  })
})

describe("refuseUnlicensedBackup", () => {
  const tenant = { tenantId: TENANT, name: "Contoso" }

  it("lets a licensed tenant's backup run without a record", async () => {
    const log = new RefusalLog(memoryStore())
    const notify = vi.fn()
    const result = await refuseUnlicensedBackup({ requireEntitlement: async () => undefined, log, notify }, tenant, "scheduled")
    expect(result).toBeNull()
    expect(log.list()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it("records, notifies and reports the license reason for a refused tenant", async () => {
    const log = new RefusalLog(memoryStore())
    const notify = vi.fn()
    const requireEntitlement = vi.fn(async () => {
      throw new Error("A TenuVault license is required for this tenant.")
    })
    const result = await refuseUnlicensedBackup({ requireEntitlement, log, notify }, tenant, "tray")

    expect(requireEntitlement).toHaveBeenCalledWith(TENANT)
    expect(result).toBe("Not backed up: A TenuVault license is required for this tenant.")
    expect(notify).toHaveBeenCalledWith("Contoso", result)
    expect(log.list(TENANT)).toEqual([
      expect.objectContaining({ tenantId: TENANT, tenantName: "Contoso", trigger: "tray", reason: "A TenuVault license is required for this tenant." }),
    ])
  })
})

it("does not record or notify a background refusal while Community choice is pending", async () => {
  const log = new RefusalLog(memoryStore())
  const notify = vi.fn()
  await expect(refuseUnlicensedBackup({ log, notify, requireEntitlement: async () => { throw new CommunityChoicePendingError() } }, { tenantId: "contoso", name: "Contoso" }, "scheduled")).rejects.toBeInstanceOf(CommunityChoicePendingError)
  expect(log.list()).toEqual([])
  expect(notify).not.toHaveBeenCalled()
})
