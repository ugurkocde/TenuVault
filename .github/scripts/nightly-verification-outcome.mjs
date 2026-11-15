/**
 * Decides what a nightly verification run records and whether it alerts
 * (.github/workflows/nightly-verification.yml, job "Record the result").
 *
 *   node .github/scripts/nightly-verification-outcome.mjs <jobs.json>
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
 *   when it asked for alerts.
 */
import { appendFileSync, readFileSync } from "node:fs"

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

  if (failed.length > 0) {
    const detail = describe([...failed, ...unfinished])
    return {
      state: "failure",
      description: `${tag}: ${detail}`.slice(0, 140),
      record: defaultFlow,
      alert: mayAlert,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const jobs = JSON.parse(readFileSync(process.argv[2], "utf8"))
  const { EVENT, REF, ALERT_REQUESTED, RESOLVE, TAG, GITHUB_OUTPUT } = process.env
  const outcome = verificationOutcome({ event: EVENT, ref: REF, alertRequested: ALERT_REQUESTED === "true", resolve: RESOLVE, tag: TAG, jobs })
  const lines = Object.entries(outcome).map(([key, value]) => `${key}=${value ?? ""}`)
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `${lines.join("\n")}\n`)
  console.log(lines.join("\n"))
}
