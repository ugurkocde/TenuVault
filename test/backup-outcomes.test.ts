import { describe, expect, it } from "vitest"
import { graphAnswer, graphFailure } from "../src/main/backup/request"
import { classifyAnswer, coverageOf, manifestCoverage, manifestOutcomes, nothingRead, nothingReadReason, signInRefused, skipReason, type SkipCause, type TypeOutcome } from "../src/shared/backup-outcomes"
import { ENTRA_5B_TYPES } from "../src/shared/intune/entra"
import { GRAPH_ANSWERS, NOT_CONFIGURED_ANSWERS } from "./fixtures/graph-answers"

const verdict = (expected: string) => (expected === "failed" ? { outcome: "failed" } : { outcome: "skipped", cause: expected })

describe("what a refused Microsoft Graph read means for its type", () => {
  it.each(GRAPH_ANSWERS)("$name ($status, $source)", (fixture) => {
    const answer = { status: fixture.status, ...graphAnswer(fixture.body) }
    expect(graphAnswer(fixture.body)).toEqual(fixture.answer)
    const unavailable = fixture.endpoint === "v1.0/identity/authenticationEventsFlows" ? ENTRA_5B_TYPES.find(type => type.folder === "AuthenticationEventsFlows")!.unavailable : undefined
    expect(classifyAnswer(answer, { unavailable, held: true, mode: "delegated" })).toEqual(verdict(fixture.expect.delegatedHeld))
    // The Backup Reader has no role to lack, and a token that could not be read proves no permission.
    expect(classifyAnswer(answer, { unavailable, held: true, mode: "app-only" })).toEqual(verdict(fixture.expect.otherwise))
    expect(classifyAnswer(answer, { unavailable, held: false, mode: "delegated" })).toEqual(verdict(fixture.expect.otherwise))
    expect(classifyAnswer(answer, { unavailable, mode: "delegated" })).toEqual(verdict(fixture.expect.otherwise))
  })

  it.each(NOT_CONFIGURED_ANSWERS)("$name is not configured only for the type that declares it", (fixture) => {
    const answer = { status: fixture.status, ...graphAnswer(fixture.body) }
    expect(classifyAnswer(answer, { notConfigured: fixture.declared, mode: "delegated" })).toEqual({ outcome: "notConfigured" })
    expect(classifyAnswer(answer, { mode: "delegated" })).toEqual({ outcome: "failed" })
    // The same status with another code or message is not the declared answer.
    expect(classifyAnswer({ status: fixture.status, code: "Other", message: "Something else" }, { notConfigured: fixture.declared, mode: "delegated" })).toEqual({ outcome: "failed" })
  })

  it("covers every answer the live research recorded for Entra ID and Defender", () => {
    // 403 naming roles, an empty 403, a 401 HTML page, "tenant is not onboarded", "account is not active" and a 404 on an unset singleton (design.md).
    const names = [...GRAPH_ANSWERS, ...NOT_CONFIGURED_ANSWERS].map((fixture) => fixture.name).join("\n")
    for (const needed of ["application roles named", "no body at all", "HTML page", "never onboarded", "not active", "never set"]) expect(names).toContain(needed)
  })

  it("never calls a server error or a throttle a missing permission", () => {
    for (const status of [400, 404, 409, 429, 500, 502, 503]) expect(classifyAnswer({ status, message: "Something went wrong" }, { held: true, mode: "delegated" })).toEqual({ outcome: "failed" })
  })
})

