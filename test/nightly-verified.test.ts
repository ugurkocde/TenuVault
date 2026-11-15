import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// The release workflow runs this script with plain Node.
type Status = { context: string; state: string; description?: string; target_url?: string; creator?: { login: string } }
type Run = { id: number; path?: string; head_branch?: string; event?: string; status?: string; conclusion?: string | null; repository?: { full_name: string } }
type Result = { sha?: string; tag?: string; state?: string; runId?: number }
type Gate = {
  STATUS_CONTEXT: string
  WORKFLOW_PATH: string
  runIdOf: (status: Status, repository: string) => number | null
  verificationProblems: (input: {
    statuses: Status[]
    repository: string
    sha: string
    getRun: (id: number) => Promise<Run>
    getResult: (id: number) => Promise<Result>
  }) => Promise<string[]>
}
const load = async () => (await import("../.github/scripts/nightly-verified.mjs" as string)) as Gate

const REPO = "ugurkocde/TenuVault"
const SHA = "1419e55bc5b4bea2e0c390b390079b610649510d"
const OTHER = "0123456789abcdef0123456789abcdef01234567"
const TAG = "v0.5.3-nightly.20261114180404"
const status = (state: string, runId: number, overrides: Partial<Status> = {}): Status => ({
  context: "Nightly verification",
  state,
  description: TAG,
  target_url: `https://github.com/${REPO}/actions/runs/${runId}`,
  creator: { login: "github-actions[bot]" },
  ...overrides,
})
const mainRun = (id: number, overrides: Partial<Run> = {}): Run => ({
  id,
  path: ".github/workflows/nightly-verification.yml",
  head_branch: "main",
  event: "workflow_run",
  status: "completed",
  conclusion: "success",
  repository: { full_name: REPO },
  ...overrides,
})
const gate = async (statuses: Status[], runs: Run[], results: Record<number, Result> = {}) => {
  const { verificationProblems } = await load()
  const fetched: number[] = []
  const problems = await verificationProblems({
    statuses,
    repository: REPO,
    sha: SHA,
    getRun: async (id) => {
      fetched.push(id)
      const run = runs.find((candidate) => candidate.id === id)
      if (!run) throw new Error(`GitHub answered 404 for run ${id}.`)
      return run
    },
    getResult: async (id) => {
      if (!results[id]) throw new Error(`no result artifact for run ${id}`)
      return results[id]
    },
  })
  return { problems, fetched }
}
const passed = (runId: number): Result => ({ sha: SHA, tag: TAG, state: "success", runId })

