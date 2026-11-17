import { expect, it, vi } from "vitest"
import { POST as history } from "../src/portal/app/api/list-backups/route"
import { NextRequest } from "../src/main/api/next-server-shim"
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { BackupEngine } from "../src/main/backup/engine"
import { handleLocalBlobRequest } from "../src/main/storage/blob-emulator"
import { registerTestTypes, testType, jwt, TENANT, CLIENT } from "./helpers/backup-fixture"

it.each([false, true])("survives process death and starts a fresh folder (Azure protocol: %s)", async azure => {
  const root = await mkdtemp(join(tmpdir(), "tv-crash-")), script = join(root, "capture.mjs"), data = join(root, "encrypted")
  const account = `tvlocal-${TENANT}`, destination = azure ? "syntheticstore" : account
  const imports = (file: string) => JSON.stringify(resolve(file))
  const source = `
    import { BackupEngine } from ${imports("src/main/backup/engine.ts")};
    import { LocalBlobStore } from ${imports("src/main/storage/local-blob-store.ts")};
    import { handleLocalBlobRequest } from ${imports("src/main/storage/blob-emulator.ts")};
    import { registerTestTypes, testType, jwt } from ${imports("test/helpers/backup-fixture.ts")};
    registerTestTypes([testType("AuthorizationPolicy", "synthetic", { volume: "large", listOnly: true })]);
    const store = new LocalBlobStore(process.argv[2], [Buffer.alloc(32, 9)]);
    let page = 0;
    const engine = new BackupEngine({ getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["entra"] }), fetch: async (input, init) => {
      if (new URL(String(input)).hostname !== "graph.microsoft.com") { const url = new URL(String(input)); url.hostname = ${JSON.stringify(account + ".blob.core.windows.net")}; return handleLocalBlobRequest(store, new Request(url, init)); }
      return Response.json({ value: [{ id: "object-" + page++ }], "@odata.nextLink": "https://graph.microsoft.com/beta/synthetic?page=" + page });
    } });
    await engine.waitForJob(engine.start({ tenantId: ${JSON.stringify(TENANT)}, clientId: ${JSON.stringify(CLIENT)}, storageAccountName: ${JSON.stringify(destination)} }));
  `
  await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: "crash.ts", loader: "ts" }, outfile: script, bundle: true, platform: "node", format: "esm", target: "node24" })
  const child = spawn(process.execPath, [script, data], { stdio: "ignore" })
  const exited = new Promise(resolve => child.once("exit", resolve))
  let undo: (() => void) | undefined
  try {
    const deadline = Date.now() + 10_000
    let count = 0
    while (count < 5 && Date.now() < deadline) {
      count = await readdir(join(data, account, "intune-backups")).then(files => files.filter(file => file.endsWith(".tvb")).length, () => 0)
      if (count < 5) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(count).toBeGreaterThanOrEqual(5)
    child.kill("SIGKILL"); await exited
    const store = new LocalBlobStore(data, [Buffer.alloc(32, 9)])
    const before = await store.list(account, "intune-backups")
    expect(before.some(blob => blob.name.endsWith("metadata.json"))).toBe(false)
    const abandoned = before[0]!.name.split("/")[0]!
    const listings: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "storage" })
      if (url.searchParams.get("comp") === "list") { expect(url.searchParams.get("delimiter")).toBe("/"); listings.push(url.search) }
      url.hostname = `${account}.blob.core.windows.net`
      return handleLocalBlobRequest(store, new Request(url, init))
    }))
    for (const summary of [false, true]) {
      const response = await history(new NextRequest("http://tenuvault.internal/api/list-backups", { method: "POST", body: JSON.stringify({ tenantId: TENANT, appId: CLIENT, clientSecret: "test", subscriptionId: "local", resourceGroupName: "local", storageAccountName: destination, summary }) }))
      expect(response.status).toBe(200)
      expect((await response.json()).backups).toMatchObject([{ id: abandoned, status: "running", largeInventory: true }])
    }
    expect(listings).toHaveLength(4)
    vi.unstubAllGlobals()

    undo = registerTestTypes([testType("AuthorizationPolicy", "synthetic", { volume: "large", listOnly: true })])
    const engine = new BackupEngine({ getToken: async () => jwt({ scp: "Policy.Read.All" }), services: () => ({ services: ["entra"] }), now: () => new Date(Date.now() + 2000), fetch: (async (input, init) => new URL(String(input)).hostname === "graph.microsoft.com" ? Response.json({ value: [{ id: "fresh" }] }) : handleLocalBlobRequest(store, new Request(String(input).replace("syntheticstore.blob.core.windows.net", `${account}.blob.core.windows.net`), init))) as typeof fetch })
    const job = await engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: destination }))
    expect(job.status).toBe("Completed")
    expect(job.coverage).toBe("complete")
    expect(job.backupFolder).not.toBe(abandoned)
    expect((await store.list(account, "intune-backups", `${abandoned}/`)).some(blob => blob.name.endsWith("metadata.json"))).toBe(false)
  } finally { vi.unstubAllGlobals(); undo?.(); child.kill("SIGKILL"); await exited; await rm(root, { recursive: true, force: true }) }
}, 20_000)
