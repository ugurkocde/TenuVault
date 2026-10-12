import { describe, expect, it } from "vitest"
import { Preferences } from "../src/main/preferences"
import { memoryStore } from "./helpers"

describe("Community banner dismissal preference", () => {
  const timestamp = "2026-10-12T12:00:00.000Z"

  it("leaves the timestamp absent for new and existing preferences", () => {
    const store = memoryStore()
    expect(new Preferences(store).get().communityBannerDismissedAt).toBeUndefined()
    store.set("app.preferences", JSON.stringify({ retentionDays: 90 }))
    expect(new Preferences(store).get()).toMatchObject({ retentionDays: 90 })
    expect(new Preferences(store).get().communityBannerDismissedAt).toBeUndefined()
    new Preferences(store).set({ startAtLogin: true })
    expect(JSON.parse(store.get("app.preferences")!)).not.toHaveProperty("communityBannerDismissedAt")
  })

  it("persists an ISO timestamp across instances and unrelated preference changes", () => {
    const store = memoryStore()
    new Preferences(store).set({ communityBannerDismissedAt: timestamp })
    new Preferences(store).set({ retentionDays: 90 })
    expect(new Preferences(store).get()).toMatchObject({ communityBannerDismissedAt: timestamp, retentionDays: 90 })
  })

  it.each([null, true, 123, "", "invalid", "2026-10-12", "2026-02-30T12:00:00.000Z", {}, []])("rejects a malformed timestamp %j without changing stored preferences", (value) => {
    const store = memoryStore()
    const preferences = new Preferences(store)
    preferences.set({ communityBannerDismissedAt: timestamp })
    expect(() => preferences.set({ communityBannerDismissedAt: value } as never)).toThrow("Invalid value for communityBannerDismissedAt.")
    expect(preferences.get().communityBannerDismissedAt).toBe(timestamp)
  })

  it.each([null, true, 123, "", "invalid", "2026-10-12", "2026-02-30T12:00:00.000Z", {}, []])("ignores a malformed stored timestamp %j and preserves other preferences", (value) => {
    const store = memoryStore()
    store.set("app.preferences", JSON.stringify({ communityBannerDismissedAt: value, retentionDays: 90 }))
    expect(new Preferences(store).get().communityBannerDismissedAt).toBeUndefined()
    expect(new Preferences(store).get().retentionDays).toBe(90)
  })
})
