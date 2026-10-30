import { readTextCapped } from "../shared/capped-body"
import type { WhatsNewChange, WhatsNewEntry, WhatsNewState } from "../shared/ipc"
import type { KeyValueStore } from "./storage/secure-store"
import { compareVersions, RELEASE_FEED } from "./update-provider"

/**
 * Release notes for the What's new views, read from the GitHub releases the updater already
 * follows. Notes are generated per release from pull request titles (release-notes.sh), so
 * this only parses and presents them: stable builds see stable releases, nightly builds see
 * both channels. The newest version whose notes were shown is remembered on this machine;
 * the first run seeds it to the installed version, so notes announce future updates only.
 */

const SEEN_KEY = "app.whatsNewSeenVersion"
const CACHE_KEY = "app.whatsNewCache"
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_RELEASES = 40
const MAX_ENTRIES = 10
const MAX_CHANGES = 100

const repository = `${RELEASE_FEED.owner}/${RELEASE_FEED.repo}`
export const RELEASES_PAGE_URL = `https://github.com/${repository}/releases`

interface RawRelease {
  version: string
  channel: "stable" | "nightly"
  title: string
  publishedAt: string
  url: string
  changes: WhatsNewChange[]
  issues: WhatsNewChange[]
}

interface Cache {
  fetchedAt: number
  releases: RawRelease[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseBullet(line: string): WhatsNewChange | null {
  const text = line.replace(/^-\s+/, "").trim()
  if (!text) return null
  const link = /\((\[([^\]]+)\]\((https:[^)]+)\))\)\s*$/.exec(text)
  if (link) return { text: text.slice(0, link.index).trim().replace(/`/g, ""), reference: link[2] ?? null, url: link[3] ?? null }
  const commit = /\(\[([0-9a-f]{7,})\]\((https:[^)]+)\)\)\s*$/.exec(text)
  if (commit) return { text: text.slice(0, commit.index).trim().replace(/`/g, ""), reference: commit[1] ?? null, url: commit[2] ?? null }
  return { text: text.replace(/`/g, ""), url: null, reference: null }
}

/**
 * The Changes and Issues resolved bullets of generated release notes. The downloads
 * table and other sections are page furniture of the GitHub release, not notes.
 */
export function parseReleaseNotes(body: string): { changes: WhatsNewChange[]; issues: WhatsNewChange[] } {
  const changes: WhatsNewChange[] = []
  const issues: WhatsNewChange[] = []
  let section: "changes" | "issues" | "other" | null = null
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const name = heading[1]!.toLowerCase()
      section = name === "changes" || name === "source changes" ? "changes" : name === "issues resolved" ? "issues" : "other"
      continue
    }
    if ((section === "changes" || section === "issues") && line.startsWith("- ")) {
      const bullet = parseBullet(line)
      const target = section === "changes" ? changes : issues
      if (bullet && target.length < MAX_CHANGES) target.push(bullet)
    }
  }
  return { changes, issues }
}

function parseRelease(value: unknown): RawRelease | null {
  if (!record(value)) return null
  const tag = typeof value.tag_name === "string" ? value.tag_name : ""
  const version = tag.replace(/^v/, "")
  if (!/^\d+\.\d+\.\d+(-nightly\.[\d.]+)?$/.test(version) || value.draft === true) return null
  const nightly = version.includes("-nightly.") || value.prerelease === true
  const notes = parseReleaseNotes(typeof value.body === "string" ? value.body : "")
  return {
    version,
    channel: nightly ? "nightly" : "stable",
    title: typeof value.name === "string" && value.name.trim() ? value.name.trim() : version,
    publishedAt: typeof value.published_at === "string" ? value.published_at : "",
    url: typeof value.html_url === "string" && value.html_url.startsWith("https://github.com/") ? value.html_url : RELEASES_PAGE_URL,
    ...notes,
  }
}

export class WhatsNew {
  private cache: Cache | null = null
  private loading: Promise<{ releases: RawRelease[]; error: string | null }> | null = null
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(
    private readonly store: KeyValueStore,
    private readonly options: { currentVersion: () => string; fetchImpl?: typeof fetch; now?: () => number },
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async state(): Promise<WhatsNewState> {
    const currentVersion = this.options.currentVersion()
    const seen = this.seenVersion(currentVersion)
    const { releases, error } = await this.releases()
    const nightlyBuild = currentVersion.includes("-nightly.")
    const mapped: WhatsNewEntry[] = releases.map((release) => {
      const installed = compareVersions(release.version, currentVersion) <= 0
      // A release newer than the build is a pending update, not news about
      // this install: it stays listed for the update card but never unseen.
      return { ...release, installed, unseen: installed && compareVersions(release.version, seen) > 0 }
    })
    // The dialog lists installed releases of this build's channel. Newer
    // releases of either channel ride along so the update card can show a
    // pending update's notes, also when it comes from the other channel.
    // The limit applies to the installed group alone, so a run of newer
    // releases can never push the installed ones out of the list.
    const entries: WhatsNewEntry[] = [
      ...mapped.filter((entry) => !entry.installed),
      ...mapped.filter((entry) => entry.installed && (nightlyBuild || entry.channel === "stable")).slice(0, MAX_ENTRIES),
    ]
    return {
      currentVersion,
      lastSeenVersion: seen,
      entries,
      hasUnseen: entries.some((entry) => entry.unseen),
      announceStable: !nightlyBuild && entries.some((entry) => entry.unseen && entry.channel === "stable" && compareVersions(entry.version, currentVersion) <= 0),
      error: entries.length ? null : error,
    }
  }

  async markSeen(): Promise<WhatsNewState> {
    this.store.set(SEEN_KEY, this.options.currentVersion())
    return this.state()
  }

  /** First run ever: the installed version counts as seen, so only later updates announce. */
  private seenVersion(currentVersion: string): string {
    const seen = this.store.get(SEEN_KEY)
    if (seen && /^\d+\.\d+\.\d+(-nightly\.[\d.]+)?$/.test(seen)) return seen
    this.store.set(SEEN_KEY, currentVersion)
    return currentVersion
  }

  private releases(): Promise<{ releases: RawRelease[]; error: string | null }> {
    if (this.cache && this.now() - this.cache.fetchedAt < CACHE_TTL_MS) return Promise.resolve({ releases: this.cache.releases, error: null })
    this.loading ??= this.load().finally(() => { this.loading = null })
    return this.loading
  }

  private async load(): Promise<{ releases: RawRelease[]; error: string | null }> {
    try {
      const response = await this.fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=${MAX_RELEASES}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `TenuVault/${this.options.currentVersion()}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`GitHub answered ${response.status}.`)
      const text = await readTextCapped(response, 3_000_000)
      if (text === null) throw new Error("The release list was larger than expected.")
      const payload: unknown = JSON.parse(text)
      if (!Array.isArray(payload)) throw new Error("GitHub returned an unexpected release list.")
      const releases = payload.flatMap((value) => {
        const release = parseRelease(value)
        return release ? [release] : []
      }).sort((a, b) => compareVersions(b.version, a.version))
      this.cache = { fetchedAt: this.now(), releases }
      try { this.store.set(CACHE_KEY, JSON.stringify(this.cache)) } catch { /* The in-memory copy still serves this run. */ }
      return { releases, error: null }
    } catch (error) {
      const cached = this.storedCache()
      if (cached) {
        this.cache = cached
        return { releases: cached.releases, error: null }
      }
      return { releases: [], error: `The release notes could not be loaded. ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private storedCache(): Cache | null {
    try {
      const parsed: unknown = JSON.parse(this.store.get(CACHE_KEY) ?? "null")
      if (!record(parsed) || typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.releases)) return null
      const releases = parsed.releases.filter((value): value is RawRelease =>
        record(value) && typeof value.version === "string" && (value.channel === "stable" || value.channel === "nightly") &&
        typeof value.title === "string" && typeof value.publishedAt === "string" && typeof value.url === "string" &&
        Array.isArray(value.changes) && Array.isArray(value.issues))
      return releases.length ? { fetchedAt: parsed.fetchedAt, releases } : null
    } catch {
      return null
    }
  }
}
