import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// The nightly verification workflow runs these scripts with plain Node.
type Job = { name: string; conclusion: string | null }
type Outcome = { state: string | null; description: string; record: boolean; alert: boolean; message: string }
const load = async () => (await import("../.github/scripts/nightly-verification-outcome.mjs" as string)) as {
  CHECKS: string[]
  verificationOutcome: (run: { event: string; ref: string; alertRequested: boolean; resolve: string; tag: string; jobs: Job[] }) => Outcome
}
const loadAlert = async () => (await import("../scripts/nightly-verification/alert.mjs" as string)) as {
  ALERT_URL: string
  alertBody: (lines: string[], env: Record<string, string | undefined>) => { failures: string[]; runUrl?: string }
}

const TAG = "v0.5.3-nightly.20261114180404"
const MAIN = "refs/heads/main"
const jobs = (overrides: Record<string, string | null> = {}): Job[] => [
  { name: "Find the nightly", conclusion: "success" },
  ...["Paid key (Windows)", "Paid key (macOS)", "Microsoft sign-in (Windows)", "Microsoft sign-in (macOS)"].map((name) => ({ name, conclusion: name in overrides ? (overrides[name] ?? null) : "success" })),
  { name: "Record the result", conclusion: null },
]
const run = (overrides: Partial<{ event: string; ref: string; alertRequested: boolean; resolve: string; tag: string; jobs: Job[] }> = {}) => ({
  event: "workflow_run", ref: MAIN, alertRequested: false, resolve: "success", tag: TAG, jobs: jobs(), ...overrides,
})

describe("nightly verification outcome", () => {
  it("needs both checks on both platforms", async () => {
    const { CHECKS } = await load()
    expect(CHECKS).toEqual(["Paid key (Windows)", "Paid key (macOS)", "Microsoft sign-in (Windows)", "Microsoft sign-in (macOS)"])
  })

  it("records a pass of the release-triggered run without alerting", async () => {
    const { verificationOutcome } = await load()
    expect(verificationOutcome(run())).toEqual({
      state: "success",
      description: `${TAG}: installers, paid key and sign-in verified on Windows and macOS`,
      record: true,
      alert: false,
      message: "",
    })
  })

  it("records and alerts a failure, naming the check and how it ended", async () => {
    const { verificationOutcome } = await load()
    const outcome = verificationOutcome(run({ jobs: jobs({ "Paid key (Windows)": "failure", "Microsoft sign-in (macOS)": "timed_out" }) }))
    expect(outcome).toMatchObject({ state: "failure", record: true, alert: true })
    expect(outcome.message).toBe(`Nightly verification of ${TAG} failed: Paid key (Windows) failure, Microsoft sign-in (macOS) timed out.`)
    expect(outcome.description.length).toBeLessThanOrEqual(140)
    // A failure next to a cancelled check names both.
    expect(verificationOutcome(run({ jobs: jobs({ "Paid key (Windows)": "cancelled", "Paid key (macOS)": "failure" }) })).message)
      .toBe(`Nightly verification of ${TAG} failed: Paid key (macOS) failure, Paid key (Windows) cancelled.`)
  })

  it("records a cancelled or missing check as unverified, never as a pass, and does not alert", async () => {
    const { verificationOutcome } = await load()
    const cancelled = verificationOutcome(run({ jobs: jobs({ "Paid key (Windows)": "cancelled" }) }))
    expect(cancelled).toMatchObject({ state: "error", record: true, alert: false })
    expect(cancelled.description).toBe(`${TAG}: not verified, Paid key (Windows) cancelled`)
    expect(verificationOutcome(run({ jobs: jobs({ "Microsoft sign-in (macOS)": "skipped" }) })).state).toBe("error")
    expect(verificationOutcome(run({ jobs: jobs().filter((job) => job.name !== "Paid key (macOS)") })))
      .toMatchObject({ state: "error", alert: false, description: `${TAG}: not verified, Paid key (macOS) not run` })
  })

  it("alerts a dispatched run only when it asked to", async () => {
    const { verificationOutcome } = await load()
    const failing = jobs({ "Microsoft sign-in (Windows)": "failure" })
    expect(verificationOutcome(run({ event: "workflow_dispatch", jobs: failing }))).toMatchObject({ state: "failure", record: true, alert: false })
    expect(verificationOutcome(run({ event: "workflow_dispatch", alertRequested: true, jobs: failing }))).toMatchObject({ record: true, alert: true })
  })

  it("never records or alerts from push, pull request or branch runs", async () => {
    const { verificationOutcome } = await load()
    const failing = jobs({ "Paid key (Windows)": "failure" })
    for (const other of [
      { event: "push", ref: "refs/heads/ci/nightly-verification" },
      { event: "push", ref: MAIN },
      { event: "pull_request", ref: "refs/pull/1/merge" },
      { event: "workflow_dispatch", ref: "refs/heads/ci/nightly-verification", alertRequested: true },
      { event: "workflow_run", ref: "refs/heads/other" },
    ]) {
      expect(verificationOutcome(run({ ...other, jobs: failing }))).toMatchObject({ state: "failure", record: false, alert: false })
      expect(verificationOutcome(run(other))).toMatchObject({ state: "success", record: false })
    }
  })

  it("has nothing to record when no nightly was published, and alerts a failed lookup", async () => {
    const { verificationOutcome } = await load()
    expect(verificationOutcome(run({ tag: "" }))).toMatchObject({ state: null, record: false, alert: false })
    expect(verificationOutcome(run({ resolve: "skipped", tag: "" }))).toMatchObject({ state: null, alert: false })
    expect(verificationOutcome(run({ resolve: "failure", tag: "" }))).toMatchObject({ state: null, record: false, alert: true })
    expect(verificationOutcome(run({ resolve: "failure", tag: "", event: "push" }))).toMatchObject({ alert: false })
    expect(verificationOutcome(run({ resolve: "cancelled", tag: "" }))).toMatchObject({ alert: false })
  })
})

describe("nightly verification triggers", () => {
  it("runs only after a Release run or by hand, never on pushes or pull requests", () => {
    const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/nightly-verification.yml"), "utf8")
    const on = /^on:\n((?: {2}.*\n|\n)+)/m.exec(workflow)?.[1] ?? ""
    expect([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1])).toEqual(["workflow_run", "workflow_dispatch"])
    expect(on).toContain("workflows: [Release]")
  })
})

describe("nightly verification alert", () => {
  it("uses its own route, not the licensing canary's", async () => {
    const { ALERT_URL } = await loadAlert()
    expect(ALERT_URL).toBe("https://www.tenuvault.com/api/desktop-license/nightly-verification-alert")
    expect(ALERT_URL).not.toContain("canary")
  })

  it("sends the failure lines and the run link", async () => {
    const { alertBody } = await loadAlert()
    expect(alertBody(["a", "", "b".repeat(600)], { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "ugurkocde/TenuVault", GITHUB_RUN_ID: "42" })).toEqual({
      failures: ["a", "b".repeat(500)],
      runUrl: "https://github.com/ugurkocde/TenuVault/actions/runs/42",
    })
    expect(alertBody(Array.from({ length: 12 }, (_, i) => `line ${i}`), {}).failures).toHaveLength(10)
  })
})
