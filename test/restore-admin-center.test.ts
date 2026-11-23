import { expect, it } from "vitest"
import { restoreAdminCenter } from "../src/shared/services/presentation"

it.each([
  ["NamedLocations", "the Microsoft Entra admin center"],
  ["backup-1/NamedLocations/corporate.json", "the Microsoft Entra admin center"],
  ["https://graph.microsoft.com/beta/identity/conditionalAccess/namedLocations/id", "the Microsoft Entra admin center"],
  ["/beta/groups/id", "the Microsoft Entra admin center"],
  ["ConfigurationPolicies", "the Microsoft Intune admin center"],
  ["deviceManagement/templates/id/createInstance", "the Microsoft Intune admin center"],
  ["DefenderSecureScoreControlStates", "the Microsoft Defender portal"],
  ["security/secureScoreControlProfiles/id", "the Microsoft Defender portal"],
  ["unknown/endpoint/id", "the target service’s admin center"],
])("directs recovery for %s to %s", (path, center) => {
  expect(restoreAdminCenter(path)).toBe(center)
})
