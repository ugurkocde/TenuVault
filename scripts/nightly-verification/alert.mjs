/**
 * Emails a failed nightly verification through the website's alerting, with its own subject
 * ("TenuVault release: nightly verification failed"), not the licensing canary's.
 *
 *   LICENSING_CANARY_ALERT_SECRET=<secret> node scripts/nightly-verification/alert.mjs <line> [<line>...]
 *
 * Posts { failures, runUrl } to /api/desktop-license/nightly-verification-alert, authorized with
 * the canary's alert secret. The website has to provide that route; until it does, the request
 * answers 404, nothing is emailed and this warns. Best effort either way: the failed run's own
 * GitHub email still arrives. Without the secret nothing is sent.
 */
export const ALERT_URL = "https://www.tenuvault.com/api/desktop-license/nightly-verification-alert"

/** The request body: at most 10 lines of at most 500 characters, and the run link. */
export function alertBody(lines, env = process.env) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env
  const runUrl = GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined
  return { failures: lines.filter(Boolean).slice(0, 10).map((line) => line.slice(0, 500)), ...(runUrl ? { runUrl } : {}) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.env.LICENSING_CANARY_ALERT_SECRET?.trim()
  const body = alertBody(process.argv.slice(2))
  if (!secret) {
    console.log("::warning title=Nightly verification::LICENSING_CANARY_ALERT_SECRET is not set, so no alert email was sent.")
  } else if (body.failures.length === 0) {
    console.log("::warning title=Nightly verification::Nothing to report.")
  } else {
    try {
      const response = await fetch(ALERT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      })
      const answer = await response.json().catch(() => null)
      if (response.ok && answer?.alerted) console.log("Emailed the failure.")
      else if (response.status === 404) console.log("::warning title=Nightly verification::The website has no nightly verification alert route yet (404), so no email was sent. GitHub's failed run email still arrives.")
      else console.log(`::warning title=Nightly verification::The alert email was not sent (${response.status}).`)
    } catch (error) {
      console.log(`::warning title=Nightly verification::The alert email could not be requested: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
