import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it("inventories the entire onboarding flow at 1024px in both themes", () => {
  const folder = new URL("../docs-site/public/images/onboarding/", import.meta.url)
  const inventory = readFileSync(new URL("README.md", folder), "utf8")
  for (const state of ["01-welcome-start", "02-choice-default", "03-choice-entra-details", "04-choice-defender-details", "04-choice-both-details", "05-choice-personal-data", "06-choice-customize", "07-choice-intune-entra", "08-choice-entra-only", "09-connect-quick", "09-connect-script", "09-connect-manual", "09-connect-handoff", "09-connect-existing", "10-permissions-missing", "10-storage-local", "11-backup-intune", "11-backup-first", "12-intune-required"]) {
    for (const theme of ["light", "dark"]) {
      const name = `${state}-${theme}.png`
      expect(inventory).toContain(name)
      const image = readFileSync(new URL(name, folder))
      expect(image.readUInt32BE(16), name).toBe(1024)
      expect(image.length, name).toBeGreaterThan(20_000)
    }
  }
})
