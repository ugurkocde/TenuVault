import { describe, expect, it } from "vitest"

// The release workflow runs this script with plain Node.
const load = async () => (await import("../.github/scripts/license-soak.mjs" as string)) as {
  SOAK_HOURS: number
  nightlyTime: (tag: string) => number | null
  soakProblems: (commits: { sha: string; subject: string }[], nightlies: Map<string, string[]>, now: number) => string[]
}

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const commit = (sha: string) => ({ sha: sha.padEnd(40, "0"), subject: `change ${sha}` })

describe("license soak gate", () => {
  it("reads the build time of a nightly tag only", async () => {
    const { nightlyTime } = await load()
    expect(nightlyTime("v0.4.3-nightly.20261106185141")).toBe(Date.UTC(2026, 10, 6, 18, 51, 41))
    expect(nightlyTime("v0.4.2")).toBeNull()
    expect(nightlyTime("v0.4.3-nightly.20261106.42")).toBeNull()
  })

  it("passes without licensing changes, and once each change spent a day on nightly", async () => {
    const { soakProblems } = await load()
    expect(soakProblems([], new Map(), NOW)).toEqual([])
    const a = commit("aaaaaaa")
    // The first nightly that carried it counts, not the newest.
    expect(soakProblems([a], new Map([[a.sha, ["v0.4.3-nightly.20261107110000", "v0.4.3-nightly.20261106115959"]]]), NOW)).toEqual([])
  })

  it("refuses a change that is on nightly for less than a day", async () => {
    const { soakProblems, SOAK_HOURS } = await load()
    expect(SOAK_HOURS).toBe(24)
    const a = commit("bbbbbbb")
    expect(soakProblems([a], new Map([[a.sha, ["v0.4.3-nightly.20261107000000"]]]), NOW)).toEqual([
      "bbbbbbb (change bbbbbbb) changes licensing and has been on the nightly channel for 12.0 of 24 hours.",
    ])
  })

  it("refuses a change that never shipped in a nightly, as a tag pushed straight from main would", async () => {
    const { soakProblems } = await load()
    const a = commit("ccccccc")
    expect(soakProblems([a], new Map([[a.sha, ["v0.4.3"]]]), NOW)).toEqual([
      "ccccccc (change ccccccc) changes licensing and has not shipped in a nightly yet.",
    ])
  })
})
