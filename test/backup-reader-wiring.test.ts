import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The Backup Reader tests inject the token calls, so nothing else notices when the main process
// asks the reader for a token before it has checked the tenant's license. A scheduled run asks the
// reader what it leaves out first, so that request must carry the same check as the token requests.
describe("scheduled backup wiring", () => {
  const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8")
  const block = (name: string) => main.match(new RegExp(`\\n        ${name}: async \\(\\) => \\{([\\s\\S]*?)\\n        \\},`))?.[1] ?? ""

  it.each([
    ["excludedTypes", "reader.excludedTypes"],
    ["storage", "reader.storage()"],
  ])("checks the license before the reader's %s request", (name, request) => {
    const body = block(name)
    const license = body.indexOf("await license.requireEntitlement(request.tenantId)")
    expect(license).toBeGreaterThanOrEqual(0)
    expect(body.indexOf(request)).toBeGreaterThan(license)
  })
})
