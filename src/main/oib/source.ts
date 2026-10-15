import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { record } from "../../shared/frameworks/policies"
import { typeForFolder, type Item } from "../../shared/intune/registry"
import { catalogPolicies, parseManifest, type Manifest } from "../../shared/oib/manifest"
import { OIB_LICENSE, OIB_MANIFEST_IDS, OIB_PLATFORMS, OIB_REPO, type OibCatalog, type OibChannel, type OibPlatform, type OibPlatformInfo, type OibPlatformStatus, type OibPublishedRelease, type OibVersions } from "../../shared/oib/types"
import { defaultSelection, oibReference, platformStatus, RELEASE_TAG, selectionLabel, tagPlatform, tagVersion } from "../../shared/oib/versions"
import { FrameworkError } from "../frameworks/service"

/**
 * OpenIntuneBaseline content from GitHub. The versions a session may load are resolved here: the
 * commit main points to and the commit of every published platform release tag. Every read uses
 * one of those commits, so a comparison and the deploy that follows it see the same files. Only
 * commits resolved here are loaded; no source URL comes from the renderer.
 *
 * Content at a commit never changes, so downloaded packs are kept on disk by commit and reused
 * after a restart without contacting GitHub.
 */

const API = `https://api.github.com/repos/${OIB_REPO}`
const RAW = `https://raw.githubusercontent.com/${OIB_REPO}`
const SHA = /^[0-9a-f]{40}$/
const MAX_FILES = 200
const MAX_FILE_BYTES = 5_000_000
const HEAD_TTL = 10 * 60_000
const DOWNLOAD_CONCURRENCY = 8
const CACHE_FORMAT = 1
const CACHED_PACKS = 24
/** How long versions read from disk are reused before GitHub is tried again. */
const OFFLINE_TTL = 60_000

/** Pack folders below the platform folder and the registry folder their files are created in. */
const PACK_FOLDERS: Array<[string, string]> = [
  ["IntuneManagement/SettingsCatalog/", "ConfigurationPolicies"],
  ["IntuneManagement/CompliancePolicies/", "CompliancePolicies"],
  ["IntuneManagement/UpdatePolicies/", "DeviceConfigurations"],
  ["IntuneManagement/DeviceConfiguration/", "DeviceConfigurations"],
  ["IntuneManagement/DriverUpdateProfiles/", "DriverUpdateProfiles"],
  ["IntuneManagement/AdministrativeTemplates/", "GroupPolicyConfigurations"],
  // NativeImport holds the Settings Catalog policies again in the portal's import format.
  ["NativeImport/", "ConfigurationPolicies"],
  // BYOD app protection: the registry folder depends on the policy's @odata.type.
  ["AppProtection/", "AppProtection"],
]

const APP_PROTECTION: Record<string, string> = {
  "#microsoft.graph.iosManagedAppProtection": "AppProtectionIOS",
  "#microsoft.graph.androidManagedAppProtection": "AppProtectionAndroid",
}

export interface PackItem {
  folder: string
  name: string
  source: string
  snapshot: Item
}

export interface LoadedPack {
  catalog: OibCatalog
  items: Map<string, PackItem>
}

/** Commit resolved for each ref (branch or tag), cached for ten minutes. */
const refCommits = new Map<string, { commit: string; committedAt?: string; expires: number }>()
let versions: { value: OibVersions; expires: number } | null = null
/** Commits main pointed to, plus commits recorded by this app (runs, baseline provenance). */
const resolved = new Set<string>()
/** `platform:commit:tag` of every published release resolved in this session. */
const tagged = new Set<string>()
const packs = new Map<string, LoadedPack>()
/** Pack content by `platform:commit`, shared by every label the pack is loaded as. */
const contents = new Map<string, Promise<PackContent>>()
const trees = new Map<string, Promise<string[]>>()
const downloads = new Map<string, { platform: OibPlatform; commit: string; done: number; total: number }>()
let cacheDir: string | null = null

/** Where downloaded packs and the last known versions are kept; null keeps everything in memory. */
export function setOibCacheDir(dir: string | null): void {
  cacheDir = dir
}

/** Forgets resolved commits and cached packs held in memory. */
export function resetOibSource(): void {
  refCommits.clear()
  versions = null
  resolved.clear()
  tagged.clear()
  packs.clear()
  contents.clear()
  trees.clear()
  downloads.clear()
}

