import { describe, expect, it } from "vitest"
import { licenseBuyUrl, licenseCheckoutUrl } from "../src/main/license/buy-url"
import { appLinkSource, withAppLinkSource } from "../src/shared/link-source"
import { SETUP_CALL_URL, setupCallUrl, type SetupCallSource } from "../src/shared/setup-call"

const INVALID = [undefined, null, 123, "", "Welcome", "setup header", "a&tenant=id", "a#fragment", "a/b", "a".repeat(41), "welcome\n", ["welcome"], { source: "welcome" }]

describe("link source rule", () => {
  it("names a screen with the app prefix", () => {
    expect(appLinkSource("welcome")).toBe("app-welcome")
    expect(appLinkSource("first-backup-error")).toBe("app-first-backup-error")
    for (const source of ["a", "7", "a".repeat(40)]) expect(appLinkSource(source)).toBe(`app-${source}`)
  })

  it.each(INVALID)("has no source for %j", (source) => {
    expect(appLinkSource(source)).toBeNull()
  })

  it("adds the source as the only new parameter and keeps the rest of the link", () => {
    expect(withAppLinkSource("https://www.tenuvault.com/setup-call", "welcome")).toBe("https://www.tenuvault.com/setup-call?src=app-welcome")
    expect(withAppLinkSource("https://www.tenuvault.com/setup-call?plan=pro&src=old#times", "support")).toBe("https://www.tenuvault.com/setup-call?plan=pro&src=app-support#times")
  })

  it.each(INVALID)("leaves the link as it is for the invalid source %j", (source) => {
    expect(withAppLinkSource("https://www.tenuvault.com/setup-call#times", source)).toBe("https://www.tenuvault.com/setup-call#times")
  })

  // The licensing module keeps its own copy of the pattern, so the two are compared here.
  it.each(["welcome", "license-page-trial", "a", "7", "a".repeat(40), ...INVALID])("agrees with the pricing and checkout links for %j", (source) => {
    expect(licenseBuyUrl("https://tenuvault.com/desktop#pricing", source)).toBe(withAppLinkSource("https://tenuvault.com/desktop#pricing", source))
    expect(new URL(licenseCheckoutUrl("https://www.tenuvault.com", "pro", source)).searchParams.get("src")).toBe(appLinkSource(source))
  })
})

describe("setup call link", () => {
  it("opens the page on the canonical host, over https and without a query of its own", () => {
    const url = new URL(SETUP_CALL_URL)
    expect(url.href).toBe("https://www.tenuvault.com/setup-call")
    expect(url.search).toBe("")
    expect(url.hash).toBe("")
  })

  it.each([
    ["welcome", "https://www.tenuvault.com/setup-call?src=app-welcome"],
    ["setup-header", "https://www.tenuvault.com/setup-call?src=app-setup-header"],
    ["signin-waiting", "https://www.tenuvault.com/setup-call?src=app-signin-waiting"],
    ["setup-error", "https://www.tenuvault.com/setup-call?src=app-setup-error"],
    ["signin-error", "https://www.tenuvault.com/setup-call?src=app-signin-error"],
    ["first-backup-error", "https://www.tenuvault.com/setup-call?src=app-first-backup-error"],
    ["support", "https://www.tenuvault.com/setup-call?src=app-support"],
  ] as const)("names the screen %s and nothing else", (source, expected) => {
    expect(setupCallUrl(source)).toBe(expected)
    expect([...new URL(setupCallUrl(source)).searchParams.keys()]).toEqual(["src"])
  })

  it.each(INVALID)("falls back to the untagged page for the invalid source %j", (source) => {
    expect(setupCallUrl(source as SetupCallSource)).toBe("https://www.tenuvault.com/setup-call")
  })
})
