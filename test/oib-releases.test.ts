import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { loadPack, oibDownloads, oibPack, oibReleases, oibVersions, parseReleaseManifest, resetOibSource, resolveMain, setOibCacheDir } from "../src/main/oib/source"
import { defaultSelection, isPrerelease, oibReference, platformStatus, selectionLabel } from "../src/shared/oib/versions"

const MAIN = "a".repeat(40)
const V40 = "b".repeat(40)
const V38 = "c".repeat(40)
const MAC = "d".repeat(40)
const MACBETA = "e".repeat(40)
const IOSBETA = "9".repeat(40)
const WIN = "WINDOWS/IntuneManagement/SettingsCatalog/Win - OIB - SC - Test.json"
const MACOS = "MACOS/IntuneManagement/SettingsCatalog/Mac - OIB - SC - Test.json"

/** The commit each release ref (tag or beta branch) resolves to. */
const COMMITS: Record<string, string> = {
  "windows-v4.0": V40,
  "windows-v3.8": V38,
  "macos-v1.0": MAC,
  "macos-v2.0-beta": MACBETA,
  "ios-v1.0-beta": IOSBETA,
}

/** A releases.json manifest like the upstream one: stable Windows tags, an unstable + beta macOS pair, beta-only iOS, in-development Android and BYOD. */
const MANIFEST = {
  manifestVersion: "1.0",
  repository: "https://github.com/SkipToTheEndpoint/OpenIntuneBaseline",
  platforms: [
    {
      id: "windows", name: "Windows", folder: "WINDOWS", status: "available", defaultBranch: "main", changelog: "/WINDOWS/CHANGELOG.md",
      releases: [
        { version: "4.0", name: "26H2 Edition", channel: "stable", releaseDate: "2026-09-30", branch: "main", tag: "windows-v4.0", url: "https://example/windows-v4.0", prerelease: false },
        { version: "3.8", channel: "stable", releaseDate: "2026-05-08", branch: "main", tag: "windows-v3.8", url: "https://example/windows-v3.8", prerelease: false },
      ],
    },
    {
      id: "macos", name: "MacOS", folder: "MACOS", status: "available", defaultBranch: "main",
      releases: [
        { version: "1.0", channel: "unstable", releaseDate: "2024-09-02", branch: "main", tag: "macos-v1.0", url: "https://example/macos-v1.0", prerelease: false },
        { version: "2.0", channel: "beta", releaseDate: "2026-01-28", branch: "macos-v2.0-beta", tag: null, url: "https://example/macos-v2.0-beta", prerelease: true },
      ],
    },
    {
      id: "ios", name: "iOS", folder: "IOS", status: "available", defaultBranch: "main",
      releases: [
        { version: "1.0", channel: "beta", releaseDate: "2026-10-15", branch: "ios-v1.0-beta", tag: null, url: "https://example/ios-v1.0-beta", prerelease: true },
      ],
    },
    { id: "android", name: "Android", folder: "ANDROID", status: "in-development", defaultBranch: "main", releases: [] },
    { id: "byod", name: "BYOD", folder: "BYOD", status: "in-development", defaultBranch: "main", releases: [] },
  ],
}

/** GitHub serving the manifest, the main commit, each release ref and the pack files; `offline` fails every request. */
function github(options: { main?: string; offline?: boolean; manifest?: unknown } = {}) {
  const requested: string[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    if (options.offline) throw new TypeError("fetch failed")
    if (url.endsWith("/releases.json")) return Response.json(options.manifest ?? MANIFEST)
    const ref = /\/commits\/([^?]+)$/.exec(url)?.[1]
    if (ref) {
      const name = decodeURIComponent(ref)
      const sha = name === "main" ? options.main ?? MAIN : COMMITS[name]
      if (!sha) return new Response("Not Found", { status: 404 })
      return Response.json({ sha, commit: { committer: { date: "2026-09-30T00:00:00Z" } } })
    }
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [{ type: "blob", path: WIN }, { type: "blob", path: MACOS }, { type: "blob", path: "README.md" }] })
    if (url.startsWith("https://raw.githubusercontent.com/")) return Response.json({ name: url.includes("MACOS") ? "Mac - OIB - SC - Test" : "Win - OIB - SC - Test", settings: [] })
    throw new Error(`Unexpected source: ${url}`)
  })
  vi.stubGlobal("fetch", fetcher)
  return { fetcher, requested }
}

