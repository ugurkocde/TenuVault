import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir, cpus, hostname, platform, release, totalmem } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { fakeGraph } from "../test/helpers/fake-graph"
import { registerTestTypes, testType, TENANT, CLIENT, jwt } from "../test/helpers/backup-fixture"
import { BackupEngine } from "../src/main/backup/engine"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"

const scale = Number(process.env.TV_MEASURE_SCALE ?? 1)
const root = await mkdtemp(join(tmpdir(), "tv-measure-"))
const account = `tvlocal-${TENANT}`
const collections = {
  syntheticUsers: { count: Math.round(100_000 * scale), bytes: 1024 },
  syntheticGroups: { count: Math.round(20_000 * scale), bytes: 1024, members: { object: 0, count: Math.round(50_000 * scale) } },
  syntheticApps: { count: Math.round(30_000 * scale), bytes: 1024 },
}
const graph = await fakeGraph({ seed: 7, collections, throttleEvery: 1000, retryAfter: 1 })
const common = { volume: "large" as const, inventory: true as const, listOnly: true as const, apiVersion: "v1.0" as const, listQuery: "$top=999&$select=id,displayName,payload,accountEnabled" }
const undo = registerTestTypes([
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
  const engine = new BackupEngine({ fetch: (async (input, init) => new URL(String(input)).hostname === "graph.microsoft.com" ? graph.fetch(input, init) : handleLocalBlobRequest(store, new Request(input, init))) as typeof fetch, getToken: async () => jwt({ scp: "Policy.Read.All Policy.Read.AuthenticationMethod" }), services: () => ({ services: ["entra"] }) })
  const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account }))
  const seconds = (performance.now() - started) / 1000
  clearInterval(sampler)
  const uptimeAfter = execFileSync("uptime", { encoding: "utf8" }).trim()
  let storedBytes = 0, files = 0
  for (const name of await readdir(join(root, account, "intune-backups"))) { const info = await stat(join(root, account, "intune-backups", name)); if (info.isFile()) { storedBytes += info.size; files++ } }
  const report = { machine: { hostname: hostname(), platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, ramGiB: totalmem() / 1024 ** 3, node: process.version }, scale, collections, uptimeBefore, uptimeAfter, wallSeconds: seconds, peakRssBytes: Math.max(peakRss, process.memoryUsage().rss), ...graph.stats(), storedBytes, files, status: job.status, coverage: job.coverage, results: job.results, exception: job.exception }
  const output = process.env.TV_MEASURE_OUTPUT ?? join(tmpdir(), "tenuvault-large-measurement.json")
  await writeFile(output, JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify({ ...report, output }, null, 2))
  if (job.status !== "Completed" || job.coverage !== "complete" || peakRss >= 1024 ** 3) process.exitCode = 1
} finally {
  clearInterval(sampler); undo(); await graph.close()
  if (!process.env.TV_MEASURE_KEEP) await rm(root, { recursive: true, force: true })
  else console.log(`Stored backup: ${root}`)
}
