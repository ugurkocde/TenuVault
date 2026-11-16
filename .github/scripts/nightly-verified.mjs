/**
 * Refuses a stable release of a commit whose nightly did not pass the nightly verification:
 * its signed installers installed on Windows and macOS, the installed app activated a paid key
 * against production and completed a real Microsoft sign-in
 * (.github/workflows/nightly-verification.yml).
 *
 *   GH_TOKEN=<token> GITHUB_REPOSITORY=<owner/repo> node .github/scripts/nightly-verified.mjs <release commit>
 *
 * A run of the verification records the commit status STATUS_CONTEXT on the nightly's commit,
 * linking to itself, and uploads the artifact RESULT_ARTIFACT with the commit and tag it
 * verified. The gate does not trust a status by itself: for every status of the context it
 * fetches the run it links to, and only a run of WORKFLOW_PATH in this repository, on main,
 * started by a Release run or by hand, counts. Of those, the newest run decides: it must have
 * finished with success and its result artifact must name exactly this commit as verified.
 * Statuses of other workflows, branches, events or accounts are ignored. Any API error fails.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const STATUS_CONTEXT = "Nightly verification"
export const STATUS_CREATOR = "github-actions[bot]"
export const WORKFLOW_PATH = ".github/workflows/nightly-verification.yml"
export const RESULT_ARTIFACT = "nightly-verification-result"
export const RUN_EVENTS = ["workflow_run", "workflow_dispatch"]
const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{14}$/

/** The run id a status links to, or null when it does not link to a run of `repository`. */
export function runIdOf(status, repository) {
  const match = new RegExp(`^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/actions/runs/(\\d+)(?:/attempts/\\d+)?$`).exec(String(status?.target_url ?? ""))
  return match ? Number(match[1]) : null
}

/**
 * The workflow file of a run's `path`, or null when the path names another ref. GitHub may add
 * the ref the workflow file was read from (`<file>@<ref>`); only main counts, as `@main` or
 * `@refs/heads/main`, and a path without a ref is taken as it is.
 */
export function workflowFileOf(path) {
  if (typeof path !== "string") return null
  const at = path.indexOf("@")
  if (at === -1) return path
  const ref = path.slice(at + 1)
  return ref === "main" || ref === "refs/heads/main" ? path.slice(0, at) : null
}

/** Why a run does not count as a verification from main, or null when it does. */
export function runProblem(run, repository) {
  if (!run) return "the run could not be found"
  if (run.repository?.full_name !== repository) return `the run belongs to ${run.repository?.full_name ?? "another repository"}`
  if (workflowFileOf(run.path) !== WORKFLOW_PATH) return `the run is of ${run.path ?? "another workflow"}, not ${WORKFLOW_PATH}`
  if (run.head_branch !== "main") return `the run is from ${run.head_branch ?? "an unknown branch"}, not main`
  if (!RUN_EVENTS.includes(run.event)) return `the run was started by ${run.event}, not by a Release run or by hand`
  return null
}

/**
 * The reasons a commit is not verified, empty when it is.
 * statuses: the commit's statuses as the API lists them. getRun(id) and getResult(id) fetch a
 * run and its result artifact ({ sha, tag, state, runId }); both throw on errors.
 */
export async function verificationProblems({ statuses, repository, sha, getRun, getResult }) {
  const short = sha.slice(0, 7)
  const ids = [...new Set(statuses
    .filter((status) => status.context === STATUS_CONTEXT && status.creator?.login === STATUS_CREATOR)
    .map((status) => runIdOf(status, repository))
    .filter((id) => id !== null))].sort((a, b) => b - a)
  for (const id of ids) {
    const run = await getRun(id)
    if (runProblem(run, repository)) continue
    // The newest verification run from main decides, whatever it found.
    const where = `run ${id}`
    if (run.status !== "completed") return [`${short}: the newest nightly verification (${where}) is still running.`]
    if (run.conclusion !== "success") return [`${short}: the newest nightly verification (${where}) ended with ${run.conclusion}. Rerun it, or fix what it found.`]
    const result = await getResult(id)
    const problems = []
    if (result?.sha !== sha) problems.push(`${short}: the newest nightly verification (${where}) verified ${String(result?.sha ?? "no commit").slice(0, 7)}, not this commit.`)
    if (result?.state !== "success") problems.push(`${short}: the newest nightly verification (${where}) recorded ${result?.state ?? "no result"}.`)
    if (!NIGHTLY_TAG.test(String(result?.tag ?? ""))) problems.push(`${short}: the newest nightly verification (${where}) names no nightly tag.`)
    if (result?.runId !== id) problems.push(`${short}: the result of ${where} belongs to another run.`)
    return problems
  }
  return [`${short} has no nightly verification from main. Run it for the commit's nightly: gh workflow run nightly-verification.yml -f tag=<nightly tag>.`]
}

async function api(path, token) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path.split("?")[0]}.`)
  return response.json()
}

async function commitStatuses(repository, sha, token) {
  const statuses = []
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`repos/${repository}/commits/${sha}/statuses?per_page=100&page=${page}`, token)
    statuses.push(...batch)
    if (batch.length < 100) break
  }
  return statuses
}

/** The result artifact of a run, read with gh, which the release runners have. */
function resultOf(repository, id) {
  const dir = mkdtempSync(join(tmpdir(), "nightly-verified-"))
  try {
    execFileSync("gh", ["run", "download", String(id), "-R", repository, "-n", RESULT_ARTIFACT, "-D", dir], { stdio: ["ignore", "ignore", "pipe"] })
    return JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sha = process.argv[2]
  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GH_TOKEN
  if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !repository || !token) {
    console.error("Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/repo nightly-verified.mjs <40 character commit>")
    process.exit(2)
  }
  let problems
  try {
    problems = await verificationProblems({
      statuses: await commitStatuses(repository, sha, token),
      repository,
      sha,
      getRun: (id) => api(`repos/${repository}/actions/runs/${id}`, token),
      getResult: async (id) => resultOf(repository, id),
    })
  } catch (error) {
    problems = [`The nightly verification of ${sha.slice(0, 7)} could not be checked: ${error instanceof Error ? error.message : String(error)}`]
  }
  if (problems.length > 0) {
    for (const problem of problems) console.log(`::error::${problem}`)
    console.log("::error::Stable releases need a nightly of the same commit that passed the nightly verification (RELEASING.md). Rerun it, or in an emergency run the stable promotion with allow_unverified_nightly.")
    process.exit(1)
  }
  console.log(`${sha.slice(0, 7)} passed the nightly verification.`)
}
