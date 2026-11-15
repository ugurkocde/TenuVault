/**
 * Decides what a nightly verification run records and whether it alerts
 * (.github/workflows/nightly-verification.yml, job "Record the result").
 *
 *   node .github/scripts/nightly-verification-outcome.mjs <jobs.json>
 *   node .github/scripts/nightly-verification-outcome.mjs superseded <statuses.json>
 *
 * Reads EVENT, REF, ALERT_REQUESTED, RESOLVE and TAG from the environment and the run's jobs
 * ({ name, conclusion } as the GitHub API lists them) from jobs.json, and writes state,
 * description, record, alert and message to GITHUB_OUTPUT.
 *
 * Rules:
 * - Only runs of the default flow on main record a commit status or alert: the run a Release
 *   run starts, or a workflow_dispatch from main. Push, pull request and other branch runs never
 *   do, so they can neither pass nor fail the stable gate.
 * - Every check must succeed for "success". A failed or timed out check is a "failure". A check
 *   that was cancelled, skipped or never ran leaves the nightly unverified: the status is
 *   "error", which the stable gate does not accept, and nothing is alerted.
 * - Only failures alert: always for the release-triggered run, for a workflow_dispatch only
 *   when it asked for alerts. A run with a cancelled check never alerts, even when another
 *   check failed; it still records the failure.
 * - A run never overwrites the result of a newer run of the same commit (supersededBy).
 */
import { appendFileSync, readFileSync } from "node:fs"
import { runIdOf, runProblem, STATUS_CONTEXT, STATUS_CREATOR } from "./nightly-verified.mjs"

/** The jobs of one run that must all succeed, one per check and platform. */
export const CHECKS = ["Paid key (Windows)", "Paid key (macOS)", "Microsoft sign-in (Windows)", "Microsoft sign-in (macOS)"]

const FAILED = new Set(["failure", "timed_out"])

/**
 * The outcome of a run. jobs: [{ name, conclusion }]. Returns { state, description, record,
 * alert, message }; state is null when there is no nightly to record against.
 */
export function verificationOutcome({ event, ref, alertRequested, resolve, tag, jobs }) {
  const defaultFlow = ref === "refs/heads/main" && (event === "workflow_run" || event === "workflow_dispatch")
  const mayAlert = defaultFlow && (event === "workflow_run" || alertRequested === true)
  if (resolve !== "success") {
    const failed = resolve === "failure"
    return {
      state: null,
      description: "",
      record: false,
      alert: failed && mayAlert,
      message: failed ? "Nightly verification could not find the nightly to verify (the Find the nightly job failed)." : "",
    }
  }
  if (!tag) return { state: null, description: "", record: false, alert: false, message: "" }

  const results = CHECKS.map((name) => ({ name, conclusion: jobs.find((job) => job.name === name)?.conclusion ?? "not run" }))
  const failed = results.filter((result) => FAILED.has(result.conclusion))
  const unfinished = results.filter((result) => result.conclusion !== "success" && !FAILED.has(result.conclusion))
  const describe = (list) => list.map((result) => `${result.name} ${result.conclusion === "timed_out" ? "timed out" : result.conclusion}`).join(", ")

  const cancelled = results.some((result) => result.conclusion === "cancelled")
  if (failed.length > 0) {
    const detail = describe([...failed, ...unfinished])
    return {
      state: "failure",
      description: `${tag}: ${detail}`.slice(0, 140),
      record: defaultFlow,
      alert: mayAlert && !cancelled,
      message: `Nightly verification of ${tag} failed: ${detail}.`,
    }
  }
  if (unfinished.length > 0) {
    const detail = describe(unfinished)
    return {
      state: "error",
      description: `${tag}: not verified, ${detail}`.slice(0, 140),
      record: defaultFlow,
      alert: false,
      message: `Nightly verification of ${tag} did not finish: ${detail}. Rerun it; the nightly counts as unverified.`,
    }
  }
  return {
    state: "success",
    description: `${tag}: installers, paid key and sign-in verified on Windows and macOS`,
    record: defaultFlow,
    alert: false,
    message: "",
  }
}

/**
 * The id of a newer verification run from main that already recorded a status for the commit,
 * or null. statuses: the commit's statuses; ownRunId: this run; getRun(id) fetches a run and
 * throws on errors. A run started after this one (a higher id) owns the result, so this run must
 * not write over it. As in the stable gate, only runs of this workflow on main started by a
 * Release run or by hand count; a branch run's statuses never hold back a run from main.
 */
export async function supersededBy(statuses, ownRunId, repository, getRun) {
  const ids = [...new Set(statuses
    .filter((status) => status.context === STATUS_CONTEXT && status.creator?.login === STATUS_CREATOR)
    .map((status) => runIdOf(status, repository))
    .filter((id) => id !== null && id > ownRunId))].sort((x, y) => y - x)
  for (const id of ids) {
    if (!runProblem(await getRun(id), repository)) return id
  }
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { EVENT, REF, ALERT_REQUESTED, RESOLVE, TAG, GITHUB_OUTPUT, GITHUB_RUN_ID, GITHUB_REPOSITORY } = process.env
  const write = (values) => {
    const lines = Object.entries(values).map(([key, value]) => `${key}=${value ?? ""}`)
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `${lines.join("\n")}\n`)
    console.log(lines.join("\n"))
  }
  if (process.argv[2] === "superseded") {
    // node nightly-verification-outcome.mjs superseded <statuses.json>
    const getRun = async (id) => {
      const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${id}`, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for run ${id}.`)
      return response.json()
    }
    // An error fails the step, so nothing is written over a result this run could not check.
    write({ superseded: await supersededBy(JSON.parse(readFileSync(process.argv[3], "utf8")), Number(GITHUB_RUN_ID), GITHUB_REPOSITORY, getRun) })
  } else {
    // node nightly-verification-outcome.mjs <jobs.json>
    const jobs = JSON.parse(readFileSync(process.argv[2], "utf8"))
    write(verificationOutcome({ event: EVENT, ref: REF, alertRequested: ALERT_REQUESTED === "true", resolve: RESOLVE, tag: TAG, jobs }))
  }
}
