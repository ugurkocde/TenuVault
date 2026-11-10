import { describe, expect, it } from "vitest"
const { expected, inspect } = await import("../.github/scripts/license-inspection-check.mjs" as string) as {
  expected: Record<string, string[]>
  inspect: (mode: string, output: string, code: number) => { pass: boolean; got: string }
}

describe("inspection result validation", () => {
  for (const mode of ["trusted", "untrusted", "blocked"] as const) {
    it(`requires every exact ${mode} result and successful exit`, () => {
      const lines = expected[mode]!
      const output = lines.join("\n")
      expect(inspect(mode, output, 0).pass).toBe(true)
      expect(inspect(mode, lines.slice(1).join("\n"), 0).pass).toBe(false)
      expect(inspect(mode, output.replace("entitled=true", "entitled=false").replace("ERR_CERT_AUTHORITY_INVALID", "other"), 0).pass).toBe(false)
      expect(inspect(mode, output, 1).pass).toBe(false)
      expect(inspect(mode, `${output}\nCHECK FAILED private-value`, 0).pass).toBe(false)
      expect(inspect(mode, `${output}\n${lines[0]}`, 0).pass).toBe(false)
      expect(inspect(mode, `${output}\nCHECK unexpected private-value`, 0).got).not.toContain("private-value")
    })
  }
  it("does not expose state or arbitrary child output", () => {
    const result = inspect("trusted", "STATE private-token\nCHECK FAILED private-key", 1)
    expect(JSON.stringify(result)).not.toContain("private-token")
    expect(JSON.stringify(result)).not.toContain("private-key")
  })
})
