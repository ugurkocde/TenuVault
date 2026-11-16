import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// The nightly verification workflow runs these scripts with plain Node.
type Job = { name: string; conclusion: string | null }
type Outcome = { state: string | null; description: string; record: boolean; alert: boolean; message: string }
const load = async () => (await import("../.github/scripts/nightly-verification-outcome.mjs" as string)) as {
  CHECKS: string[]
  verificationOutcome: (run: { event: string; ref: string; alertRequested: boolean; resolve: string; tag: string; jobs: Job[] }) => Outcome
  supersededBy: (
    statuses: { context: string; target_url?: string; creator?: { login: string } }[],
    ownRunId: number,
    repository: string,
    getRun: (id: number) => Promise<Record<string, unknown>>,
  ) => Promise<number | null>
}
const loadSecrets = async () => (await import("../scripts/nightly-verification/secrets.mjs" as string)) as {
  hide: (text: string, secrets: Record<string, string>) => string
  matchesTestAccount: (account: { tenantId?: string; username?: string; clientId?: string }, secrets: Record<string, string>) => boolean
  maskedCapture: (mask: () => unknown, capture: () => unknown) => Promise<boolean>
}
const workflowText = () => readFileSync(resolve(import.meta.dirname, "../.github/workflows/nightly-verification.yml"), "utf8")
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
    // A failure next to a cancelled check names both, records the failure and does not alert.
    const mixed = verificationOutcome(run({ jobs: jobs({ "Paid key (Windows)": "cancelled", "Paid key (macOS)": "failure" }) }))
    expect(mixed.message).toBe(`Nightly verification of ${TAG} failed: Paid key (macOS) failure, Paid key (Windows) cancelled.`)
    expect(mixed).toMatchObject({ state: "failure", record: true, alert: false })
    expect(verificationOutcome(run({ event: "workflow_dispatch", alertRequested: true, jobs: jobs({ "Microsoft sign-in (macOS)": "cancelled", "Paid key (macOS)": "timed_out" }) })))
      .toMatchObject({ state: "failure", record: true, alert: false })
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

