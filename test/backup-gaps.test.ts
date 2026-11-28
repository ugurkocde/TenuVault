import { describe, expect, it } from "vitest"
import { backupGaps, describeMissing } from "../src/main/backup/completeness"

/**
 * The check behind the backup taken before a change set or an OpenIntuneBaseline run writes, and
 * behind reusing a recent backup: does the backup hold the types about to be written?
 */

const CONDITIONAL_ACCESS = ["NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies"]
const success = (scope: { Excluded?: string[]; Included?: string[] }, extra: Record<string, unknown> = {}) => ({ Status: "Success", Failures: 0, Scope: { Excluded: [], ...scope }, SkippedTypes: [], FailedTypes: [], ...extra })

describe("types a backup never attempted", () => {
  it("counts the types of a service that is off for the tenant as missing, although the run succeeded", () => {
    // Intune off: the run records the Conditional Access folders only, and no reason for the rest.
    const gaps = backupGaps(success({ Included: CONDITIONAL_ACCESS }), ["DeviceConfigurations", "ConfigurationPolicies"])!
    expect(gaps.succeeded).toBe(true)
    expect(gaps.missing).toEqual([{ reason: "uncovered", folders: ["DeviceConfigurations", "ConfigurationPolicies"] }])
    expect(describeMissing(gaps)).toContain("not part of the backup (the service is turned off for this tenant")
  })

  it("counts Conditional Access types as missing when that service is off", () => {
    const gaps = backupGaps(success({ Included: ["DeviceConfigurations", "ConfigurationPolicies"] }), ["ConfigurationPolicies", "ConditionalAccessPolicies"])!
    expect(gaps.missing).toEqual([{ reason: "uncovered", folders: ["ConditionalAccessPolicies"] }])
  })

  it("finds nothing missing when every written type was attempted and saved", () => {
    expect(backupGaps(success({ Included: ["DeviceConfigurations", "ConfigurationPolicies", ...CONDITIONAL_ACCESS] }), ["DeviceConfigurations", "ConditionalAccessPolicies"])!.missing).toEqual([])
  })

  it("keeps the recorded reason for a type and does not report it a second time", () => {
    const metadata = success({ Excluded: ["Apps"], Included: ["DeviceConfigurations", "Apps", "PowerShellScripts", "ScopeTags"] }, { SkippedTypes: ["PowerShellScripts"], FailedTypes: ["ScopeTags"] })
    expect(backupGaps(metadata, ["DeviceConfigurations", "Apps", "PowerShellScripts", "ScopeTags", "ConfigurationPolicies"])!.missing).toEqual([
      { reason: "excluded", folders: ["Apps"] },
      { reason: "skipped", folders: ["PowerShellScripts"] },
      { reason: "failed", folders: ["ScopeTags"] },
      { reason: "uncovered", folders: ["ConfigurationPolicies"] },
    ])
  })

  it("treats a backup from before the attempted types were recorded as covering the types of that time only", () => {
    const legacy = { Status: "Success", Failures: 0, Scope: { Excluded: [] }, SkippedTypes: [], FailedTypes: [] }
    expect(backupGaps(legacy, ["DeviceConfigurations", "ConfigurationPolicies"])!.missing).toEqual([])
    expect(backupGaps(legacy, ["ConditionalAccessPolicies"])!.missing).toEqual([{ reason: "uncovered", folders: ["ConditionalAccessPolicies"] }])
  })

  it("counts a folder the app does not know as missing", () => {
    expect(backupGaps(success({ Included: ["DeviceConfigurations"] }), ["NotAType"])!.missing).toEqual([{ reason: "uncovered", folders: ["NotAType"] }])
  })
})
