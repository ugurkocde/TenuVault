import { describe, expect, it } from "vitest"

// The nightly verification harness and the stable gate run with plain Node.
const loadLeftover = async () => (await import("../scripts/nightly-verification/leftover.mjs" as string)) as {
  releaseLeftover: (steps: { empty: () => boolean; release: () => Promise<boolean>; close: () => Promise<void>; remove: () => void }) => Promise<string>
}
const loadGate = async () => (await import("../.github/scripts/nightly-verified.mjs" as string)) as {
  workflowFileOf: (path: unknown) => string | null
  runProblem: (run: Record<string, unknown>, repository: string) => string | null
}

const REPO = "ugurkocde/TenuVault"
const FILE = ".github/workflows/nightly-verification.yml"

describe("leftover activation release", () => {
  const steps = (empty: boolean, release: () => Promise<boolean>) => {
    const calls: string[] = []
    return {
      calls,
      empty: () => empty,
      release: async () => { calls.push("release"); return release() },
      close: async () => { calls.push("close") },
      remove: () => { calls.push("remove") },
    }
  }

  it("removes the profile after a confirmed release", async () => {
    const { releaseLeftover } = await loadLeftover()
    const run = steps(false, async () => true)
    expect(await releaseLeftover(run)).toBe("released")
    expect(run.calls).toEqual(["release", "close", "remove"])
  })

  it("removes an empty profile without starting the app", async () => {
    const { releaseLeftover } = await loadLeftover()
    const run = steps(true, async () => true)
    expect(await releaseLeftover(run)).toBe("nothing")
    expect(run.calls).toEqual(["remove"])
  })

  it("keeps the profile and fails when the release did not succeed", async () => {
    const { releaseLeftover } = await loadLeftover()
    const refused = steps(false, async () => false)
    await expect(releaseLeftover(refused)).rejects.toThrow("The leftover activation could not be released. The profile is kept")
    expect(refused.calls).toEqual(["release", "close"])
    const crashed = steps(false, async () => { throw new Error("the app did not start") })
    await expect(releaseLeftover(crashed)).rejects.toThrow("The profile is kept")
    expect(crashed.calls).toEqual(["release", "close"])
  })
})

describe("verification run path", () => {
  it("accepts the workflow file without a ref, or with main as the ref", async () => {
    const { workflowFileOf } = await loadGate()
    expect(workflowFileOf(FILE)).toBe(FILE)
    expect(workflowFileOf(`${FILE}@main`)).toBe(FILE)
    expect(workflowFileOf(`${FILE}@refs/heads/main`)).toBe(FILE)
  })

  it("refuses any other ref", async () => {
    const { workflowFileOf } = await loadGate()
    for (const ref of ["ci/nightly-verification", "refs/heads/ci/nightly-verification", "refs/heads/main2", "refs/tags/main", "1419e55bc5b4bea2e0c390b390079b610649510d", "", "main@main"]) {
      expect(workflowFileOf(`${FILE}@${ref}`)).toBeNull()
    }
    expect(workflowFileOf(undefined)).toBeNull()
  })

  it("lets the gate and the supersede check count only main's workflow file", async () => {
    const { runProblem } = await loadGate()
    const run = (path: string) => ({ path, head_branch: "main", event: "workflow_run", repository: { full_name: REPO } })
    expect(runProblem(run(FILE), REPO)).toBeNull()
    expect(runProblem(run(`${FILE}@main`), REPO)).toBeNull()
    expect(runProblem(run(`${FILE}@refs/heads/main`), REPO)).toBeNull()
    expect(runProblem(run(`${FILE}@refs/heads/ci/nightly-verification`), REPO)).toBe(`the run is of ${FILE}@refs/heads/ci/nightly-verification, not ${FILE}`)
    expect(runProblem(run(".github/workflows/ci.yml@main"), REPO)).toContain("not .github/workflows/nightly-verification.yml")
  })
})

describe("supersede check run path", () => {
  it("uses the same rule as the gate for the workflow file's ref", async () => {
    const { supersededBy } = (await import("../.github/scripts/nightly-verification-outcome.mjs" as string)) as {
      supersededBy: (statuses: Record<string, unknown>[], ownRunId: number, repository: string, getRun: (id: number) => Promise<Record<string, unknown>>) => Promise<number | null>
    }
    const status = (id: number) => ({ context: "Nightly verification", target_url: `https://github.com/${REPO}/actions/runs/${id}`, creator: { login: "github-actions[bot]" } })
    const runs: Record<number, string> = { 11: FILE, 12: `${FILE}@main`, 13: `${FILE}@refs/heads/main`, 14: `${FILE}@refs/heads/ci/nightly-verification` }
    const getRun = async (id: number) => ({ id, path: runs[id], head_branch: "main", event: "workflow_dispatch", repository: { full_name: REPO } })
    for (const id of [11, 12, 13]) expect(await supersededBy([status(id)], 10, REPO, getRun)).toBe(id)
    expect(await supersededBy([status(14)], 10, REPO, getRun)).toBeNull()
  })
})
