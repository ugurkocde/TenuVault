import { Readable } from "node:stream"
import { exportLargeArchive, importLargeArchive, reviewLargeArchive, saveLargeDownload } from "../src/main/backup/large-archive"
import { compareLargePage } from "../src/main/backup/large-page"
import { backupBlobName, LARGE_BACKUP_CONTAINER } from "../src/shared/backup-storage"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir, cpus, hostname, platform, release, totalmem } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { ENTRA_DIRECTORY_TYPES, DIRECTORY_SCHEMAS } from "../src/shared/intune/entra-directory"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { fakeGraph } from "../test/helpers/fake-graph"
import { registerTestTypes, testType, TENANT, CLIENT, jwt } from "../test/helpers/backup-fixture"
import { BackupEngine } from "../src/main/backup/engine"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"

const scale = Number(process.env.TV_MEASURE_SCALE ?? 1)
if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error("TV_MEASURE_SCALE must be greater than zero and at most one")
const root = await mkdtemp(join(tmpdir(), "tv-measure-"))
const account = `tvlocal-${TENANT}`
const directory = process.env.TV_MEASURE_DIRECTORY === "1"
const collections = directory ? Object.fromEntries(ENTRA_DIRECTORY_TYPES.map(type => [type.path, { count: Math.round(({ Users: 100_000, Groups: 20_000, ServicePrincipals: 30_000, Applications: 1000, OAuth2PermissionGrants: 500, EntraDevices: 500, OrgContacts: 100 }[type.folder] ?? 0) * scale), ...(type.folder === "Groups" ? { members: { object: 0, count: Math.round(50_000 * scale) } } : {}), object: (index: number) => ({ ...Object.fromEntries(Object.keys(DIRECTORY_SCHEMAS[type.folder as keyof typeof DIRECTORY_SCHEMAS]).map(key => [key, null])), displayName: `Synthetic ${index}`, accountEnabled: true, ...(type.folder === "Users" ? { department: "x".repeat(1024), assignedLicenses: [], assignedPlans: [], identities: [] } : { description: "x".repeat(1024) }) }) }])) : {
  syntheticUsers: { count: Math.round(100_000 * scale), bytes: 1024 },
  syntheticGroups: { count: Math.round(20_000 * scale), bytes: 1024, members: { object: 0, count: Math.round(50_000 * scale) } },
  syntheticApps: { count: Math.round(30_000 * scale), bytes: 1024 },
}
const graph = await fakeGraph({ seed: 7, collections, throttleEvery: 1000, retryAfter: 1, onRequest: directory ? requests => { if (requests % 10_000 === 0) console.log(JSON.stringify({ phase: "graph", requests })) } : undefined })
if (directory) console.log(JSON.stringify({ phase: "starting", root }))
const common = { volume: "large" as const, inventory: true as const, listOnly: true as const, apiVersion: "v1.0" as const, listQuery: "$top=999&$select=id,displayName,payload,accountEnabled" }
const undo = directory ? () => {} : registerTestTypes([
  testType("AuthorizationPolicy", "syntheticUsers", common),
  testType("AuthenticationMethodsPolicy", "syntheticGroups", { ...common, extras: [{ property: "members", ids: true, path: id => `syntheticGroups/${id}/members?$select=id&$top=999` }] }),
  testType("TokenLifetimePolicies", "syntheticApps", common),
])
const store = new LocalBlobStore(root, [Buffer.alloc(32, 9)])
const uptimeBefore = execFileSync("uptime", { encoding: "utf8" }).trim()
let peakRss = process.memoryUsage().rss
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 20)
const started = performance.now()
try {
  const engine = new BackupEngine({ fetch: (async (input, init) => new URL(String(input)).hostname === "graph.microsoft.com" ? graph.fetch(input, init) : handleLocalBlobRequest(store, new Request(input, init))) as typeof fetch, getToken: async () => jwt({ scp: directory ? "User.Read.All Group.Read.All Application.Read.All Synchronization.Read.All Directory.Read.All Device.Read.All OrgContact.Read.All" : "Policy.Read.All Policy.Read.AuthenticationMethod" }), services: () => ({ services: ["entra"], ...(directory ? { areas: { entra: ["usersAndDevices", "groups", "applications"] } } : {}) }) })
  const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, ...(directory ? { scope: { excluded: INTUNE_TYPES.filter(type => !ENTRA_DIRECTORY_TYPES.includes(type)).map(type => type.folder) } } : {}) }))
  const seconds = (performance.now() - started) / 1000
  console.log(JSON.stringify({ phase: "capture", wallSeconds: seconds, status: job.status, coverage: job.coverage, ...graph.stats() }))
  let roundTrip: Record<string, number> | undefined
  if (directory && job.status === "Completed" && job.coverage === "complete") {
    const backup = job.backupFolder!
    const read = async (name: string) => JSON.parse((await store.get(account, LARGE_BACKUP_CONTAINER, backupBlobName(`${backup}/${name}`))).data.toString())
    const metadata = await read("metadata.json")
    const archive = join(root, "directory.tar")
    const exportStart = performance.now()
    await saveLargeDownload(Readable.toWeb(Readable.from(exportLargeArchive(TENANT, backup, metadata, read))) as ReadableStream<Uint8Array>, archive)
    const exportSeconds = (performance.now() - exportStart) / 1000
    console.log(JSON.stringify({ phase: "download", wallSeconds: exportSeconds }))
    const importStart = performance.now()
    const reviewed = await reviewLargeArchive(archive)
    const imported = new LocalBlobStore(join(root, "imported"), [Buffer.alloc(32, 3)])
    await importLargeArchive(imported, reviewed)
    const importSeconds = (performance.now() - importStart) / 1000
    console.log(JSON.stringify({ phase: "import", wallSeconds: importSeconds }))
    const readImported = async (name: string) => JSON.parse((await imported.get(account, LARGE_BACKUP_CONTAINER, backupBlobName(`${backup}/${name}`))).data.toString())
    const importedMetadata = await readImported("metadata.json")
    const compareStart = performance.now()
    let compared = 0, comparePages = 0
    for (const type of ENTRA_DIRECTORY_TYPES) {
      let cursor: [number, number] | null = [0, 0]
      while (cursor) {
        const page = await compareLargePage(type.folder, metadata, importedMetadata, cursor, read, readImported)
        if (page.changes.length) throw new Error("Imported directory inventory differs")
        compared += page.unchanged; comparePages++; cursor = page.next
      }
    }
    if (compared !== Object.values(collections).reduce((total, collection) => total + collection.count, 0)) throw new Error("The directory comparison did not visit every captured object")
    roundTrip = { exportSeconds, archiveBytes: (await stat(archive)).size, importSeconds, compared, comparePages, compareSeconds: (performance.now() - compareStart) / 1000 }
    console.log(JSON.stringify({ phase: "compare", ...roundTrip }))
  }
  const uptimeAfter = execFileSync("uptime", { encoding: "utf8" }).trim()
  let storedBytes = 0, files = 0
  for (const name of await readdir(join(root, account, "intune-backups-large"))) { const info = await stat(join(root, account, "intune-backups-large", name)); if (info.isFile()) { storedBytes += info.size; files++ } }
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  const report = { machine: { hostname: hostname(), platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, ramGiB: totalmem() / 1024 ** 3, node: process.version }, scale, directory, roundTrip, collections, uptimeBefore, uptimeAfter, wallSeconds: seconds, peakRssBytes: peakRss, ...graph.stats(), storedBytes, files, status: job.status, coverage: job.coverage, results: job.results, exception: job.exception }
  const output = process.env.TV_MEASURE_OUTPUT ?? join(tmpdir(), "tenuvault-large-measurement.json")
  await writeFile(output, JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify({ ...report, output }, null, 2))
  if (job.status !== "Completed" || job.coverage !== "complete" || peakRss >= 1024 ** 3) process.exitCode = 1
} finally {
  clearInterval(sampler); undo(); await graph.close()
  if (!process.env.TV_MEASURE_KEEP) await rm(root, { recursive: true, force: true })
  else console.log(`Stored backup: ${root}`)
}
