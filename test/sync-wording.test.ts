import { describe, expect, it } from "vitest"
import { copyWording } from "../src/shared/sync-wording"

describe("copyWording", () => {
  it("rewrites text stored by the version that called the feature Sync", () => {
    expect(copyWording("Sync 3 policies from Contoso Lab")).toBe("Copy 3 policies from Contoso Lab")
    expect(copyWording("Sync 1 policy from Contoso Lab")).toBe("Copy 1 policy from Contoso Lab")
    expect(copyWording("Already in sync, nothing to write.")).toBe("Already up to date, nothing to write.")
    expect(copyWording("1 of 3 targets planned, 2 already in sync.")).toBe("1 of 3 targets planned, 2 already up to date.")
    expect(copyWording('"Defender B", which an earlier Sync wrote "Defender" to, no longer exists in this tenant. This Sync creates a new policy.'))
      .toBe('"Defender B", which an earlier copy wrote "Defender" to, no longer exists in this tenant. This copy creates a new policy.')
    expect(copyWording('An earlier sync of "Defender" to this tenant has an unconfirmed result. Syncing again may create a second copy. Retry that sync first so TenuVault can check.'))
      .toBe('An earlier copy of "Defender" to this tenant has an unconfirmed result. Copying again may create a second policy. Retry that copy first so TenuVault can check.')
  })

  it("rewrites rollback titles and joined stale reasons from the earlier version", () => {
    expect(copyWording("Rollback of Sync 2 policies from Contoso Lab")).toBe("Rollback of Copy 2 policies from Contoso Lab")
    expect(copyWording('Another Sync linked "A" to a different policy in this tenant after this plan. Plan again. The Sync links this plan relied on for "B" were not recorded. Plan again.'))
      .toBe('Another copy linked "A" to a different policy in this tenant after this plan. Plan again. The copy links this plan relied on for "B" were not recorded. Plan again.')
    expect(copyWording('Another Sync wrote "A" to this tenant after this plan, so applying it would create a second policy. Plan again.'))
      .toBe('Another copy wrote "A" to this tenant after this plan, so applying it would create a second policy. Plan again.')
  })

  it("never rewrites a tenant or policy name", () => {
    expect(copyWording("Sync 1 policy from UK, 2 already in sync")).toBe("Copy 1 policy from UK, 2 already in sync")
    expect(copyWording("1 of 3 targets planned, 2 already in sync, 1 blocked by findings.")).toBe("1 of 3 targets planned, 2 already up to date, 1 blocked by findings.")
  })

  it("leaves current and admin-written text alone", () => {
    for (const text of ["Copy 3 policies from Contoso Lab", "Sync the Defender baseline", "Rollout of Sync settings", "Intune device sync"]) expect(copyWording(text)).toBe(text)
  })
})