let dir: string | null = null
beforeEach(() => { resetOibSource(); setOibCacheDir(null) })
afterEach(() => {
  vi.unstubAllGlobals()
  setOibCacheDir(null)
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})
const useCache = () => { dir = mkdtempSync(join(tmpdir(), "oib-cache-")); setOibCacheDir(dir); return dir }

it("maps manifest platform ids and keeps only well-formed releases", () => {
  const { platforms } = parseReleaseManifest({
    platforms: [
      { id: "windows365", status: "available", releases: [{ version: "1.0", channel: "unstable", releaseDate: "2024-09-02", branch: "main", tag: "win365-v1.0", prerelease: false }] },
      { id: "macos", status: "available", releases: [{ version: "2.0", channel: "beta", releaseDate: "2026-01-28", branch: "macos-v2.0-beta", tag: null, prerelease: true }, { version: "bad", releaseDate: "not-a-date" }] },
      { id: "android", status: "in-development", releases: [] },
      { id: "unknown-platform", status: "available", releases: [] },
      { id: "toString", status: "available", releases: [] },
    ],
  })
  // windows365 maps to win365, the malformed macOS release drops, and unknown or prototype platform ids are ignored.
  expect(platforms.map(p => p.platform)).toEqual(["win365", "macos", "android"])
  expect(platforms[0]!.releases).toEqual([{ platform: "win365", version: "1.0", channel: "unstable", prerelease: false, releaseDate: "2024-09-02", branch: "main", tag: "win365-v1.0" }])
  expect(platforms[1]!.releases.map(r => r.version)).toEqual(["2.0"])
  expect(platforms[1]!.releases[0]).toMatchObject({ platform: "macos", branch: "macos-v2.0-beta", prerelease: true })
  expect(platforms[1]!.releases[0]!.tag).toBeUndefined()
  expect(() => parseReleaseManifest({})).toThrow("unexpected release manifest")
})

it("resolves main and every manifest release, pinning each to its tag or beta branch commit", async () => {
  const { fetcher } = github()
  const versions = await oibVersions()
  expect(versions.main).toEqual({ commit: MAIN, committedAt: "2026-09-30T00:00:00Z" })
  expect(versions.platforms).toEqual([
    { platform: "windows", status: "available", changelog: "/WINDOWS/CHANGELOG.md" },
    { platform: "macos", status: "available" },
    { platform: "ios", status: "available" },
    { platform: "android", status: "in-development" },
    { platform: "byod", status: "in-development" },
  ])
  // Newest first by release date: iOS v1.0 beta, Windows v4.0, Windows v3.8, macOS v2.0 beta, macOS v1.0.
  expect(versions.releases.map(r => `${r.tag}@${r.commit}`)).toEqual([`ios-v1.0-beta@${IOSBETA}`, `windows-v4.0@${V40}`, `windows-v3.8@${V38}`, `macos-v2.0-beta@${MACBETA}`, `macos-v1.0@${MAC}`])
  // Manifest, main and five distinct release refs; a second read is cached.
  await oibVersions()
  expect(fetcher).toHaveBeenCalledTimes(7)
})

it("defaults to the newest non-prerelease release, and to the newest release when prereleases are allowed", async () => {
  const versions = (github(), await oibVersions())
  expect(defaultSelection(versions, "windows")).toEqual({ commit: V40, tag: "windows-v4.0" })
  // macOS v2.0 is a beta prerelease, so the default is the older published v1.0 (unstable channel, not a prerelease).
  expect(defaultSelection(versions, "macos")).toEqual({ commit: MAC, tag: "macos-v1.0" })
  expect(isPrerelease(versions.releases.find(r => r.tag === "macos-v1.0")!)).toBe(false)
  expect(isPrerelease(versions.releases.find(r => r.tag === "macos-v2.0-beta")!)).toBe(true)
  expect(defaultSelection(versions, "macos", true)).toEqual({ commit: MACBETA, tag: "macos-v2.0-beta" })
  // iOS only has a beta release and no iOS content on main, so the beta is the default even without the toggle.
  expect(defaultSelection(versions, "ios")).toEqual({ commit: IOSBETA, tag: "ios-v1.0-beta" })
  expect(selectionLabel(defaultSelection(versions, "ios"))).toBe("v1.0 beta")
  // BYOD has no release, so it uses main; shipped platforms stay available even when the manifest lists them as in development.
  expect(defaultSelection(versions, "byod")).toEqual({ commit: MAIN })
  expect(platformStatus(versions, "byod")).toBe("available")
  expect(platformStatus(versions, "android")).toBe("in-development")
  expect(platformStatus(versions, "ios")).toBe("available")
  expect(selectionLabel(defaultSelection(versions, "macos", true))).toBe("v2.0 beta")
  expect(selectionLabel(defaultSelection(versions, "byod"))).toBe(`main @ ${MAIN.slice(0, 7)}`)
})

