import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("production Content Security Policy", () => {
  it("loads images only from self, data and blob", () => {
    const config = readFileSync(new URL("../electron.vite.config.ts", import.meta.url), "utf8")
    const imgSrc = /"img-src ([^"]*)"/.exec(config)?.[1]
    expect(imgSrc).toBe("'self' data: blob:")
  })
})
