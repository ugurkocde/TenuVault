import { describe, expect, it } from "vitest"
import { licenseBuyUrl } from "../src/main/license/buy-url"

describe("license buy URL", () => {
  it("puts the source query before the pricing fragment", () => {
    expect(licenseBuyUrl("https://tenuvault.com/desktop#pricing", "license-page")).toBe("https://tenuvault.com/desktop?src=app-license-page#pricing")
  })

  it("preserves other query parameters and replaces an existing source", () => {
    expect(licenseBuyUrl("https://tenuvault.com/desktop?plan=pro&src=old#pricing", "welcome")).toBe("https://tenuvault.com/desktop?plan=pro&src=app-welcome#pricing")
    expect(licenseBuyUrl("https://tenuvault.com/desktop", "second-tenant")).toBe("https://tenuvault.com/desktop?src=app-second-tenant")
  })

  it.each([undefined, null, 123, "", "License-page", "tenant id", "a&tenant=id", "a#pricing", "a".repeat(41), "welcome\n"])("drops an invalid source %s", (source) => {
    const url = "https://tenuvault.com/desktop#pricing"
    expect(licenseBuyUrl(url, source)).toBe(url)
  })

  it("accepts the source length boundaries", () => {
    for (const source of ["a", "a".repeat(40)]) {
      expect(new URL(licenseBuyUrl("https://tenuvault.com/desktop", source)).searchParams.get("src")).toBe(`app-${source}`)
    }
  })
})
