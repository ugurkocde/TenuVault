import { afterEach, describe, expect, it } from "vitest"
import { deploymentReferenceLabel } from "../src/renderer/features/cis-remediation/CisRemediationHistory"
import { remediationTitle } from "../src/renderer/features/cis-remediation/CisRemediationPanel"
import { clearCisCatalogs, rememberCisCatalog } from "../src/renderer/lib/cis-catalog-cache"
import { levelCheckCounts, levelCheckSummary, type CisLevelReadiness } from "../src/shared/frameworks/cis-readiness"

const TENANT_ID = "11111111-1111-1111-1111-111111111111"

afterEach(() => clearCisCatalogs())

describe("remediation labels", () => {
  it("titles a deployment with the benchmark display name", () => {
    expect(remediationTitle(false, "Synthetic OS Benchmark 9.9.9 Level 1")).toBe("Remediate Synthetic OS Benchmark 9.9.9 Level 1 findings")
    expect(remediationTitle(true, "Synthetic OS Benchmark 9.9.9 Level 2")).toBe("Deploy Synthetic OS Benchmark 9.9.9 Level 2 policies")
    expect(remediationTitle(false, "  ")).toBe("Remediate benchmark findings")
    expect(remediationTitle(true, "x".repeat(400)).length).toBeLessThanOrEqual(200)
    expect(remediationTitle(false, "x".repeat(400)).length).toBeLessThanOrEqual(200)
  })

  it("names a history reference from the loaded catalog, else by the prettified id", () => {
    expect(deploymentReferenceLabel("intune-synthetic-os 9.9.9 Level 1", TENANT_ID)).toBe("Synthetic Os 9.9.9 Level 1")
    rememberCisCatalog(TENANT_ID, [{ id: "intune-synthetic-os", name: "Synthetic OS Benchmark", version: "9.9.9", levels: [1, 2] }] as never)
    expect(deploymentReferenceLabel("intune-synthetic-os 9.9.9 Level 1", TENANT_ID.toUpperCase())).toBe("Synthetic OS Benchmark 9.9.9 Level 1")
    expect(deploymentReferenceLabel("other-os 1.0.0 Level 2", TENANT_ID)).toBe("Other Os 1.0.0 Level 2")
    expect(deploymentReferenceLabel("", TENANT_ID)).toBe("")
    expect(deploymentReferenceLabel("intune-synthetic-os 9.9.9 Level 1", TENANT_ID, "Stamped Pack Name")).toBe("Stamped Pack Name 9.9.9 Level 1")
  })
})

type LevelInput = Pick<CisLevelReadiness, "level" | "recommendations" | "manual" | "assessedAutomated" | "enumerated" | "denominator" | "numeratorIds" | "denominatorIdentifiers">
const rec = (id: string, result: "Pass" | "Fail" | "Not assessed") => ({ id, title: id, level: 1 as const, result, settings: [], findingKeys: [] }) as unknown as CisLevelReadiness["recommendations"][number]
const manual = (identifier: string) => ({ identifier }) as CisLevelReadiness["manual"][number]
const level = (input: Partial<LevelInput>): LevelInput => ({ level: 1, recommendations: [], manual: [], assessedAutomated: null, enumerated: 0, denominator: null, numeratorIds: [], denominatorIdentifiers: [], ...input })

describe("what TenuVault checks per Level", () => {
  it("counts checked recommendations against the manual and unassessed ones", () => {
    const input = level({ recommendations: [rec("1.1", "Pass"), rec("1.2", "Fail"), rec("1.3", "Not assessed")], numeratorIds: ["1.1", "1.2", "1.3"], denominatorIdentifiers: ["1.1", "1.2", "1.3", "1.4", "2.1"], manual: [manual("1.4"), manual("2.1"), manual("2.2")], assessedAutomated: 3, denominator: 4 })
    expect(levelCheckCounts(input)).toEqual({ checked: 2, manual: 3, total: 5 })
    expect(levelCheckSummary(input)).toBe("Level 1: TenuVault checks 2 of 5 recommendations automatically. The other 3 need a manual check.")
  })

  it("counts the total from the denominator when recommendation metadata covers only part of the pack", () => {
    // Denominator 1.1, 1.2, 1.3; the pack names 1.1 and 1.2; metadata maps only 1.1; 1.3 is not assessed.
    const input = level({ recommendations: [rec("1.1", "Pass")], numeratorIds: ["1.1", "1.2"], denominatorIdentifiers: ["1.1", "1.2", "1.3"], manual: [manual("1.3")], assessedAutomated: 2, denominator: 3 })
    expect(levelCheckCounts(input)).toEqual({ checked: 2, manual: 1, total: 3 })
    expect(levelCheckSummary(input)).toBe("Level 1: TenuVault checks 2 of 3 recommendations automatically. The other one needs a manual check.")
  })

  it("says all when a denominator leaves nothing for a manual check", () => {
    expect(levelCheckSummary(level({ recommendations: [rec("1.1", "Pass"), rec("1.2", "Pass")], numeratorIds: ["1.1", "1.2"], denominatorIdentifiers: ["1.1", "1.2"], assessedAutomated: 2, denominator: 2 }))).toBe("Level 1: TenuVault checks all 2 recommendations automatically.")
  })

  it("never invents a total without a denominator", () => {
    const input = level({ recommendations: [rec("1.1", "Pass"), rec("1.2", "Not assessed")] })
    expect(levelCheckCounts(input)).toEqual({ checked: 1, manual: 1, total: null })
    expect(levelCheckSummary(input)).toBe("Level 1: TenuVault checks 1 recommendation of this pack automatically. The other one listed here and any recommendations outside the pack need a manual check.")
    expect(levelCheckSummary(level({ enumerated: 2, manual: [manual("9.1"), manual("9.2")] }))).toBe("Level 1: TenuVault checks 2 recommendations of this pack automatically. The other 2 listed here and any recommendations outside the pack need a manual check.")
  })

  it("states only the checked count without a denominator or manual items", () => {
    expect(levelCheckSummary(level({ level: 2, recommendations: [rec("1.1", "Pass")] }))).toBe("Level 2: TenuVault checks 1 recommendation of this pack automatically. Recommendations outside the pack, including manual ones, need a manual check.")
  })

  it("falls back to identifier counts without pack recommendations", () => {
    expect(levelCheckSummary(level({ assessedAutomated: 3, enumerated: 4, numeratorIds: ["1.1", "1.2", "1.3"], denominatorIdentifiers: ["1.1", "1.2", "1.3", "9.1"], manual: [manual("9.1")], denominator: 4 }))).toBe("Level 1: TenuVault checks 3 of 4 recommendations automatically. The other one needs a manual check.")
    expect(levelCheckSummary(level({ enumerated: 4 }))).toBe("Level 1: TenuVault checks 4 recommendations of this pack automatically. Recommendations outside the pack, including manual ones, need a manual check.")
    // A shown Level whose pack names no identifiers still gets the outside-pack note, without a total.
    expect(levelCheckSummary(level({}))).toBe("Level 1: TenuVault compares the settings of this pack automatically. Recommendations outside the pack, including manual ones, need a manual check.")
  })
})
