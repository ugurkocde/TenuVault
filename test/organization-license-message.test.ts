import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { ORGANIZATION_LICENSE_MESSAGE } from "../src/shared/constants"
it("keeps the licensed service refusal aligned with the shared UI marker", () => {
  const service = readFileSync(new URL("../src/main/license/service.ts", import.meta.url), "utf8")
  expect(service.match(/\n  licensed: "([^"]+)"/)?.[1]).toBe(ORGANIZATION_LICENSE_MESSAGE)
})