describe("a sign-in Microsoft no longer accepts", () => {
  it("is a 401 that names a token error, and nothing else", () => {
    expect(signInRefused({ status: 401, code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." })).toBe(true)
    expect(signInRefused({ status: 401, message: "Lifetime validation failed, the token is expired." })).toBe(true)
    expect(signInRefused({ status: 401, code: "Unauthorized", message: "Access token validation failure." })).toBe(true)
    // An HTML page, an endpoint that takes no app-only call, and the same words under another status.
    expect(signInRefused({ status: 401 })).toBe(false)
    expect(signInRefused({ status: 401, code: "AccessDenied", message: "Unsupported app-only call." })).toBe(false)
    expect(signInRefused({ status: 403, code: "InvalidAuthenticationToken", message: "Access token has expired." })).toBe(false)
  })
})

describe("the error of a failed Graph response", () => {
  it("keeps the message Intune backups always showed and adds what Graph answered", async () => {
    const error = await graphFailure(Response.json({ error: { code: "Forbidden", message: "No role" } }, { status: 403 }))
    expect(error.message).toBe("Access denied by Microsoft Graph: No role. Check that your account has an Intune role and the app registration has the Intune permissions.")
    expect(error).toMatchObject({ status: 403, answer: { code: "Forbidden", message: "No role" } })
    const html = await graphFailure(new Response("<html>401</html>", { status: 401 }))
    expect(html.message).toBe("Microsoft Graph returned 401")
    expect(html.answer).toEqual({})
    expect((await graphFailure(Response.json({ error: { message: "Bad" } }, { status: 400 }))).message).toBe("Bad")
  })

  it("reads no code or message from a body that is not an error object", () => {
    for (const body of ["", "null", "[]", "42", '{"error":"text"}', '{"error":{"code":5,"message":null}}']) expect(graphAnswer(body)).toEqual({})
  })
})

describe("coverage", () => {
  const base = { folder: "A", service: "entra" as const }
  const outcomes: TypeOutcome[] = [
    { ...base, outcome: "saved", saved: 3 },
    { ...base, folder: "B", outcome: "notConfigured" },
    { ...base, folder: "C", outcome: "skipped", cause: "license", reason: "Not set up.", status: 403, code: "Forbidden" },
    { ...base, folder: "D", outcome: "skipped", cause: "permission", reason: "No permission.", reader: true },
    { ...base, folder: "E", outcome: "failed", error: "Timed out", saved: 2 },
  ]

  it("is complete only when every selected type was saved or found not configured", () => {
    expect(coverageOf([])).toBe("complete")
    expect(coverageOf(outcomes.slice(0, 2))).toBe("complete")
    for (const missing of outcomes.slice(2)) expect(coverageOf([...outcomes.slice(0, 2), missing])).toBe("incomplete")
  })

  it("is written to the manifest with each type's outcome, and read back from it", () => {
    const written = manifestOutcomes(outcomes)
    expect(written).toEqual([
      { Folder: "A", Outcome: "saved", Saved: 3 },
      { Folder: "B", Outcome: "notConfigured" },
      { Folder: "C", Outcome: "skipped", Cause: "license", Reason: "Not set up.", Status: 403, Code: "Forbidden" },
      { Folder: "D", Outcome: "skipped", Cause: "permission", Reason: "No permission.", Reader: true },
      { Folder: "E", Outcome: "failed", Saved: 2, Error: "Timed out" },
    ])
    expect(manifestCoverage({ Coverage: "Incomplete", Outcomes: written })).toEqual({ coverage: "incomplete", notRead: ["C", "D", "E"] })
    expect(manifestCoverage({ Coverage: "Complete", Outcomes: written.slice(0, 2) })).toEqual({ coverage: "complete", notRead: [] })
  })

  it("is unknown for a backup made before it was recorded, or with a damaged record", () => {
    expect(manifestCoverage({ Status: "Success" } as never)).toEqual({ coverage: null, notRead: [] })
    expect(manifestCoverage(null)).toEqual({ coverage: null, notRead: [] })
    expect(manifestCoverage({ Coverage: "yes", Outcomes: [null, "x", { Folder: 5, Outcome: "failed" }, { Folder: "F", Outcome: "failed" }] })).toEqual({ coverage: null, notRead: ["F"] })
  })
})

describe("a backup that read nothing", () => {
  const base = { folder: "A", service: "entra" as const }
  const leftOut = (cause: SkipCause, saved?: number): TypeOutcome => ({ ...base, outcome: "skipped", cause, reason: "Left out.", ...(saved ? { saved } : {}) })
  const context = { mode: "delegated" as const, settingsPage: "Services and permissions" }

  it("selected at least one type, read none of them and holds no object", () => {
    expect(nothingRead([leftOut("license")])).toBe(true)
    expect(nothingRead([leftOut("license"), leftOut("permission"), { ...base, outcome: "failed", error: "Broken", saved: 0 }])).toBe(true)
    // No type was selected, so there was nothing to read.
    expect(nothingRead([])).toBe(false)
    // A type that is empty or was never set up is an answer from the tenant.
    expect(nothingRead([leftOut("license"), { ...base, outcome: "saved", saved: 0 }])).toBe(false)
    expect(nothingRead([leftOut("license"), { ...base, outcome: "notConfigured" }])).toBe(false)
    // Objects saved before a type ended are in the backup.
    expect(nothingRead([leftOut("license"), leftOut("permission", 2)])).toBe(false)
    expect(nothingRead([{ ...base, outcome: "failed", error: "1 of 3 could not be saved.", saved: 2 }])).toBe(false)
  })

  it.each<[SkipCause, string]>([
    ["permission", "Nothing could be read. Every selected type was left out because the TenuVault app registration may lack the permission or its admin consent. Services and permissions in Settings shows what is missing."],
    ["role", "Nothing could be read. Every selected type was left out because your account may have no role that can read it."],
    ["license", "Nothing could be read. Every selected type was left out because the tenant has no license for the product or never set it up."],
    ["appOnly", "Nothing could be read. Every selected type was left out because it needs the Backup Reader; a signed-in admin cannot read it."],
    ["signedIn", "Nothing could be read. Every selected type was left out because only a signed-in admin can read it."],
  ])("says so and names the cause %s when every type shares it", (cause, expected) => {
    expect(nothingReadReason([leftOut(cause), leftOut(cause)], context)).toBe(expected)
  })

  it("names the cause most types share, the one an admin can fix first on a tie, and the Backup Reader in its run", () => {
    expect(nothingReadReason([leftOut("permission"), leftOut("license"), leftOut("license")], context)).toBe("Nothing could be read. Every selected type was left out, most of them because the tenant has no license for the product or never set it up.")
    expect(nothingReadReason([leftOut("license"), leftOut("role")], context)).toContain("most of them because your account may have no role")
    expect(nothingReadReason([leftOut("signedIn")], { ...context, mode: "app-only" })).toBe("Nothing could be read. The selected type was left out because only a signed-in admin can read it.")
    expect(nothingReadReason([leftOut("permission"), leftOut("permission")], { ...context, mode: "app-only" })).toContain("because the Backup Reader may lack the permission")
  })
})

describe("the reason shown for a type that was left out", () => {
  const context = { service: "Defender", roles: "Security Reader or Global Reader to back up; Security Administrator to restore.", mode: "delegated" as const, settingsPage: "Services and permissions" }

  it("names the cause in plain words and quotes what Microsoft answered", () => {
    expect(skipReason("license", context, "Tenant is not onboarded to Microsoft Defender for Identity.")).toBe('This tenant is not set up for it: "Tenant is not onboarded to Microsoft Defender for Identity.". Microsoft answers this when the product has no license in the tenant or was never set up.')
    expect(skipReason("role", context)).toBe("Microsoft refused the read although the permission is granted. Your account may not have a role that can read Defender (Security Reader or Global Reader to back up).")
    expect(skipReason("permission", context)).toBe("Microsoft refused the read. The TenuVault app registration may lack the permission or admin consent for it. Services and permissions in Settings shows what is missing.")
    expect(skipReason("permission", { ...context, mode: "app-only" })).toContain("The Backup Reader may lack the permission")
    expect(skipReason("signedIn", context)).toBe("Microsoft Graph lets only a signed-in admin read this type, so the Backup Reader leaves it out. Manual backups include it.")
  })

  it("shortens a long answer and keeps it on one line", () => {
    const reason = skipReason("permission", context, `Missing application roles.\r\n API required roles: A,B, application roles: ${"X.Read.All,".repeat(80)}`)
    expect(reason).toContain('"Missing application roles. API required roles: A,B, application roles: ')
    expect(reason.length).toBeLessThan(520)
    expect(reason).not.toMatch(/[\r\n]/)
  })
})
