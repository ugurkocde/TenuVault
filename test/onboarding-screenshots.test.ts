import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it("inventories the entire onboarding flow at 1024px in both themes", () => {
  const folder = new URL("../docs-site/public/images/onboarding/", import.meta.url)
  const inventory = readFileSync(new URL("README.md", folder), "utf8")
  for (const state of ["02-connect", "03-check", "03-check-entra", "04-missing-permissions", "05-storage", "06-first-backup"]) {
    for (const theme of ["light", "dark"]) {
      const name = `${state}-${theme}.png`
      expect(inventory).toContain(name)
      const image = readFileSync(new URL(name, folder))
      expect(image.readUInt32BE(16), name).toBe(1024)
      expect(image.readUInt32BE(20), name).toBe(768)
      expect(image.length, name).toBeGreaterThan(20_000)
    }
  }
})
