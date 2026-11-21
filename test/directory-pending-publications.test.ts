import { expect, it, vi } from "vitest"
import { DirectoryPendingPublications } from "../src/main/restore/directory-pending-publications"

it("guards only the tenant with an unsaved deadline and retains every publication until it flushes", () => {
  const publications = new DirectoryPendingPublications(), tenant = publications.forTenant("Tenant")
  let unavailable = true
  const first = vi.fn(() => { if (unavailable) throw new Error("Unavailable") }), second = vi.fn()
  expect(() => tenant.retain(first, Date.now() + 120_000)).toThrow("Unavailable")
  tenant.retain(second)
  expect(() => publications.forTenant("TENANT").beforeSend()).toThrow("unsaved Microsoft Graph")
  expect(() => publications.forTenant("other").beforeSend()).not.toThrow()
  unavailable = false
  tenant.flush()
  expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledOnce()
  expect(() => tenant.beforeSend()).not.toThrow()
})

it("drops expired unsaved deadlines from the guard while retaining unsaved outcomes", () => {
  vi.useFakeTimers()
  try {
    const tenant = new DirectoryPendingPublications().forTenant("tenant")
    let unavailable = true
    const save = vi.fn(() => { if (unavailable) throw new Error("Unavailable") })
    expect(() => tenant.retain(save, Date.now() + 120_000)).toThrow("Unavailable")
    vi.advanceTimersByTime(119_999)
    expect(() => tenant.beforeSend()).toThrow("unsaved Microsoft Graph")
    vi.advanceTimersByTime(1)
    expect(() => tenant.beforeSend()).not.toThrow()
    unavailable = false; tenant.flush()
    expect(save).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

it("expires unsaved deadlines using the injected service clock", () => {
  let now = 100
  const tenant = new DirectoryPendingPublications(() => now).forTenant("tenant")
  expect(() => tenant.retain(() => { throw new Error("Unavailable") }, 200)).toThrow("Unavailable")
  now = 199
  expect(() => tenant.beforeSend()).toThrow("unsaved Microsoft Graph")
  now = 200
  expect(() => tenant.beforeSend()).not.toThrow()
})