it("loads a release only for its own platform and tag, including a beta branch release", async () => {
  github()
  await expect(loadPack("windows", V40, "windows-v4.0")).rejects.toThrow("Reload")
  await oibVersions()
  expect((await loadPack("windows", V40, "windows-v4.0")).catalog).toMatchObject({ commit: V40, tag: "windows-v4.0", reference: `OpenIntuneBaseline Windows v4.0 · windows-v4.0 @ ${V40.slice(0, 7)}` })
  expect((await loadPack("macos", MACBETA, "macos-v2.0-beta")).catalog).toMatchObject({ commit: MACBETA, tag: "macos-v2.0-beta", reference: `OpenIntuneBaseline macOS v2.0 beta · macos-v2.0-beta @ ${MACBETA.slice(0, 7)}` })
  await expect(loadPack("macos", V40, "windows-v4.0")).rejects.toThrow("Reload")
  await expect(loadPack("windows", V40, "windows-v3.8")).rejects.toThrow("Reload")
  await expect(loadPack("windows", V40, 42)).rejects.toThrow("Reload")
  await expect(loadPack("windows", "f".repeat(40))).rejects.toThrow("Reload")
  // Without a tag, a release commit reads as its release; other resolved commits read as main.
  expect((await loadPack("windows", V38)).catalog.reference).toContain("windows-v3.8 @")
  expect((await loadPack("windows", MAIN)).catalog.reference).toBe(`OpenIntuneBaseline Windows · main @ ${MAIN.slice(0, 7)}`)
})

it("names a release commit after its release, and downloads it once for every label", async () => {
  const { requested } = github({ main: V40 })
  await oibVersions()
  const [untagged, tagged] = await Promise.all([loadPack("windows", V40), loadPack("windows", V40, "windows-v4.0")])
  // Main and the release share the commit, so the files are the release's.
  expect(untagged.catalog.reference).toContain("· windows-v4.0 @")
  expect(tagged.catalog.reference).toContain("· windows-v4.0 @")
  expect((await oibPack("windows", V40, "windows-v4.0")).reference).toContain("· windows-v4.0 @")
  expect(requested.filter(url => url.includes(encodeURIComponent("Win - OIB - SC - Test.json")))).toHaveLength(1)
  expect((await loadPack("macos", V40)).catalog.reference).toContain("macOS · main @")
})

it("lists the repository once per commit and downloads a pack once for concurrent loads", async () => {
  const { requested } = github()
  await oibVersions()
  await Promise.all([loadPack("windows", MAIN), loadPack("windows", MAIN), loadPack("macos", MAIN)])
  expect(requested.filter(url => url.includes("/git/trees/"))).toHaveLength(1)
  expect(requested.filter(url => url.includes(encodeURIComponent("Win - OIB - SC - Test.json")))).toHaveLength(1)
  expect(oibDownloads()).toEqual([])
})

it("reuses packs from disk after a restart and works offline with the last known versions", async () => {
  const cache = useCache()
  github()
  await oibVersions()
  await loadPack("windows", V40, "windows-v4.0")
  expect(readdirSync(join(cache, "packs"))).toEqual([`${V40}-windows.json`])

  resetOibSource()
  const { requested } = github({ offline: true })
  const versions = await oibVersions()
  expect(versions.warning).toContain("Showing the versions known on")
  expect(versions.releases.map(r => r.tag)).toEqual(["ios-v1.0-beta", "windows-v4.0", "windows-v3.8", "macos-v2.0-beta", "macos-v1.0"])
  expect(versions.platforms.map(p => p.platform)).toEqual(["windows", "macos", "ios", "android", "byod"])
  const requestsBefore = requested.length
  const pack = await loadPack("windows", V40, "windows-v4.0")
  expect(pack.catalog.policies).toHaveLength(1)
  expect(requested).toHaveLength(requestsBefore)
  // Not on disk and GitHub unreachable: a clear failure, not a partial pack.
  await expect(loadPack("macos", MAC, "macos-v1.0")).rejects.toThrow()
})

