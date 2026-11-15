import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

const storageStates = ["healthy", "local", "notChecked", "unknown", "signInNeeded", "mfaRequired", "blockedByConditionalAccess", "consentMissing", "registrationNotFoundInTenant", "registrationMisconfigured", "applicationDisabled", "servicePrincipalMissing", "notAssigned", "accountDisabled", "accountLockedOrBlocked", "wrongTenantOrAccount", "throttled", "unreachable"]
it("captures and inventories every storage state and changed surface at 1024px in both themes", () => {
  const folder = new URL("../docs-site/public/images/services/", import.meta.url)
  const inventory = readFileSync(new URL("README.md", folder), "utf8")
  for (const state of [...storageStates.map(state => `storage-${state}`), "restore-only-gap", "partly-verified", "missing-permission", "cause-notRead", "overview-intune-off", "dashboard-intune-off", "tenants-intune-off", "tenants-list-intune-off"]) {
    for (const theme of ["light", "dark"]) {
      const file = `${state}-${theme}.png`
      expect(inventory).toContain(file)
      const image = readFileSync(new URL(file, folder))
      expect(image.readUInt32BE(16), file).toBe(1024)
      expect(image.length, file).toBeGreaterThan(20_000)
    }
  }
})