async function download(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) {
    // The path (with its commit) goes to the log only; people see the status.
    console.warn(`[oib] GitHub returned ${response.status} for ${new URL(url).pathname}`)
    throw new FrameworkError(`GitHub returned ${response.status}.${response.status === 403 || response.status === 429 ? " GitHub limits requests per network; retry later." : ""}`, 502)
  }
  const text = await response.text()
  if (text.length > MAX_FILE_BYTES) throw new FrameworkError("An OIB source file is larger than expected.", 502)
  return text
}

/** Parses an OIB file. Some are saved with a UTF-8 byte order mark, which JSON.parse rejects. */
export function parsePackFile(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, ""))
}

async function github(url: string): Promise<unknown> {
  const text = await download(url)
  try {
    return parsePackFile(text)
  } catch {
    throw new FrameworkError("GitHub returned an unexpected response.", 502)
  }
}

/** The commit a validated release ref points to now (cached for ten minutes). Dot segments never reach the URL. */
export async function resolveRef(ref: string): Promise<{ commit: string; committedAt?: string }> {
  if (ref.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new FrameworkError("GitHub returned an unexpected commit.", 502)
  const cached = refCommits.get(ref)
  if (cached && cached.expires > Date.now()) return { commit: cached.commit, committedAt: cached.committedAt }
  const json = await github(`${API}/commits/${ref.split("/").map(encodeURIComponent).join("/")}`)
  if (!record(json) || typeof json.sha !== "string" || !SHA.test(json.sha)) throw new FrameworkError("GitHub returned an unexpected commit.", 502)
  const committedAt = record(json.commit) && record(json.commit.committer) && typeof json.commit.committer.date === "string" ? json.commit.committer.date : undefined
  refCommits.set(ref, { commit: json.sha, committedAt, expires: Date.now() + HEAD_TTL })
  return { commit: json.sha, committedAt }
}

/** The commit the OIB main branch points to now (cached for ten minutes). Only main commits are loadable untagged. */
export async function resolveMain(): Promise<{ commit: string; committedAt?: string }> {
  const main = await resolveRef("main")
  resolved.add(main.commit)
  return main
}

/** A release the releases.json manifest lists, before its ref is resolved to a commit. */
interface ManifestRelease {
  platform: OibPlatform
  version: string
  name?: string
  channel: OibChannel
  prerelease: boolean
  releaseDate: string
  branch: string
  /** The published tag, or undefined for beta releases that only live on a branch. */
  tag?: string
  url?: string
}

interface ParsedManifest {
  platforms: Array<{ platform: OibPlatform; status: OibPlatformStatus; changelog?: string; releases: ManifestRelease[] }>
  /** Readable labels of releases left out as malformed, so oibVersions can warn about them. */
  dropped: string[]
}

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
const asChannel = (value: unknown): OibChannel => (value === "beta" || value === "unstable" ? value : "stable")

/**
 * The releases.json manifest: the platforms upstream publishes, each with its development status
 * and releases. Malformed platforms or releases are left out rather than failing the whole read.
 */
export function parseReleaseManifest(value: unknown): ParsedManifest {
  if (!record(value) || !Array.isArray(value.platforms)) throw new FrameworkError("GitHub returned an unexpected release manifest.", 502)
  const dropped: string[] = []
  const platforms = value.platforms.filter(record).flatMap((entry): ParsedManifest["platforms"] => {
    const platform = typeof entry.id === "string" && Object.hasOwn(OIB_MANIFEST_IDS, entry.id) ? OIB_MANIFEST_IDS[entry.id] : undefined
    if (!platform) return []
    const status: OibPlatformStatus = entry.status === "available" ? "available" : "in-development"
    const changelog = asText(entry.changelog)
    const releases = Array.isArray(entry.releases) ? entry.releases.filter(record).flatMap((release): ManifestRelease[] => {
      const version = asText(release.version)
      const releaseDate = asText(release.releaseDate)
      const branch = asText(release.branch) || "main"
      const tag = asText(release.tag) || undefined
      // A release only counts when its tag or beta branch names this platform and version
      // (windows-v4.0, macos-v2.0-beta). Anything else, including raw commits, other branches
      // and other platforms' tags, must never become a loadable release.
      const ref = tag ?? branch
      const suffix = RELEASE_TAG.exec(ref)?.[3]?.toLowerCase()
      if (!version || !releaseDate || !Number.isFinite(Date.parse(releaseDate)) || tagPlatform(ref) !== platform || tagVersion(ref) !== `v${version}` || (suffix !== undefined && suffix !== "beta" && suffix !== "unstable")) {
        dropped.push(version ? `${OIB_PLATFORMS[platform].label} v${version}` : `${OIB_PLATFORMS[platform].label} release`)
        return []
      }
      return [{
        platform, version, channel: asChannel(release.channel), prerelease: release.prerelease === true,
        releaseDate, branch, ...(tag ? { tag } : {}),
        ...(asText(release.name) ? { name: asText(release.name) } : {}),
        ...(asText(release.url) ? { url: asText(release.url) } : {}),
      }]
    }) : []
    return [{ platform, status, ...(changelog ? { changelog } : {}), releases }]
  })
  return { platforms, dropped }
}

/** Reads releases.json from the repository's main branch. */
async function getReleaseManifest(): Promise<ParsedManifest> {
  return parseReleaseManifest(await github(`${RAW}/main/releases.json`))
}

function admit(value: OibVersions): void {
  resolved.add(value.main.commit)
  // Release commits are loadable only as their own platform's release, never as another platform's main.
  for (const release of value.releases) tagged.add(`${release.platform}:${release.commit}:${release.tag}`)
}

/**
 * The versions this session can load: main and the releases.json manifest releases, each pinned to
 * the commit its tag or beta branch points to (cached for ten minutes). Without GitHub, the versions
 * known from the last successful read are offered with a warning, so packs already on disk stay usable.
 */
export async function oibVersions(retry = false): Promise<OibVersions> {
  // An explicit retry skips versions read from disk, so it really asks GitHub again.
  if (versions && versions.expires > Date.now() && !(retry && versions.value.warning)) return versions.value
  try {
    const [manifest, main] = await Promise.all([getReleaseManifest(), resolveMain()])
    const platforms: OibPlatformInfo[] = manifest.platforms.map((entry) => ({ platform: entry.platform, status: entry.status, ...(entry.changelog ? { changelog: entry.changelog } : {}) }))
    const unresolved: string[] = [...manifest.dropped]
    const resolvedReleases = await Promise.all(manifest.platforms.flatMap((entry) => entry.releases).map(async (release): Promise<OibPublishedRelease | null> => {
      const ref = release.tag ?? release.branch
      try {
        const { commit } = await resolveRef(ref)
        return { platform: release.platform, version: release.version, ...(release.name ? { name: release.name } : {}), channel: release.channel, prerelease: release.prerelease, releaseDate: release.releaseDate, branch: release.branch, tag: ref, commit, ...(release.url ? { url: release.url } : {}) }
      } catch (error) {
        console.warn(`[oib] ${release.platform} ${release.version} (${ref}) could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
        unresolved.push(`${OIB_PLATFORMS[release.platform].label} v${release.version}`)
        return null
      }
    }))
    const releases = resolvedReleases.filter((release): release is OibPublishedRelease => release !== null).sort((a, b) => Date.parse(b.releaseDate) - Date.parse(a.releaseDate))
    // A release that cannot be resolved must be visible: its platform would otherwise silently fall back to main or an older release.
    const warning = unresolved.length ? `Some OpenIntuneBaseline releases could not be read (${unresolved.join(", ")}). Those platforms may show main or an older release until the versions are refreshed.` : undefined
    const value: OibVersions = { main, platforms, releases, ...(warning ? { warning } : {}) }
    admit(value)
    versions = { value, expires: Date.now() + HEAD_TTL }
    await writeCache("versions.json", { format: CACHE_FORMAT, savedAt: new Date().toISOString(), versions: value })
    return value
  } catch (error) {
    const stored = await readStoredVersions()
    if (!stored) throw error
    admit(stored.versions)
    const reason = error instanceof Error ? error.message : "GitHub could not be reached."
    const value: OibVersions = { ...stored.versions, warning: `${reason} Showing the versions known on ${new Date(stored.savedAt).toLocaleDateString()}.` }
    // Reused briefly, so a slow or failing network does not stall every request that needs versions.
    versions = { value, expires: Date.now() + OFFLINE_TTL }
    return value
  }
}

async function readStoredVersions(): Promise<{ savedAt: string; versions: OibVersions } | null> {
  const json = await readCache("versions.json")
  if (!record(json) || json.format !== CACHE_FORMAT || typeof json.savedAt !== "string" || !record(json.versions)) return null
  const { main, releases, platforms } = json.versions
  if (!record(main) || typeof main.commit !== "string" || !SHA.test(main.commit) || !Array.isArray(releases)) return null
  const known: OibPublishedRelease[] = []
  for (const release of releases) {
    if (!record(release) || typeof release.tag !== "string" || typeof release.commit !== "string" || !SHA.test(release.commit)) return null
    const platform = tagPlatform(release.tag)
    // A stored release that is not a release of its platform is skipped, not allowed to discard the whole cache.
    if (!platform || platform !== release.platform) continue
    // Versions stored before the manifest carry publishedAt and no version, branch or channel; derive them from the tag.
    const releaseDate = typeof release.releaseDate === "string" ? release.releaseDate : typeof release.publishedAt === "string" ? release.publishedAt : null
    const version = typeof release.version === "string" ? release.version : tagVersion(release.tag)?.slice(1)
    if (!releaseDate || !version || tagVersion(release.tag) !== `v${version}`) continue
    const channel: OibChannel = release.channel === "beta" || release.channel === "unstable" ? release.channel : "stable"
    known.push({ platform, version, ...(typeof release.name === "string" ? { name: release.name } : {}), channel, prerelease: release.prerelease === true, releaseDate, branch: typeof release.branch === "string" ? release.branch : "main", tag: release.tag, commit: release.commit, ...(typeof release.url === "string" ? { url: release.url } : {}) })
  }
  // Versions stored before the manifest have no platform list; the platforms with known releases are available.
  const knownPlatforms: OibPlatformInfo[] = []
  if (Array.isArray(platforms)) {
    for (const entry of platforms) {
      if (!record(entry) || typeof entry.platform !== "string" || !Object.hasOwn(OIB_PLATFORMS, entry.platform) || (entry.status !== "available" && entry.status !== "in-development")) return null
      knownPlatforms.push({ platform: entry.platform as OibPlatform, status: entry.status, ...(typeof entry.changelog === "string" ? { changelog: entry.changelog } : {}) })
    }
  } else {
    for (const platform of new Set(known.map((release) => release.platform))) knownPlatforms.push({ platform, status: "available" })
  }
  return { savedAt: json.savedAt, versions: { main: { commit: main.commit, ...(typeof main.committedAt === "string" ? { committedAt: main.committedAt } : {}) }, platforms: knownPlatforms, releases: known } }
}

async function readCache(name: string): Promise<unknown> {
  if (!cacheDir) return null
  try {
    return JSON.parse(await readFile(join(cacheDir, name), "utf8"))
  } catch {
    return null
  }
}

/** Writes a cache file atomically; a failed write only means the next session downloads again. */
async function writeCache(name: string, value: unknown): Promise<void> {
  if (!cacheDir) return
  const file = join(cacheDir, name)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await mkdir(join(file, ".."), { recursive: true })
    await writeFile(temporary, JSON.stringify(value))
    await rename(temporary, file)
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Keeps the most recently written packs. */
async function prunePacks(): Promise<void> {
  if (!cacheDir) return
  const dir = join(cacheDir, "packs")
  try {
    const files = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".json")).map(async (name) => ({ name, time: (await stat(join(dir, name))).mtimeMs })))
    for (const { name } of files.sort((a, b) => b.time - a.time).slice(CACHED_PACKS)) await rm(join(dir, name), { force: true })
  } catch {
    // Pruning is best effort.
  }
}

/**
 * The registry folder a pack file is created in, or undefined for files that are not part of a
 * pack. App protection files resolve by their @odata.type once the content is known.
 */
export function packFolder(platform: OibPlatform, path: string, snapshot?: Item): string | undefined {
  const root = OIB_PLATFORMS[platform].root
  if (!path.startsWith(root) || !path.toLowerCase().endsWith(".json")) return undefined
  const rest = path.slice(root.length)
  const folder = PACK_FOLDERS.find(([prefix]) => rest.startsWith(prefix) && !rest.slice(prefix.length).includes("/"))?.[1]
  if (folder !== "AppProtection" || !snapshot) return folder
  const type = snapshot["@odata.type"]
  return typeof type === "string" ? APP_PROTECTION[type] : undefined
}

/** Turns downloaded files into pack items, one per policy name and type, in pack folder order. */
export function packItems(platform: OibPlatform, files: Array<{ path: string; json: unknown }>): PackItem[] {
  const root = OIB_PLATFORMS[platform].root
  const rank = (path: string) => PACK_FOLDERS.findIndex(([prefix]) => path.slice(root.length).startsWith(prefix))
  const items: PackItem[] = []
  const seen = new Set<string>()
  for (const { path, json } of [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path))) {
    if (!record(json)) throw new FrameworkError(`${path} is not a policy export.`, 502)
    const folder = packFolder(platform, path, json as Item)
    const type = folder ? typeForFolder(folder) : undefined
    if (!type) throw new FrameworkError(`${path} is not a policy type TenuVault can deploy.`, 502)
    const name = json[type.nameKey] ?? json.displayName ?? json.name
    if (typeof name !== "string" || !name.trim()) throw new FrameworkError(`${path} has no policy name.`, 502)
    if (type.folder === "ConfigurationPolicies" && !Array.isArray(json.settings)) throw new FrameworkError(`${path} has no Settings Catalog settings.`, 502)
    const key = `${type.folder}:${name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    // Exports can carry the author's assignments and scope tags; deployments decide assignments
    // themselves, and scope tag IDs only exist in the author's tenant, so they go back to Default.
    const snapshot = { ...(json as Item) }
    delete snapshot.assignments
    if (Array.isArray(snapshot.roleScopeTagIds)) snapshot.roleScopeTagIds = ["0"]
    items.push({ folder: type.folder, name, source: path, snapshot })
  }
  return items
}

/**
 * Accepts a commit the main process recorded itself (a deployment run or the provenance of a
 * stored baseline), so its pack can be read again after a restart. Never call it with a commit
 * from a request: those must come from resolveMain or oibVersions.
 */
export function rememberCommit(commit: string): void {
  if (SHA.test(commit)) resolved.add(commit)
}

/** Downloaded pack files as kept on disk: the raw policy exports and PolicyManifest.json. */
interface PackContent {
  files: Array<{ path: string; json: unknown }>
  manifest: unknown
}

/** Blob paths of the repository at a commit, listed once for every platform. */
function treeOf(commit: string): Promise<string[]> {
  let pending = trees.get(commit)
  if (!pending) {
    pending = github(`${API}/git/trees/${commit}?recursive=1`).then((tree) => {
      if (!record(tree) || tree.truncated || !Array.isArray(tree.tree)) throw new FrameworkError("The OIB source listing is incomplete.", 502)
      return tree.tree.filter(record).filter((entry) => entry.type === "blob").map((entry) => entry.path).filter((path): path is string => typeof path === "string")
    })
    const own = pending
    own.catch(() => { if (trees.get(commit) === own) trees.delete(commit) })
    if (trees.size >= 8) trees.delete(trees.keys().next().value!)
    trees.set(commit, pending)
  }
  return pending
}

async function downloadPack(platform: OibPlatform, commit: string): Promise<PackContent> {
  const blobs = await treeOf(commit)
  const paths = blobs.filter((path) => packFolder(platform, path) !== undefined)
  if (!paths.length) throw new FrameworkError("The selected version contains no policies for this platform.", 502)
  if (paths.length > MAX_FILES) throw new FrameworkError("Unexpected OIB pack size.", 502)
  const raw = (path: string) => `${RAW}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`
  const manifestPath = `${OIB_PLATFORMS[platform].root}PolicyManifest.json`
  const hasManifest = blobs.includes(manifestPath)
  const key = `${platform}:${commit}`
  const progress = { platform, commit, done: 0, total: paths.length + (hasManifest ? 1 : 0) }
  downloads.set(key, progress)
  try {
    let manifest: unknown = null
    if (hasManifest) {
      try {
        manifest = parsePackFile(await download(raw(manifestPath)))
      } catch (error) {
        if (error instanceof FrameworkError) throw error
        throw new FrameworkError("PolicyManifest.json could not be read.", 502)
      }
      progress.done++
    }
    const files: Array<{ path: string; json: unknown }> = []
    for (let i = 0; i < paths.length; i += DOWNLOAD_CONCURRENCY) {
      files.push(...await Promise.all(paths.slice(i, i + DOWNLOAD_CONCURRENCY).map(async (path) => {
        const text = await download(raw(path))
        progress.done++
        try {
          return { path, json: parsePackFile(text) }
        } catch {
          throw new FrameworkError(`${path} is not valid JSON.`, 502)
        }
      })))
    }
    return { files, manifest }
  } finally {
    if (downloads.get(key) === progress) downloads.delete(key)
  }
}

const cacheName = (platform: OibPlatform, commit: string) => `packs/${commit}-${platform}.json`

async function readPackCache(platform: OibPlatform, commit: string): Promise<PackContent | null> {
  const json = await readCache(cacheName(platform, commit))
  if (!record(json) || json.format !== CACHE_FORMAT || json.platform !== platform || json.commit !== commit || !Array.isArray(json.files)) return null
  const files = json.files
  if (!files.length || !files.every((file) => record(file) && typeof file.path === "string" && packFolder(platform, file.path) !== undefined)) return null
  // Pruning keeps the most recently used packs, so a pinned release read every day stays on disk.
  if (cacheDir) await utimes(join(cacheDir, cacheName(platform, commit)), new Date(), new Date()).catch(() => undefined)
  return { files: files as PackContent["files"], manifest: json.manifest ?? null }
}

function buildPack(platform: OibPlatform, commit: string, tag: string | undefined, content: PackContent): LoadedPack {
  let manifest: Manifest | null = null
  if (content.manifest !== null) {
    try {
      manifest = parseManifest(content.manifest)
    } catch (error) {
      if (error instanceof FrameworkError) throw error
      throw new FrameworkError("PolicyManifest.json could not be read.", 502)
    }
  }
  const items = packItems(platform, content.files)
  const { policies, deprecated } = catalogPolicies(items, manifest)
  const catalog: OibCatalog = {
    platform, commit, ...(tag ? { tag } : {}), version: manifest?.version,
    reference: oibReference(platform, commit, tag, manifest?.version),
    source: `https://github.com/${OIB_REPO}/tree/${commit}/${OIB_PLATFORMS[platform].root}`,
    license: OIB_LICENSE, manifest: !!manifest, policies, deprecated,
  }
  return { catalog, items: new Map(items.map((item) => [item.source, item])) }
}

/** Reads a pack from disk, or downloads it and keeps it once it proved valid. */
async function fetchContent(platform: OibPlatform, commit: string): Promise<PackContent> {
  const cached = await readPackCache(platform, commit)
  if (cached) {
    try {
      buildPack(platform, commit, undefined, cached)
      return cached
    } catch {
      // Written by an older build or damaged: download it again.
    }
  }
  const content = await downloadPack(platform, commit)
  buildPack(platform, commit, undefined, content)
  await writeCache(cacheName(platform, commit), { format: CACHE_FORMAT, platform, commit, ...content })
  await prunePacks()
  return content
}

/** Pack content, read or downloaded once however many loads ask for it at the same time. */
function contentOf(platform: OibPlatform, commit: string): Promise<PackContent> {
  const key = `${platform}:${commit}`
  let pending = contents.get(key)
  if (!pending) {
    const own = fetchContent(platform, commit)
    own.catch(() => { if (contents.get(key) === own) contents.delete(key) })
    if (contents.size >= 8) contents.delete(contents.keys().next().value!)
    contents.set(key, own)
    pending = own
  }
  return pending
}

/**
 * The label a pack is loaded as. A tag must be a release resolved for this platform at this
 * commit; without a tag, a release commit reads as its release and other resolved commits as main.
 */
function labelOf(platform: OibPlatform, commit: string, tag: unknown): string | undefined | null {
  if (typeof tag === "string" && tag) return tagged.has(`${platform}:${commit}:${tag}`) ? tag : null
  if (tag !== undefined && tag !== null && tag !== "") return null
  // The newest release wins when several tags share the commit, so the label does not depend on read order.
  const release = versions?.value.releases.find((entry) => entry.platform === platform && entry.commit === commit && tagged.has(`${platform}:${commit}:${entry.tag}`))?.tag
    ?? [...tagged].find((key) => key.startsWith(`${platform}:${commit}:`))?.slice(`${platform}:${commit}:`.length)
  if (release) return release
  return resolved.has(commit) ? undefined : null
}

/** Loads one platform pack at a commit resolved by resolveMain or oibVersions. */
export async function loadPack(platform: OibPlatform, commit: unknown, tag?: unknown): Promise<LoadedPack> {
  const label = typeof commit === "string" && SHA.test(commit) ? labelOf(platform, commit, tag) : null
  if (label === null) throw new FrameworkError("The OpenIntuneBaseline source changed or expired. Reload it and try again.", 409)
  if (versions && platformStatus(versions.value, platform) === "in-development") throw new FrameworkError(`OpenIntuneBaseline has no published ${OIB_PLATFORMS[platform].label} baseline yet.`, 400)
  const sha = commit as string
  const key = `${platform}:${sha}:${label ?? "main"}`
  const cached = packs.get(key)
  if (cached) return cached
  let pack: LoadedPack
  try {
    pack = buildPack(platform, sha, label, await contentOf(platform, sha))
  } catch (error) {
    throw readableLoadError(platform, sha, label, error)
  }
  if (packs.size >= 8) packs.delete(packs.keys().next().value!)
  packs.set(key, pack)
  return pack
}

/** A load failure named by platform and release, with any repository path and commit kept for the log. */
function readableLoadError(platform: OibPlatform, commit: string, label: string | undefined, error: unknown): FrameworkError {
  const reason = error instanceof Error ? error.message : String(error)
  console.warn(`[oib] ${platform} pack at ${commit} could not be loaded: ${reason}`)
  const shown = reason.replace(new RegExp(`\\b${OIB_PLATFORMS[platform].root}(?:[^/]+/)*`, "g"), "").replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 7))
  return new FrameworkError(`OpenIntuneBaseline ${OIB_PLATFORMS[platform].label} ${selectionLabel({ commit, tag: label })} could not be loaded: ${shown}`, error instanceof FrameworkError ? error.status : 502)
}

/** Packs downloading now, for the progress line while a platform loads for the first time. */
export function oibDownloads(): Array<{ platform: OibPlatform; commit: string; done: number; total: number }> {
  return [...downloads.values()].map((entry) => ({ ...entry }))
}

/** A platform pack at a commit, in the shape the baseline features store as a frozen source. */
export interface OibPack {
  platform: OibPlatform
  commit: string
  reference: string
  source: string
  license: string
  items: PackItem[]
}

/**
 * The pack for the baseline features (custom baselines, upgrades, standards). A commit that is
 * not resolved yet is accepted only when it is main or a published release of the platform.
 */
export async function oibPack(platform: OibPlatform, commit: string, releaseTag?: string): Promise<OibPack> {
  if (labelOf(platform, commit, releaseTag) === null) await oibVersions().catch(() => undefined)
  const { catalog, items } = await loadPack(platform, commit, releaseTag)
  return { platform, commit: catalog.commit, reference: catalog.reference, source: catalog.source, license: catalog.license, items: [...items.values()] }
}

/** The newest version of each platform: its latest published release, or main without one. */
export interface OibRelease {
  platform: OibPlatform
  tag: string
  commit: string
  reference: string
  publishedAt?: string
}

export async function oibReleases(): Promise<{ releases: OibRelease[]; warning?: string }> {
  try {
    const value = await oibVersions()
    return {
      releases: (Object.keys(OIB_PLATFORMS) as OibPlatform[]).filter((platform) => platformStatus(value, platform) === "available").map((platform) => {
        const { commit, tag } = defaultSelection(value, platform)
        const publishedAt = tag ? value.releases.find((release) => release.tag === tag)?.releaseDate : value.main.committedAt
        return { platform, tag: tag ?? `main @ ${commit.slice(0, 7)}`, commit, reference: oibReference(platform, commit, tag), ...(publishedAt ? { publishedAt } : {}) }
      }),
      ...(value.warning ? { warning: value.warning } : {}),
    }
  } catch (error) {
    return { releases: [], warning: `The latest OpenIntuneBaseline version could not be read: ${error instanceof Error ? error.message : "GitHub could not be reached."}` }
  }
}