it("downloads again when a cached pack is damaged", async () => {
  const cache = useCache()
  github()
  await oibVersions()
  await loadPack("windows", MAIN)
  writeFileSync(join(cache, "packs", `${MAIN}-windows.json`), JSON.stringify({ format: 1, platform: "windows", commit: MAIN, files: [{ path: WIN, json: "not a policy" }], manifest: null }))
  resetOibSource()
  const { requested } = github()
  await oibVersions()
  expect((await loadPack("windows", MAIN)).catalog.policies).toHaveLength(1)
  expect(requested.some(url => url.startsWith("https://raw.githubusercontent.com/"))).toBe(true)
})

it("fails without GitHub and without stored versions, and retries on the next call", async () => {
  github({ offline: true })
  await expect(oibVersions()).rejects.toThrow("fetch failed")
  github()
  expect((await oibVersions()).main.commit).toBe(MAIN)
})

it("reuses the offline versions briefly instead of retrying GitHub on every request", async () => {
  useCache()
  github()
  await oibVersions()
  resetOibSource()
  const { fetcher } = github({ offline: true })
  await oibVersions()
  const calls = fetcher.mock.calls.length
  await oibVersions()
  expect(fetcher.mock.calls.length).toBe(calls)
  // An explicit retry asks GitHub again.
  github()
  expect((await oibVersions(true)).warning).toBeUndefined()
})

it("offers each platform's newest non-prerelease release as its upgrade, and main where none is published", async () => {
  github()
  const { releases, warning } = await oibReleases()
  expect(warning).toBeUndefined()
  expect(releases.find(r => r.platform === "windows")).toMatchObject({ tag: "windows-v4.0", commit: V40, reference: oibReference("windows", V40, "windows-v4.0"), publishedAt: "2026-09-30" })
  expect(releases.find(r => r.platform === "macos")).toMatchObject({ tag: "macos-v1.0", commit: MAC, publishedAt: "2024-09-02" })
  // iOS has only its beta release, so the beta is offered instead of an empty main.
  expect(releases.find(r => r.platform === "ios")).toMatchObject({ tag: "ios-v1.0-beta", commit: IOSBETA, publishedAt: "2026-10-15" })
  expect(releases.find(r => r.platform === "byod")).toMatchObject({ tag: `main @ ${MAIN.slice(0, 7)}`, commit: MAIN, reference: `OpenIntuneBaseline BYOD · main @ ${MAIN.slice(0, 7)}` })
})

it("resolves releases on demand for the baseline features", async () => {
  github()
  expect((await oibPack("windows", V38)).reference).toContain("windows-v3.8 @")
  await expect(oibPack("windows", "f".repeat(40))).rejects.toThrow("Reload")
  await resolveMain()
})

it("warns when a manifest release cannot be resolved instead of silently falling back", async () => {
  github({ manifest: { platforms: [{ id: "windows", status: "available", releases: [
    { version: "9.9", channel: "stable", releaseDate: "2026-11-01", branch: "main", tag: "windows-v9.9", prerelease: false },
    { version: "4.0", channel: "stable", releaseDate: "2026-09-30", branch: "main", tag: "windows-v4.0", prerelease: false },
  ] }] } })
  const versions = await oibVersions()
  expect(versions.warning).toContain("could not be read (Windows v9.9)")
  expect(versions.releases.map(r => r.tag)).toEqual(["windows-v4.0"])
  expect(defaultSelection(versions, "windows")).toEqual({ commit: V40, tag: "windows-v4.0" })
})

it("reads versions stored before the manifest when offline", async () => {
  const cache = useCache()
  // The pre-manifest shape: publishedAt only, and no version, branch, channel or platform list.
  writeFileSync(join(cache, "versions.json"), JSON.stringify({ format: 1, savedAt: "2026-10-01T00:00:00Z", versions: {
    main: { commit: MAIN },
    releases: [{ platform: "windows", tag: "windows-v4.0", commit: V40, publishedAt: "2026-09-30T00:00:00Z" }],
  } }))
  github({ offline: true })
  const versions = await oibVersions()
  expect(versions.warning).toContain("Showing the versions known on")
  expect(versions.releases).toEqual([{ platform: "windows", version: "4.0", channel: "stable", prerelease: false, releaseDate: "2026-09-30T00:00:00Z", branch: "main", tag: "windows-v4.0", commit: V40 }])
  expect(versions.platforms).toEqual([{ platform: "windows", status: "available" }])
  expect(platformStatus(versions, "byod")).toBe("available")
})
