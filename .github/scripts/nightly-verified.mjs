/**
 * Refuses a stable release of a commit whose nightly did not pass the nightly verification:
 * its signed installers installed on Windows and macOS, the installed app activated a paid key
 * against production and completed a real Microsoft sign-in
 * (.github/workflows/nightly-verification.yml).
 *
 *   GH_TOKEN=<token> GITHUB_REPOSITORY=<owner/repo> node .github/scripts/nightly-verified.mjs <release commit>
 *
 * The verification workflow records its result as the commit status STATUS_CONTEXT on the
 * nightly's commit, success or failure, and a rerun replaces it. This reads the newest status of
 * that context and exits 1 with the reasons unless it is a success set by GitHub Actions for a
 * run of this repository.
 */

export const STATUS_CONTEXT = "Nightly verification"
export const STATUS_CREATOR = "github-actions[bot]"

/**
 * The reasons a commit is not verified, empty when it is.
 * statuses: the commit's statuses, newest first, as the GitHub API lists them.
 */
export function verificationProblems(statuses, repository, sha) {
  const short = sha.slice(0, 7)
  const status = statuses.find((entry) => entry.context === STATUS_CONTEXT)
  if (!status) return [`${short} has no nightly verification. Run it for the commit's nightly: gh workflow run nightly-verification.yml -f tag=<nightly tag>.`]
  const problems = []
  if (status.state !== "success") {
    const ended = status.state === "pending" ? "is still running" : status.state === "error" ? "did not finish, a check was cancelled or skipped" : `ended with ${status.state}`
    problems.push(`${short}: the newest nightly verification ${ended} (${status.description ?? "no description"}, ${status.target_url ?? "no run link"}).`)
  }
  if (status.creator?.login !== STATUS_CREATOR) {
    problems.push(`${short}: the nightly verification status was set by ${status.creator?.login ?? "an unknown account"}, not by the workflow.`)
  }
  if (!String(status.target_url ?? "").startsWith(`https://github.com/${repository}/actions/runs/`)) {
    problems.push(`${short}: the nightly verification status does not link to a workflow run of ${repository}.`)
  }
  return problems
}

/** Every status of the commit, newest first. */
async function commitStatuses(repository, sha, token) {
  const statuses = []
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/statuses?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for the statuses of ${sha}.`)
    const batch = await response.json()
    statuses.push(...batch)
    if (batch.length < 100) break
  }
  return statuses
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sha = process.argv[2]
  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GH_TOKEN
  if (!sha || !repository || !token) {
    console.error("Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/repo nightly-verified.mjs <release commit>")
    process.exit(2)
  }
  const problems = verificationProblems(await commitStatuses(repository, sha, token), repository, sha)
  if (problems.length > 0) {
    for (const problem of problems) console.log(`::error::${problem}`)
    console.log("::error::Stable releases need a nightly of the same commit that passed the nightly verification (RELEASING.md). Rerun it, or in an emergency run the stable promotion with allow_unverified_nightly.")
    process.exit(1)
  }
  console.log(`${sha.slice(0, 7)} passed the nightly verification.`)
}
