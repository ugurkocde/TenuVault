import { describe, expect, it } from "vitest"
import { SUPPORT_EMAIL } from "../src/shared/constants"
import { FEEDBACK_MAILTO_MAX, FEEDBACK_PAGE_LABELS, feedbackDiagnostics, feedbackMailto, feedbackPageLabel, feedbackTextProblem, isValidFeedbackEmail, knownFeedbackPage, type FeedbackContext } from "../src/shared/feedback"

const TENANT = "11111111-2222-4333-8444-555555555555"
const context: FeedbackContext = { appVersion: "0.4.1", os: "win32", osVersion: "10.0.26100", plan: "pro" }

describe("feedbackPageLabel", () => {
  it.each([
    ["/portal/drift", "Drift Detection"],
    ["/portal/backup", "Backup & Restore"],
    ["/portal/frameworks/cis-benchmarks", "CIS Benchmarks"],
    ["/portal/frameworks/cis-benchmarks/windows-11", "CIS Benchmarks"],
    ["/portal/frameworks/iso-27001", "Frameworks"],
    [`/portal/baselines/${TENANT}`, "My baselines"],
    ["/portal/governance/standards", "Governance"],
    ["/license", "License"],
  ])("names %s as %s", (pathname, label) => {
    expect(feedbackPageLabel(pathname)).toBe(label)
  })

  it("is undefined for unknown routes and never matches a partial segment", () => {
    expect(feedbackPageLabel("/portal")).toBeUndefined()
    expect(feedbackPageLabel("/portal/driftwood")).toBeUndefined()
  })

  it("only has short labels without IDs or slashes", () => {
    for (const label of FEEDBACK_PAGE_LABELS) {
      expect(label.length).toBeLessThanOrEqual(80)
      expect(label).not.toMatch(/[/?=]|\d{4}/)
    }
  })
})

describe("knownFeedbackPage", () => {
  it("keeps only the fixed section names", () => {
    expect(knownFeedbackPage("Drift Detection")).toBe("Drift Detection")
    expect(knownFeedbackPage(`/portal/drift?tenant=${TENANT}`)).toBeUndefined()
    expect(knownFeedbackPage(42)).toBeUndefined()
    expect(knownFeedbackPage(undefined)).toBeUndefined()
  })
})

describe("isValidFeedbackEmail", () => {
  it("accepts what zod's email rule accepts", () => {
    for (const address of ["admin@contoso.com", "first.last+tag@mail.contoso.co.uk", "o'brien@example.com", "a_b-c@sub-domain.example.org"]) {
      expect(isValidFeedbackEmail(address), address).toBe(true)
    }
  })

  it("rejects what zod's email rule rejects", () => {
    for (const address of [".admin@example.com", "a..b@example.com", "admin@example.c", "admin.@example.com", "admin@-example.com", "admin@contoso", "admin contoso.com", "admin@exa mple.com", "\u00e9mile@example.com"]) {
      expect(isValidFeedbackEmail(address), address).toBe(false)
    }
    expect(isValidFeedbackEmail(`${"a".repeat(250)}@x.io`)).toBe(false)
  })
})

describe("feedbackTextProblem", () => {
  it("refuses NUL and unpaired surrogates, as the service does", () => {
    expect(feedbackTextProblem("a\u0000b")).toBe("Remove unsupported characters.")
    expect(feedbackTextProblem("a\uD83D")).toBe("Remove unsupported characters.")
    expect(feedbackTextProblem("\uDE00a")).toBe("Remove unsupported characters.")
  })

  it("allows line breaks, tabs and complete emoji", () => {
    expect(feedbackTextProblem("line one\n\tline two \u{1F600}")).toBeUndefined()
  })
})

describe("feedbackDiagnostics", () => {
  it("lists version, operating system, plan and page", () => {
    expect(feedbackDiagnostics(context, "Tenants")).toEqual([
      { label: "App version", value: "0.4.1" },
      { label: "Operating system", value: "Windows 10.0.26100" },
      { label: "Plan", value: "Pro" },
      { label: "Page", value: "Tenants" },
    ])
    expect(feedbackDiagnostics({ appVersion: "0.4.1", os: "darwin", plan: "none" }, undefined)).toEqual([
      { label: "App version", value: "0.4.1" },
      { label: "Operating system", value: "macOS" },
      { label: "Plan", value: "No license" },
    ])
  })
})

describe("feedbackMailto", () => {
  const decode = (url: string) => {
    const parsed = new URL(url)
    return { to: parsed.pathname, subject: parsed.searchParams.get("subject"), body: parsed.searchParams.get("body") ?? "" }
  }

  it("addresses support with both answers and the diagnostics", () => {
    const url = feedbackMailto({ goal: "Restore a policy", blocker: "It failed", context, page: "Backup & Restore" })
    const mail = decode(url)
    expect(mail.to).toBe(SUPPORT_EMAIL)
    expect(mail.subject).toBe("TenuVault feedback")
    expect(mail.body).toContain("Restore a policy")
    expect(mail.body).toContain("It failed")
    expect(mail.body).toContain("App version: 0.4.1")
    expect(mail.body).toContain("Page: Backup & Restore")
  })

  it("shortens long answers so the link stays short, without splitting characters", () => {
    const url = feedbackMailto({ goal: "\u{1F600}".repeat(500), blocker: "é".repeat(500), context, page: "Tenants" })
    expect(url.length).toBeLessThanOrEqual(FEEDBACK_MAILTO_MAX)
    const mail = decode(url)
    expect(mail.body).toContain("...")
    expect(mail.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(mail.body).toContain("Plan: Pro")
  })

  it("never throws on unpaired surrogates or NUL", () => {
    let url = ""
    expect(() => { url = feedbackMailto({ goal: "Restore \uD83D", blocker: "It\u0000 failed \uDE00", context, page: "Tenants" }) }).not.toThrow()
    const body = decode(url).body
    expect(body).toContain("Restore \uFFFD")
    expect(body).toContain("It failed \uFFFD")
    expect(() => feedbackMailto({ goal: "\uD83D".repeat(500), blocker: "x", context, page: "Tenants" })).not.toThrow()
  })

  it("works without the context", () => {
    expect(decode(feedbackMailto({ goal: "a", blocker: "b", context: null, page: "Alerts" })).body).toContain("Page: Alerts")
  })
})
