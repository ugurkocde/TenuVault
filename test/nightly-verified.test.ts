import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// The release workflow runs this script with plain Node.
type Status = { context: string; state: string; description?: string; target_url?: string; creator?: { login: string } }
const load = async () => (await import("../.github/scripts/nightly-verified.mjs" as string)) as {
  STATUS_CONTEXT: string
  verificationProblems: (statuses: Status[], repository: string, sha: string) => string[]
}

const REPO = "ugurkocde/TenuVault"
const SHA = "1419e55bc5b4bea2e0c390b390079b610649510d"
const status = (state: string, overrides: Partial<Status> = {}): Status => ({
  context: "Nightly verification",
  state,
  description: "v0.5.3-nightly.20261114180404",
  target_url: `https://github.com/${REPO}/actions/runs/123`,
  creator: { login: "github-actions[bot]" },
  ...overrides,
})

describe("nightly verification gate", () => {
  it("passes a commit whose newest verification succeeded", async () => {
    const { verificationProblems, STATUS_CONTEXT } = await load()
    expect(STATUS_CONTEXT).toBe("Nightly verification")
    expect(verificationProblems([status("success")], REPO, SHA)).toEqual([])
    // A rerun that passed replaces an earlier failure; the API lists the newest first.
    expect(verificationProblems([status("success"), status("failure")], REPO, SHA)).toEqual([])
    // Other contexts do not count.
    expect(verificationProblems([{ ...status("failure"), context: "ci" }, status("success")], REPO, SHA)).toEqual([])
  })

  it("refuses a commit without a verification", async () => {
    const { verificationProblems } = await load()
    expect(verificationProblems([], REPO, SHA)).toEqual([
      "1419e55 has no nightly verification. Run it for the commit's nightly: gh workflow run nightly-verification.yml -f tag=<nightly tag>.",
    ])
    expect(verificationProblems([{ ...status("success"), context: "Licensing canary" }], REPO, SHA)).toHaveLength(1)
  })

  it("refuses a failed, running or newer failed verification", async () => {
    const { verificationProblems } = await load()
    expect(verificationProblems([status("failure")], REPO, SHA)).toEqual([
      `1419e55: the newest nightly verification ended with failure (v0.5.3-nightly.20261114180404, https://github.com/${REPO}/actions/runs/123).`,
    ])
    expect(verificationProblems([status("pending")], REPO, SHA)[0]).toContain("is still running")
    // A cancelled verification is recorded as error and is not a pass.
    expect(verificationProblems([status("error"), status("success")], REPO, SHA)[0]).toContain("did not finish, a check was cancelled or skipped")
    expect(verificationProblems([status("failure"), status("success")], REPO, SHA)).toHaveLength(1)
  })

  it("refuses a status the workflow did not set", async () => {
    const { verificationProblems } = await load()
    expect(verificationProblems([status("success", { creator: { login: "someone" } })], REPO, SHA)).toEqual([
      "1419e55: the nightly verification status was set by someone, not by the workflow.",
    ])
    expect(verificationProblems([status("success", { target_url: "https://example.com/run" })], REPO, SHA)).toEqual([
      `1419e55: the nightly verification status does not link to a workflow run of ${REPO}.`,
    ])
  })

  it("uses the canary's tenant in the installed app's paid key check", () => {
    const tenant = (file: string) => /CANARY_TENANT = "([0-9a-f-]{36})"/.exec(readFileSync(resolve(import.meta.dirname, "..", file), "utf8"))?.[1]
    expect(tenant("scripts/nightly-verification/license.mjs")).toBeDefined()
    expect(tenant("scripts/nightly-verification/license.mjs")).toBe(tenant("scripts/license-canary.ts"))
  })

  it("records and checks the same status context", () => {
    const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/nightly-verification.yml"), "utf8")
    expect(workflow.match(/context="Nightly verification"/g)).toHaveLength(2)
  })
})
