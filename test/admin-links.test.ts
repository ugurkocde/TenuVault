import { describe, expect, it } from "vitest"
import { adminCenterLink, inTenant } from "../src/shared/intune/admin-links"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import type { GraphCall } from "../src/portal/lib/policies/graph-restore"

const ID = "0b699fa4-3779-4688-ba56-f9d2df52c25e"

describe("Admin center links for restored objects", () => {
  it("links every type TenuVault restores", () => {
    for (const type of INTUNE_TYPES) expect(adminCenterLink(type.folder, ID), type.folder).toBeDefined()
  })

  it("opens a settings catalog or endpoint security policy with its platform, technologies and template", () => {
    expect(adminCenterLink("ConfigurationPolicies", ID, { platforms: "windows10", technologies: "mdm,microsoftSense", templateReference: { templateId: "6078910e-d808-4a9f-a51d-1b8a7bacb7c0_1" } })?.url)
      .toBe(`https://intune.microsoft.com/#view/Microsoft_Intune_Workflows/PolicySummaryBlade/policyId/${ID}/isAssigned~/false/technology/mdm%2CmicrosoftSense/templateId/6078910e-d808-4a9f-a51d-1b8a7bacb7c0_1/platformName/windows10`)
  })

  it("opens legacy profiles and compliance policies on the same page with their own journey", () => {
    expect(adminCenterLink("DeviceConfigurations", ID)?.url).toMatch(/ConfigurationMenuBlade\/~\/properties\/configurationId\/.+\/policyJourneyState~\/0$/)
    expect(adminCenterLink("CompliancePolicies", ID)?.url).toMatch(/policyJourneyState~\/1$/)
  })

  it("names the app protection type and the remediation, which those pages need", () => {
    expect(adminCenterLink("AppProtectionWindows", "I_1", { displayName: "Windows MAM" })?.url)
      .toBe("https://intune.microsoft.com/#view/Microsoft_Intune/PolicyInstanceMenuBlade/~/0/policyId/I_1/policyOdataType/%23microsoft.graph.windowsManagedAppProtection/policyName/Windows%20MAM")
    expect(adminCenterLink("Remediations", ID, { displayName: "Disk / Cleanup" })?.url).toContain("/scriptName/Disk%20%2F%20Cleanup/isFirstParty~/false")
  })

  it("opens the list for types whose page cannot be linked, and says so", () => {
    expect(adminCenterLink("GroupPolicyConfigurations", ID)).toEqual({ url: "https://intune.microsoft.com/#view/Microsoft_Intune_DeviceSettings/DevicesMenu/~/configuration", center: "Intune", exact: false })
    expect(adminCenterLink("EnrollmentConfigurations", ID, { "@odata.type": "#microsoft.graph.deviceEnrollmentLimitConfiguration" })?.url).toMatch(/deviceLimitEnrollmentRestrictions$/)
    expect(adminCenterLink("NamedLocations", ID)?.center).toBe("Entra")
  })

  it("opens a link in the tenant the object is in", () => {
    expect(inTenant("https://intune.microsoft.com/#view/Microsoft_Intune_Apps/SettingsMenu/~/0/appId/a", "t-1")).toBe("https://intune.microsoft.com/#@t-1/view/Microsoft_Intune_Apps/SettingsMenu/~/0/appId/a")
    expect(inTenant("https://intune.microsoft.com/#view/x", undefined)).toBe("https://intune.microsoft.com/#view/x")
  })
})

describe("Admin center links on restore outcomes", () => {
  it("names a copy by its [Restored] name even when Graph answers with only the ID", async () => {
    const { Restorer } = await import("../src/portal/lib/policies/graph-restore")
    const graph: GraphCall = async (method): ReturnType<GraphCall> => {
      if (method === "GET") return { status: 404, body: {} }
      return { status: 201, body: { id: "new-1" } }
    }
    const outcome = await new Restorer(graph, { mode: "copy", assignments: false })
      .restore("b/Remediations/Disk.json", { id: "old", displayName: "Disk Cleanup", detectionScriptContent: "", remediationScriptContent: "" })
    expect(outcome.success).toBe(true)
    expect(outcome.adminLink?.url).toContain("/id/new-1/scriptName/%5BRestored%5D%20Disk%20Cleanup/")
  })
})