describe("nightly verification gate", () => {
  it("reads the run id from a status of this repository only", async () => {
    const { runIdOf, STATUS_CONTEXT, WORKFLOW_PATH } = await load()
    expect(STATUS_CONTEXT).toBe("Nightly verification")
    expect(WORKFLOW_PATH).toBe(".github/workflows/nightly-verification.yml")
    expect(runIdOf(status("success", 42), REPO)).toBe(42)
    expect(runIdOf(status("success", 42, { target_url: `https://github.com/${REPO}/actions/runs/42/attempts/2` }), REPO)).toBe(42)
    expect(runIdOf(status("success", 42, { target_url: "https://github.com/someone/TenuVault/actions/runs/42" }), REPO)).toBeNull()
    expect(runIdOf(status("success", 42, { target_url: "https://example.com/run" }), REPO)).toBeNull()
  })

  it("passes a commit whose newest run from main verified it", async () => {
    expect((await gate([status("success", 10)], [mainRun(10)], { 10: passed(10) })).problems).toEqual([])
    // A dispatched run from main counts as well.
    expect((await gate([status("success", 10)], [mainRun(10, { event: "workflow_dispatch" })], { 10: passed(10) })).problems).toEqual([])
  })

  it("refuses a commit without a verification", async () => {
    expect((await gate([], [])).problems).toEqual([
      "1419e55 has no nightly verification from main. Run it for the commit's nightly: gh workflow run nightly-verification.yml -f tag=<nightly tag>.",
    ])
    expect((await gate([status("success", 10, { context: "Licensing canary" })], [mainRun(10)], { 10: passed(10) })).problems[0]).toContain("has no nightly verification")
  })

  it("ignores statuses of other workflows, branches, events, repositories and accounts", async () => {
    const cases: [Status, Run][] = [
      [status("success", 10), mainRun(10, { path: ".github/workflows/ci.yml" })],
      [status("success", 10), mainRun(10, { head_branch: "ci/nightly-verification" })],
      [status("success", 10), mainRun(10, { event: "push" })],
      [status("success", 10), mainRun(10, { event: "pull_request" })],
      [status("success", 10), mainRun(10, { repository: { full_name: "someone/TenuVault" } })],
      [status("success", 10, { creator: { login: "ugurlabs-agent[bot]" } }), mainRun(10)],
      [status("success", 10, { creator: { login: "someone" } }), mainRun(10)],
    ]
    for (const [entry, run] of cases) {
      expect((await gate([entry], [run], { 10: passed(10) })).problems[0]).toContain("has no nightly verification from main")
    }
  })

  it("ignores the pending and failure statuses a branch run wrote, and lets the main run decide", async () => {
    const branch = mainRun(43696328863, { head_branch: "ci/nightly-verification", event: "push", conclusion: "failure" })
    const statuses = [status("failure", 43696328863), status("pending", 43696328863)]
    expect((await gate(statuses, [branch])).problems[0]).toContain("has no nightly verification from main")
    // A newer main run decides; the branch run's statuses do not matter.
    expect((await gate([status("success", 43699999999), ...statuses], [branch, mainRun(43699999999)], { 43699999999: passed(43699999999) })).problems).toEqual([])
  })

  it("refuses when the run verified another commit", async () => {
    const { problems } = await gate([status("success", 10)], [mainRun(10)], { 10: { ...passed(10), sha: OTHER } })
    expect(problems).toEqual(["1419e55: the newest nightly verification (run 10) verified 0123456, not this commit."])
    expect((await gate([status("success", 10)], [mainRun(10)], { 10: { ...passed(10), runId: 11 } })).problems).toEqual(["1419e55: the result of run 10 belongs to another run."])
  })

  it("refuses a run that did not succeed, is still running or recorded no success", async () => {
    expect((await gate([status("success", 10)], [mainRun(10, { conclusion: "failure" })])).problems[0]).toContain("ended with failure")
    expect((await gate([status("error", 10)], [mainRun(10, { conclusion: "cancelled" })])).problems[0]).toContain("ended with cancelled")
    expect((await gate([status("pending", 10)], [mainRun(10, { status: "in_progress", conclusion: null })])).problems[0]).toContain("is still running")
    expect((await gate([status("success", 10)], [mainRun(10)], { 10: { ...passed(10), state: "error" } })).problems).toEqual(["1419e55: the newest nightly verification (run 10) recorded error."])
  })

  it("lets the newest run decide, so a newer failure is never hidden by an older success", async () => {
    // Statuses in any order: the higher run id wins.
    const runs = [mainRun(10), mainRun(20, { conclusion: "failure" })]
    expect((await gate([status("success", 10), status("failure", 20)], runs, { 10: passed(10) })).problems[0]).toContain("(run 20) ended with failure")
    expect((await gate([status("failure", 20), status("success", 10)], runs, { 10: passed(10) })).problems[0]).toContain("(run 20) ended with failure")
    // An older failure is replaced by a newer success.
    expect((await gate([status("success", 20), status("failure", 10)], [mainRun(10, { conclusion: "failure" }), mainRun(20)], { 20: passed(20) })).problems).toEqual([])
  })

  it("fails closed when GitHub cannot answer", async () => {
    await expect(gate([status("success", 10)], [])).rejects.toThrow("GitHub answered 404 for run 10.")
    await expect(gate([status("success", 10)], [mainRun(10)], {})).rejects.toThrow("no result artifact for run 10")
  })

  it("uses its own tenant, not the licensing canary's, in the installed app's paid key check", () => {
    const tenant = (file: string, name: string) => new RegExp(`${name} = "([0-9a-f-]{36})"`).exec(readFileSync(resolve(import.meta.dirname, "..", file), "utf8"))?.[1]
    const verification = tenant("scripts/nightly-verification/license.mjs", "VERIFY_TENANT")
    const canary = tenant("scripts/license-canary.ts", "CANARY_TENANT")
    expect(verification).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(canary).toBeDefined()
    expect(verification).not.toBe(canary)
  })

  it("records and checks the same status context", () => {
    const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/nightly-verification.yml"), "utf8")
    expect(workflow.match(/context="Nightly verification"/g)).toHaveLength(2)
    expect(workflow).toContain("name: nightly-verification-result")
  })
})

describe("first stable promotion", () => {
  it("tells how to verify the nightly being promoted once the gate lands", () => {
    const releasing = readFileSync(resolve(import.meta.dirname, "../RELEASING.md"), "utf8")
    expect(releasing).toContain("For the first stable\npromotion after it lands, run the verification for the nightly being promoted from `main`")
    expect(releasing).toContain("(`gh workflow run nightly-verification.yml -f tag=<nightly tag>`) and wait for it to succeed")
    expect(releasing).toContain("in an emergency promote with `allow_unverified_nightly`.")
  })
})

describe("release workflow", () => {
  const release = readFileSync(resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8")
  const meta = release.slice(release.indexOf("\n  meta:\n"), release.indexOf("\n  checks:\n"))

  it("keeps the nightly verification gate on stable releases, with its override", () => {
    expect(release).toMatch(/\n {6}allow_unverified_nightly:\n {8}description: Emergency only\./)
    expect(meta).toContain('ALLOW_UNVERIFIED: ${{ inputs.allow_unverified_nightly }}')
    expect(meta).toContain('node .github/scripts/nightly-verified.mjs "$sha"')
    expect(meta).toMatch(/if \[ "\$EVENT" = "workflow_dispatch" \] && \[ "\$ALLOW_UNVERIFIED" = "true" \]; then/)
  })

  it("lets the gate read statuses and the run's result", () => {
    expect(meta).toMatch(/permissions:\n {6}contents: read\n(?: {6}#.*\n)* {6}statuses: read\n {6}actions: read\n/)
  })

  it("records the published nightly for the verification, also when later steps fail", () => {
    expect(release).toContain("> published-nightly.json")
    expect(release).toMatch(/- name: Record the published nightly\n {8}if: always\(\) && needs\.meta\.outputs\.channel == 'nightly'\n[\s\S]*?name: published-nightly\n {10}path: published-nightly\.json/)
  })
})
