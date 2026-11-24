import { expect, it } from "vitest"
import { typeForFolder } from "../src/shared/intune/registry"
import { MODULE_BY_ID } from "../src/shared/services/modules"
import { servicePack } from "../src/shared/services/permission-packs"

const expanded = process.env.TENUVAULT_LAB_EXPANDED_ENTRA === "1"

it(`uses the ${expanded ? "expanded" : "stable"} Entra scope in e2e mode`, () => {
  if (expanded) {
    expect(MODULE_BY_ID.get("entra")?.areas.map(area => area.id)).toEqual([
      "tenantSettings", "authentication", "externalIdentities", "roles", "governance", "groups", "usersAndDevices", "applications",
    ])
    expect(typeForFolder("Users")?.folder).toBe("Users")
  } else {
    expect(servicePack("entra", "backup").scopes).toEqual(["Agreement.Read.All", "AuthenticationContext.Read.All", "Policy.Read.All"])
    expect(typeForFolder("Users")).toBeUndefined()
  }
})