describe("nightly verification ordering", () => {
  const REPO = "ugurkocde/TenuVault"
  const at = (id: number, overrides: Record<string, unknown> = {}) => ({
    context: "Nightly verification", target_url: `https://github.com/${REPO}/actions/runs/${id}`, creator: { login: "github-actions[bot]" }, ...overrides,
  })

  const run = (id: number, overrides: Record<string, unknown> = {}) => ({
    id, path: ".github/workflows/nightly-verification.yml", head_branch: "main", event: "workflow_run", repository: { full_name: REPO }, ...overrides,
  })
  const runs = (list: Record<string, unknown>[]) => async (id: number) => {
    const found = list.find((entry) => entry.id === id)
    if (!found) throw new Error(`GitHub answered 404 for run ${id}.`)
    return found
  }

  it("never lets an older run write over a newer run's result", async () => {
    const { supersededBy } = await load()
    expect(await supersededBy([], 10, REPO, runs([]))).toBeNull()
    // Its own pending status and older runs do not stop a run, and are not even fetched.
    expect(await supersededBy([at(10), at(9), at(3)], 10, REPO, runs([]))).toBeNull()
    // A verification run from main started later (a higher id) owns the result, pending or finished.
    expect(await supersededBy([at(10), at(12), at(11)], 10, REPO, runs([run(11), run(12)]))).toBe(12)
    expect(await supersededBy([at(11)], 10, REPO, runs([run(11, { event: "workflow_dispatch" })]))).toBe(11)
    // Statuses of other contexts, accounts or repositories do not count.
    expect(await supersededBy([at(12, { context: "ci" }), at(13, { creator: { login: "someone" } }), at(14, { target_url: "https://github.com/someone/TenuVault/actions/runs/14" })], 10, REPO, runs([]))).toBeNull()
  })

  it("only counts newer runs from main of this workflow, as the stable gate does", async () => {
    const { supersededBy } = await load()
    const others = [
      run(11, { head_branch: "ci/nightly-verification", event: "push" }),
      run(12, { path: ".github/workflows/ci.yml" }),
      run(13, { event: "pull_request" }),
      run(14, { repository: { full_name: "someone/TenuVault" } }),
    ]
    expect(await supersededBy([at(11), at(12), at(13), at(14)], 10, REPO, runs(others))).toBeNull()
    // A newer main run behind a newer branch run still counts.
    expect(await supersededBy([at(15), at(11)], 10, REPO, runs([...others, run(15)]))).toBe(15)
    // A newer run that cannot be fetched stops the write instead of being ignored.
    await expect(supersededBy([at(16)], 10, REPO, runs([]))).rejects.toThrow("GitHub answered 404 for run 16.")
  })

  it("writes the result only when not superseded, the result before the status", () => {
    const workflow = workflowText()
    for (const step of ["Write the result", "Upload the result", "Set the commit status"]) {
      expect(workflow).toMatch(new RegExp(`- name: ${step}\\n {8}if: steps\\.outcome\\.outputs\\.record == 'true' && steps\\.outcome\\.outputs\\.state != '' && steps\\.outcome\\.outputs\\.superseded == ''\\n`))
    }
    expect(workflow).toMatch(/- name: Email the failure\n {8}if: steps\.outcome\.outputs\.alert == 'true' && steps\.outcome\.outputs\.superseded == ''\n/)
    expect(workflow.indexOf("- name: Upload the result")).toBeLessThan(workflow.indexOf("- name: Set the commit status"))
    // Every status of the commit is read, page by page, as the gate reads them.
    expect(workflow.match(/gh api --paginate "repos\/\$GITHUB_REPOSITORY\/commits\/\$(sha|SHA)\/statuses\?per_page=100" --jq '\.\[\]' \| jq -s \./g)).toHaveLength(2)
  })

  it("queues every run with a published nightly and lets a run with nothing to verify end outside the queues", () => {
    const workflow = workflowText()
    const job = (name: string) => workflow.slice(workflow.indexOf(`\n  ${name}:\n`) + 1).split(/\n {2}[a-z-]+:\n/)[0]
    // No concurrency for the whole run, and none for the job that finds the nightly.
    expect(workflow).not.toMatch(/^concurrency:/m)
    expect(job("resolve")).not.toContain("concurrency:")
    expect(job("sign-in")).not.toContain("concurrency:")
    // Only jobs that run with a published nightly enter a queue, and the queues keep every waiting run.
    expect(job("license")).toMatch(/\n {4}if: needs\.resolve\.outputs\.tag != ''\n[\s\S]*?\n {4}concurrency:\n {6}group: nightly-verification-paid-key\n {6}queue: max\n/)
    expect(job("record")).toMatch(/\n {4}if: always\(\) && needs\.resolve\.result != 'skipped' && \(needs\.resolve\.result != 'success' \|\| needs\.resolve\.outputs\.tag != ''\)\n {4}#.*\n {4}concurrency:\n {6}group: nightly-verification-result\n {6}queue: max\n/)
    expect(workflow).not.toContain("cancel-in-progress")
  })
})

describe("nightly verification exposure", () => {
  const secrets = { TENUVAULT_E2E_TENANT_ID: "11111111-2222-4333-8444-555555555555", TENUVAULT_E2E_CLIENT_ID: "66666666-7777-4888-9999-000000000000", TENUVAULT_E2E_USERNAME: "e2e@contoso.onmicrosoft.com", TENUVAULT_E2E_PASSWORD: "secret-password" }

  it("matches the signed-in account on tenant, user and app registration together", async () => {
    const { matchesTestAccount } = await loadSecrets()
    const account = { tenantId: secrets.TENUVAULT_E2E_TENANT_ID.toUpperCase(), username: "E2E@contoso.onmicrosoft.com", clientId: secrets.TENUVAULT_E2E_CLIENT_ID }
    expect(matchesTestAccount(account, secrets)).toBe(true)
    expect(matchesTestAccount({ ...account, tenantId: "99999999-2222-4333-8444-555555555555" }, secrets)).toBe(false)
    expect(matchesTestAccount({ ...account, username: "someone@contoso.onmicrosoft.com" }, secrets)).toBe(false)
    expect(matchesTestAccount({ ...account, clientId: "99999999-7777-4888-9999-000000000000" }, secrets)).toBe(false)
    expect(matchesTestAccount({ tenantId: account.tenantId, username: account.username }, secrets)).toBe(false)
  })

  it("hides the account and ids in messages", async () => {
    const { hide } = await loadSecrets()
    expect(hide(`Signed in as E2E@Contoso.onmicrosoft.com at https://login.microsoftonline.com/${secrets.TENUVAULT_E2E_TENANT_ID}/oauth2 for ${secrets.TENUVAULT_E2E_CLIENT_ID}`, secrets))
      .toBe("Signed in as [hidden] at https://login.microsoftonline.com/[hidden]/oauth2 for [hidden]")
  })

  it("keeps screenshots only of failures, for 3 days, under a name per attempt", () => {
    const workflow = workflowText()
    const uploads = [...workflow.matchAll(/- name: Upload failure screenshots\n {8}if: (.*)\n[\s\S]*?name: (.*)\n[\s\S]*?retention-days: (\d+)/g)]
    expect(uploads).toHaveLength(2)
    for (const [, condition, name, days] of uploads) {
      expect(condition).toBe("failure()")
      expect(name).toContain("${{ github.run_attempt }}")
      expect(days).toBe("3")
    }
    expect(workflow).not.toMatch(/- name: Upload screenshots/)
    // The harnesses take no screenshot of a passing check.
    const signIn = readFileSync(resolve(import.meta.dirname, "../scripts/nightly-verification/sign-in.mjs"), "utf8")
    const license = readFileSync(resolve(import.meta.dirname, "../scripts/nightly-verification/license.mjs"), "utf8")
    expect([...signIn.matchAll(/screenshot\(`([^`]*)`/g)].map((match) => match[1]).every((name) => name?.startsWith("fail-"))).toBe(true)
    expect([...license.matchAll(/screenshot\(`([^`]*)`/g)].map((match) => match[1]).every((name) => name?.startsWith("fail-"))).toBe(true)
    expect(license).toContain(".screenshot(`fail-${name.replace(/\\W+/g, \"-\")}`, [key])")
  })
})

describe("nightly verification screenshots", () => {
  it("captures nothing when masking fails", async () => {
    const { maskedCapture } = await loadSecrets()
    const captured: string[] = []
    const capture = () => { captured.push("shot") }
    expect(await maskedCapture(() => Promise.reject(new Error("page closed")), capture)).toBe(false)
    expect(await maskedCapture(() => { throw new Error("no document") }, capture)).toBe(false)
    expect(captured).toEqual([])
    expect(await maskedCapture(async () => undefined, capture)).toBe(true)
    expect(captured).toEqual(["shot"])
  })

  it("routes every screenshot through the masked capture", () => {
    const signIn = readFileSync(resolve(import.meta.dirname, "../scripts/nightly-verification/sign-in.mjs"), "utf8")
    const app = readFileSync(resolve(import.meta.dirname, "../scripts/nightly-verification/app.mjs"), "utf8")
    expect(signIn.match(/page\.screenshot\(/g)).toHaveLength(1)
    expect(signIn).toMatch(/maskedCapture\(\n\s*\(\) => page\.evaluate\(maskPage, hidden\(secrets\)\),\n\s*\(\) => page\.screenshot\(/)
    expect(app.match(/Page\.captureScreenshot/g)).toHaveLength(1)
    expect(app).toMatch(/return maskedCapture\(mask, async \(\) => \{\n\s*const \{ result \} = await send\("Page\.captureScreenshot"/)
  })
})

describe("nightly verification identity", () => {
  it("requires TenuVault's Apple team, named once and as in RELEASING.md", () => {
    const script = readFileSync(resolve(import.meta.dirname, "../scripts/nightly-verification/install-macos.sh"), "utf8")
    const team = /^EXPECTED_TEAM_ID=([A-Z0-9]{10})$/m.exec(script)?.[1]
    expect(team).toBe("D259ULY2B4")
    expect(script.match(/D259ULY2B4/g)).toHaveLength(1)
    expect(script).toContain('if [ "$team" != "$EXPECTED_TEAM_ID" ]; then')
    expect(readFileSync(resolve(import.meta.dirname, "../RELEASING.md"), "utf8")).toContain("Team ID `D259ULY2B4`")
  })

  it("fails when the release lacks an installer, in the paid key job that checks them all", () => {
    const workflow = workflowText()
    const license = workflow.slice(workflow.indexOf("\n  license:\n"), workflow.indexOf("\n  sign-in:\n"))
    const signIn = workflow.slice(workflow.indexOf("\n  sign-in:\n"), workflow.indexOf("\n  record:\n"))
    expect(license).toContain("-ExpectedPublisher $env:EXPECTED_PUBLISHER -RequireAll")
    expect(license).toContain('install-macos.sh "$RUNNER_TEMP/installers" /Applications --require-all')
    expect(signIn).not.toContain("RequireAll")
    expect(signIn).not.toContain("--require-all")
    const windows = readFileSync(resolve(import.meta.dirname, "../scripts/nightly-verification/install-windows.ps1"), "utf8")
    expect(windows).toContain("if ($RequireAll -and $found.Count -ne 1) { throw")
    const mac = readFileSync(resolve(import.meta.dirname, "../scripts/nightly-verification/install-macos.sh"), "utf8")
    expect(mac.indexOf('if [ "$require_all" = --require-all ]; then')).toBeLessThan(mac.indexOf('mount "$dmg"'))
  })

  it("checks the publisher of every Windows installer before running one", () => {
    const script = readFileSync(resolve(import.meta.dirname, "../scripts/nightly-verification/install-windows.ps1"), "utf8")
    expect(script.indexOf("Assert-Publisher $msi[0].FullName")).toBeLessThan(script.indexOf("Start-Process msiexec.exe"))
    expect(script).toContain("foreach ($pattern in @('*-win-arm64.exe', '*-win.exe')) {")
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

  it("removes the characters the route refuses", async () => {
    const { alertBody } = await loadAlert()
    expect(alertBody(["a\u2028b\tc\u200bd\u0007e", "\n", "\u2029"], {})).toEqual({ failures: ["a b c d e"] })
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
