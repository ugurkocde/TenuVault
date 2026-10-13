import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { effectiveRetentionDays } from "../src/shared/plans"
import { standardsViewState } from "../src/renderer/features/standards/state"

describe("effectiveRetentionDays", () => {
  it("keeps the chosen retention on plans with customRetention", () => {
    expect(effectiveRetentionDays(365, "pro")).toBe(365)
    expect(effectiveRetentionDays(0, "msp")).toBe(0)
    expect(effectiveRetentionDays(7, "pro")).toBe(7)
  })

  it("clamps Community and unknown plans to 30 days", () => {
    expect(effectiveRetentionDays(365, "community")).toBe(30)
    expect(effectiveRetentionDays(0, "community")).toBe(30)
    expect(effectiveRetentionDays(14, "community")).toBe(14)
    expect(effectiveRetentionDays(365, null)).toBe(30)
    expect(effectiveRetentionDays(0, null)).toBe(30)
  })
})

describe("standardsViewState", () => {
  it("prefers loading, then error, then empty, then ready", () => {
    expect(standardsViewState({ isLoading: true, hasError: true, standardsCount: 0, adoptionsCount: 0 })).toBe("loading")
    expect(standardsViewState({ isLoading: false, hasError: true, standardsCount: 0, adoptionsCount: 0 })).toBe("error")
    expect(standardsViewState({ isLoading: false, hasError: false, standardsCount: 0, adoptionsCount: 0 })).toBe("empty")
    expect(standardsViewState({ isLoading: false, hasError: false, standardsCount: 1, adoptionsCount: 0 })).toBe("ready")
    expect(standardsViewState({ isLoading: false, hasError: false, standardsCount: 0, adoptionsCount: 2 })).toBe("ready")
  })
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe("shared confirm dialog", () => {
  it("leaves no native confirm in the renderer or portal UI", () => {
    const files = [...sourceFiles("src/renderer"), ...sourceFiles("src/portal")]
      .filter((file) => !file.endsWith("components/ConfirmDialog.tsx"))
    const offenders = files.filter((file) => /window\.confirm\s*\(|(^|[^.\w])confirm\s*\(`/.test(readFileSync(file, "utf8")))
    expect(offenders).toEqual([])
  })
})
