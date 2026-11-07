import { describe, expect, it } from "vitest"
import { SUPPORT_EMAIL } from "../src/shared/constants"
import { FEEDBACK_MAILTO_MAX, FEEDBACK_PAGE_LABELS, feedbackDiagnostics, feedbackMailto, feedbackPageLabel, isValidFeedbackEmail, type FeedbackContext } from "../src/shared/feedback"

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

describe("isValidFeedbackEmail", () => {
  it("accepts a normal address and rejects obvious mistakes", () => {
    expect(isValidFeedbackEmail("admin@contoso.com")).toBe(true)
    expect(isValidFeedbackEmail("admin@contoso")).toBe(false)
    expect(isValidFeedbackEmail("admin contoso.com")).toBe(false)
    expect(isValidFeedbackEmail(`${"a".repeat(250)}@x.io`)).toBe(false)
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

  it("works without the context", () => {
    expect(decode(feedbackMailto({ goal: "a", blocker: "b", context: null, page: "Alerts" })).body).toContain("Page: Alerts")
  })
})
