import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTION_IDS, parseSettingsSection, resolveSettingsSection, settingsHref } from "../src/renderer/lib/settings-section"

describe("parseSettingsSection", () => {
  it("accepts every known section id", () => {
    for (const id of SETTINGS_SECTION_IDS) {
      expect(parseSettingsSection(id)).toBe(id)
    }
  })

  it("defaults to sign-in when the parameter is missing", () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe("signin")
    expect(parseSettingsSection(null)).toBe("signin")
    expect(parseSettingsSection(undefined)).toBe("signin")
    expect(parseSettingsSection("")).toBe("signin")
  })

  it("falls back to sign-in for unknown values", () => {
    expect(parseSettingsSection("nope")).toBe("signin")
    expect(parseSettingsSection("SIGNIN")).toBe("signin")
    expect(parseSettingsSection(" signin ")).toBe("signin")
    expect(parseSettingsSection("__proto__")).toBe("signin")
  })
})

describe("settingsHref", () => {
  it("builds a section deep link", () => {
    expect(settingsHref("signin")).toBe("/portal/settings?section=signin")
    expect(settingsHref("storage")).toBe("/portal/settings?section=storage")
    expect(settingsHref("background")).toBe("/portal/settings?section=background")
  })

  it("keeps an in-section anchor after the query", () => {
    expect(settingsHref("storage", "recovery-key")).toBe("/portal/settings?section=storage#recovery-key")
  })
})

describe("resolveSettingsSection", () => {
  it("opens Services and permissions as its own section", () => {
    expect(settingsHref("services")).toBe("/portal/settings?section=services")
    expect(resolveSettingsSection("services", "")).toBe("services")
  })

  it("sends links from before the section existed to it", () => {
    expect(resolveSettingsSection("signin", "#services")).toBe("services")
    expect(resolveSettingsSection(null, "#services")).toBe("services")
    expect(resolveSettingsSection("signin", "")).toBe("signin")
    expect(resolveSettingsSection("storage", "#services")).toBe("storage")
  })

  it("keeps the recovery key anchor on the storage section", () => {
    expect(resolveSettingsSection(null, "#recovery-key")).toBe("storage")
    expect(resolveSettingsSection("signin", "#recovery-key")).toBe("signin")
  })
})
