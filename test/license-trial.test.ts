import { describe, expect, it, vi } from "vitest"
import { licenseCheckoutUrl } from "../src/main/license/buy-url"
import { requestTrialKey } from "../src/main/license/trial"
import { Preferences } from "../src/main/preferences"
import { licensePageTitle, trialDaysLeft, trialReminder } from "../src/renderer/lib/license"
import type { LicenseStatus } from "../src/shared/ipc"

vi.mock("../src/renderer/lib/bridge", () => ({ bridge: {} }))

const DAY = 24 * 60 * 60_000
const API = "https://www.tenuvault.com"

describe("no-card trial request", () => {
  it("posts the address and the screen to the licensing service", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    await requestTrialKey(API, "  admin@contoso.com ", "license-page", fetchMock as unknown as typeof fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${API}/api/desktop-trial`)
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("error")
    expect(JSON.parse(init.body as string)).toEqual({ email: "admin@contoso.com", source: "app-license-page" })
  })

  it.each(["", "admin", "admin@contoso", "a b@contoso.com", 42, null, `${"a".repeat(250)}@contoso.com`])("refuses %s without a request", async (email) => {
    const fetchMock = vi.fn()
    await expect(requestTrialKey(API, email, "welcome", fetchMock as unknown as typeof fetch)).rejects.toThrow("Enter a valid email address.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("drops an invalid source", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    await requestTrialKey(API, "a@contoso.com", "Tenant ID", fetchMock as unknown as typeof fetch)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@contoso.com" })
  })

  it("shows the service's message, or a fallback", async () => {
    const refused = vi.fn(async () => Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 }))
    await expect(requestTrialKey(API, "a@contoso.com", "welcome", refused as unknown as typeof fetch)).rejects.toThrow("Too many attempts.")
    const html = vi.fn(async () => new Response("<html>", { status: 502 }))
    await expect(requestTrialKey(API, "a@contoso.com", "welcome", html as unknown as typeof fetch)).rejects.toThrow("support@tenuvault.com")
    const offline = vi.fn(async () => { throw new TypeError("fetch failed") })
    await expect(requestTrialKey(API, "a@contoso.com", "welcome", offline as unknown as typeof fetch)).rejects.toThrow("could not be reached")
  })
})

describe("Buy now checkout link", () => {
  it("points at the no-trial checkout of the licensing service", () => {
    expect(licenseCheckoutUrl(API, undefined, "trial-day-20")).toBe(`${API}/api/desktop-checkout?plan=pro&src=app-trial-day-20`)
    expect(licenseCheckoutUrl(API, "msp", "license-page-trial")).toBe(`${API}/api/desktop-checkout?plan=msp&src=app-license-page-trial`)
    expect(licenseCheckoutUrl(API, "enterprise", "a&b=c")).toBe(`${API}/api/desktop-checkout?plan=pro`)
  })
})

describe("trial reminders", () => {
  const END = Date.UTC(2026, 11, 3, 12, 0, 0)
  const status = { trial: true, validUntil: new Date(END).toISOString() }
  const at = (daysBeforeEnd: number) => END - daysBeforeEnd * DAY

  it("stays quiet for the first 20 days", () => {
    expect(trialReminder(status, undefined, at(30))).toBeNull()
    expect(trialReminder(status, undefined, at(10) - 1)).toBeNull()
  })

  it("reminds on day 20 and day 27 with the days left", () => {
    expect(trialReminder(status, undefined, at(10))).toEqual({ stage: "day-20", daysLeft: 10, endsAt: status.validUntil })
    expect(trialReminder(status, undefined, at(5))).toMatchObject({ stage: "day-20", daysLeft: 5 })
    expect(trialReminder(status, undefined, at(3))).toEqual({ stage: "day-27", daysLeft: 3, endsAt: status.validUntil })
    expect(trialReminder(status, undefined, at(0.5))).toMatchObject({ stage: "day-27", daysLeft: 1 })
  })

  it("hides a dismissed reminder until the next one is due", () => {
    const dismissed = new Date(at(8)).toISOString()
    expect(trialReminder(status, dismissed, at(7))).toBeNull()
    expect(trialReminder(status, dismissed, at(3))).toMatchObject({ stage: "day-27" })
    expect(trialReminder(status, new Date(at(2)).toISOString(), at(1))).toBeNull()
  })

  it("ignores a dismissal from before the reminder or in the future", () => {
    expect(trialReminder(status, new Date(at(15)).toISOString(), at(9))).toMatchObject({ stage: "day-20" })
    expect(trialReminder(status, new Date(END + DAY).toISOString(), at(9))).toMatchObject({ stage: "day-20" })
  })

  it("has no reminder for paid keys, ended trials or a missing end", () => {
    expect(trialReminder({ ...status, trial: false }, undefined, at(3))).toBeNull()
    expect(trialReminder(status, undefined, END)).toBeNull()
    expect(trialReminder({ trial: true, validUntil: null }, undefined, at(3))).toBeNull()
    expect(trialDaysLeft(status, at(29.5))).toBe(30)
  })

  it("titles the License page for a trial", () => {
    const base = { hasKey: true, keyState: "active", plan: "pro", tenants: [] } as unknown as LicenseStatus
    expect(licensePageTitle({ ...base, trial: true })).toBe("Pro trial active")
    expect(licensePageTitle(base)).toBe("Pro plan active")
  })

  it("stores the dismissal as a preference", () => {
    const values = new Map<string, string>()
    const store = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => void values.set(key, value), delete: (key: string) => void values.delete(key) }
    const timestamp = new Date(at(9)).toISOString()
    expect(new Preferences(store as never).set({ trialReminderDismissedAt: timestamp }).trialReminderDismissedAt).toBe(timestamp)
    expect(() => new Preferences(store as never).set({ trialReminderDismissedAt: "yesterday" })).toThrow("Invalid value for trialReminderDismissedAt.")
  })
})
