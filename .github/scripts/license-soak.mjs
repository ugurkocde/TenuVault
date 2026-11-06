/**
 * Refuses a stable release whose licensing changes have not run on the nightly channel long
 * enough. A licensing mistake blocks every buyer at once, and nightly users (the maintainers'
 * own machines among them) are where it shows first.
 *
 *   node .github/scripts/license-soak.mjs <release commit>
 *
 * Finds the previous stable tag behind the release commit, the commits since then that touch
 * licensing files, and for each one the first nightly release that contained it. Every such
 * commit must have shipped in a nightly at least SOAK_HOURS ago. Exits 1 with the reasons
 * otherwise. A first release (no stable tag yet) has nothing to compare against and passes.
 */
import { execFileSync } from "node:child_process"

export const SOAK_HOURS = 24

// The license client, the store it saves to, the key it verifies with and how that key is built in.
export const LICENSE_PATHS = [
  "src/main/license/",
  "src/main/storage/secure-store.ts",
  "scripts/license-public-key.ts",
  "electron.vite.config.ts",
]

const NIGHTLY = /^v\d+\.\d+\.\d+-nightly\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/

/** The build time (ms, UTC) a nightly tag carries, or null for any other tag. */
export function nightlyTime(tag) {
  const match = NIGHTLY.exec(tag)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

/**
 * The reasons a release is not allowed yet, empty when it is.
 * commits: licensing commits since the previous stable release, { sha, subject }.
 * nightlies: for each commit sha, the tags that contain it.
 */
export function soakProblems(commits, nightlies, now, hours = SOAK_HOURS) {
  const problems = []
  for (const { sha, subject } of commits) {
    const times = (nightlies.get(sha) ?? []).map(nightlyTime).filter((time) => time !== null)
    const short = `${sha.slice(0, 7)} (${subject})`
    if (times.length === 0) {
      problems.push(`${short} changes licensing and has not shipped in a nightly yet.`)
      continue
    }
    const first = Math.min(...times)
    const soaked = (now - first) / 3_600_000
    if (soaked < hours) {
      problems.push(`${short} changes licensing and has been on the nightly channel for ${soaked.toFixed(1)} of ${hours} hours.`)
    }
  }
  return problems
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()

if (import.meta.url === `file://${process.argv[1]}`) {
  const release = process.argv[2]
  if (!release) {
    console.error("Usage: license-soak.mjs <release commit>")
    process.exit(2)
  }
  let base
  try {
    base = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--exclude", "*-*", `${release}^`)
  } catch {
    console.log("No earlier stable release; nothing to compare.")
    process.exit(0)
  }
  const commits = git("log", "--format=%H%x09%s", `${base}..${release}`, "--", ...LICENSE_PATHS)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split("\t")
      return { sha, subject: subject.join("\t") }
    })
  const nightlies = new Map(commits.map(({ sha }) => [sha, git("tag", "--contains", sha, "--list", "v*-nightly.*").split("\n").filter(Boolean)]))
  const problems = soakProblems(commits, nightlies, Date.now())
  if (problems.length > 0) {
    for (const problem of problems) console.log(`::error::${problem}`)
    console.log(`::error::Licensing changes need ${SOAK_HOURS} hours on the nightly channel before a stable release (RELEASING.md, licensing invariants). Wait, or in an emergency run the stable promotion with allow_unsoaked_license_change.`)
    process.exit(1)
  }
  console.log(`${commits.length} licensing change(s) since ${base}, all on the nightly channel for at least ${SOAK_HOURS} hours.`)
}
