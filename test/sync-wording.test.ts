import { describe, expect, it } from "vitest"
import { changeSetTitle, copyMessage, copyTitle } from "../src/shared/sync-wording"

describe("copyTitle", () => {
  it("rewrites the generated prefix of titles from the version that called the feature Sync", () => {
    expect(copyTitle("Sync 3 policies from Contoso Lab")).toBe("Copy 3 policies from Contoso Lab")
    expect(copyTitle("Sync 1 policy from Contoso Lab")).toBe("Copy 1 policy from Contoso Lab")
    expect(copyTitle("Rollback of Sync 2 policies from Contoso Lab")).toBe("Rollback of Copy 2 policies from Contoso Lab")
  })

  it("keeps the tenant name verbatim, whatever it says", () => {
    expect(copyTitle("Sync 1 policy from UK, 2 already in sync")).toBe("Copy 1 policy from UK, 2 already in sync")
    expect(copyTitle('Sync 1 policy from The Sync links this plan relied on for "Defender" were not recorded. Plan again.'))
      .toBe('Copy 1 policy from The Sync links this plan relied on for "Defender" were not recorded. Plan again.')
  })

  it("leaves current and admin-written titles alone", () => {
    for (const text of ["Copy 3 policies from Contoso Lab", "Sync the Defender baseline", "Rollout of Sync settings"]) expect(copyTitle(text)).toBe(text)
  })
})

describe("changeSetTitle", () => {
  it("rewrites only change sets that Copy to Tenants created, including their rollbacks", () => {
    expect(changeSetTitle({ title: "Rollback of Sync 1 policy from Lab", origin: { workflow: "sync" } })).toBe("Rollback of Copy 1 policy from Lab")
    expect(changeSetTitle({ title: "Sync 4 policies from Pilot to Production", origin: { workflow: "promotion" } })).toBe("Sync 4 policies from Pilot to Production")
    expect(changeSetTitle({ title: "Sync 4 policies from Pilot", origin: null })).toBe("Sync 4 policies from Pilot")
  })
})

describe("copyMessage", () => {
  it("rewrites generated summaries, findings and stale reasons", () => {
    expect(copyMessage("Already in sync, nothing to write.")).toBe("Already up to date, nothing to write.")
    expect(copyMessage("1 of 3 targets planned, 2 already in sync, 1 blocked by findings.")).toBe("1 of 3 targets planned, 2 already up to date, 1 blocked by findings.")
    expect(copyMessage('"Defender B", which an earlier Sync wrote "Defender" to, no longer exists in this tenant. This Sync creates a new policy.'))
      .toBe('"Defender B", which an earlier copy wrote "Defender" to, no longer exists in this tenant. This copy creates a new policy.')
    expect(copyMessage('Another Sync wrote "A" to this tenant after this plan, so applying it would create a second policy. Plan again.'))
      .toBe('Another copy wrote "A" to this tenant after this plan, so applying it would create a second policy. Plan again.')
  })

  it("rewrites every sentence of a joined error and keeps names with quotes verbatim", () => {
    expect(copyMessage('Another Sync linked "A" to a different policy in this tenant after this plan. Plan again. The Sync links this plan relied on for "Defender "Pilot"" were not recorded. Plan again.'))
      .toBe('Another copy linked "A" to a different policy in this tenant after this plan. Plan again. The copy links this plan relied on for "Defender "Pilot"" were not recorded. Plan again.')
    expect(copyMessage('An earlier sync of "Defender "Pilot"" to this tenant has an unconfirmed result. Syncing again may create a second copy. Retry that sync first so TenuVault can check.'))
      .toBe('An earlier copy of "Defender "Pilot"" to this tenant has an unconfirmed result. Copying again may create a second policy. Retry that copy first so TenuVault can check.')
  })

  it("leaves other text alone", () => {
    for (const text of ["Intune device sync failed", "Intune answered 403", "Sync 1 policy from Lab"]) expect(copyMessage(text)).toBe(text)
  })
})
