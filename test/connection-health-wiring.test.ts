import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { BackupJob } from "../src/main/backup/engine"
import { fixture, scriptedGraph, TENANT, CLIENT } from "./helpers/backup-fixture"

// Bootstrap is not unit tested; these checks keep the wiring in src/main/index.ts from drifting.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const main = read("../src/main/index.ts")
const preload = read("../src/preload/index.ts")
/** The options the main process creates connection health with. */
const host = main.match(/const health = new ConnectionHealth\(\{([\s\S]*?)\n  \}\)\n/)?.[1] ?? ""

describe("connection health wiring", () => {
  it("asks Microsoft for a new token silently, and never through the path that asks the window for a sign-in", () => {
    const token = host.split("\n").find((line) => line.trimStart().startsWith("token:")) ?? ""
    // forceRefresh: the answer is Microsoft's, not the token cache's.
    expect(token).toContain("auth.getAccessToken(tenantId, clientId, RESOURCE_SCOPES[resource], true)")
    expect(host).not.toContain("tokenFor(")
    expect(host).not.toContain("auth:signInRequired")
  })

  it("has no way to open a sign-in window or the browser", () => {
    for (const forbidden of ["auth.signIn(", "reauthenticate(", "acquireInteractive", "openBrowser", "shell.", "showWindow", "returnToApp"]) expect(host).not.toContain(forbidden)
    const folder = new URL("../src/main/connection-health/", import.meta.url)
    for (const file of readdirSync(folder)) {
      const source = readFileSync(new URL(file, folder), "utf8")
      expect(source).not.toMatch(/from "electron"|reauthenticate|loopbackSignIn|openBrowser|\.signIn\(/)
    }
  })

  it("checks the license before it asks the Backup Reader for a token, as a scheduled backup does", () => {
    const reader = host.match(/readerToken: async \(tenantId\) => \{([\s\S]*?)\n    \},/)?.[1] ?? ""
    expect(reader).toContain('allows(plan, "backupReader")')
    const license = reader.indexOf("license.requireEntitlement(tenantId)")
    expect(license).toBeGreaterThanOrEqual(0)
    expect(reader.indexOf("reader.graph({ fresh: true })")).toBeGreaterThan(license)
  })

  it("hands every run's outcomes to connection health, and checks as a backup starts and after it ended", () => {
    expect(main).toContain("onOutcomes: (outcomes, request) => health.recordRun(outcomes, request),")
    expect(main).toContain("onToken: (runId, granted) => health.runToken(runId, granted),")
    const started = main.match(/onQueued: \(job, request\) => \{([\s\S]*?)\n    \},/)?.[1] ?? ""
    expect(started).toContain('void health.check(request.tenantId, "beforeBackup", { reader: job.authMode === "app-only" }).catch(() => undefined)')
    const finished = main.match(/onFinished: \(job, request, tokens\) => \{([\s\S]*?)\n    \},/)?.[1] ?? ""
    expect(finished).toContain('void health.check(request.tenantId, "afterBackup", { reader: job.authMode === "app-only", failed: job.status === "Failed" }).catch(() => undefined)')
    // Whose sign-in a run reads with is noted as it starts, before anything else, and let go of when its job ended.
    expect(started.trimStart().startsWith("health.runStarted(job, request)")).toBe(true)
    expect(finished).toContain("health.runEnded(job.id)")
    // The hooks only start a check: nothing in a backup waits for one.
    expect(main).not.toMatch(/await health\.check\(request/)
  })

  it("checks only the tenant the admin has open at launch", () => {
    const launches = main.split("\n").filter((line) => line.includes('"launch"'))
    expect(launches).toEqual(['  if (open) void health.check(open, "launch").catch(() => undefined)'])
    expect(main).toContain("const open = selectedTenant(appStore.get(`${RENDERER_STORAGE_PREFIX}tenuvault_tenants`), appStore.get(`${RENDERER_STORAGE_PREFIX}tenuvault_selected_tenant`))")
    // No check runs over every connected tenant.
    expect(main).not.toMatch(/connectedTenantIds\(\)[^\n]*health\.check/)
    expect(main.indexOf('health.check(open, "launch")')).toBeGreaterThan(main.indexOf("createWindow()\n"))
  })

  it("checks after a sign-in, with the sign-in the admin just made", () => {
    const signIn = main.match(/handleTrusted\("auth:signIn",([\s\S]*?)\n {2}\}\)\)/)?.[1] ?? ""
    expect(signIn.indexOf('health.check(account.tenantId, "signIn")')).toBeGreaterThan(signIn.indexOf("await requireForNewTenant(account.tenantId)"))
    const again = main.match(/handleTrusted\("auth:reauthenticate",([\s\S]*?)\n {2}\}\)/)?.[1] ?? ""
    expect(again.indexOf('health.check(tenantId, "signIn")')).toBeGreaterThan(again.indexOf("await auth.reauthenticate("))
  })

  it("drops what was observed for an account at sign-out, and everything when the tenant is removed", () => {
    const signOut = main.match(/handleTrusted\("auth:signOut",([\s\S]*?)\n {2}\}\)/)?.[1] ?? ""
    expect(signOut).toContain("health.signedOut(tenantId)")
    const release = main.match(/handleTrusted\("license:releaseTenant",([\s\S]*?)\n {2}\}\)/)?.[1] ?? ""
    expect(release).toContain("health.forget(tenantId)")
  })

  it("captures identity changes where the account, reader and tenant profile are written", () => {
    const accountMutations = main.match(/const accounts = accountStore\(appStore,([\s\S]*?)\n {2}\}\)/)?.[1] ?? ""
    expect(accountMutations).toContain("if (!accounts.get(tenantId)) health.signedOut(tenantId)")
    expect(accountMutations).toContain("else health.connectionsChanged(tenantId)")
    expect(main).toContain("connectionChanged: (tenantId) => health.connectionsChanged(tenantId)")
    expect(host).toContain("credential: backupReader.connectionIdentity(tenantId)!")
    expect(host).toContain("storageId: profile.storageAccountName")
    const save = main.match(/handleTrusted\("storage:set",([\s\S]*?)\n {2}\}\)/)?.[1] ?? ""
    expect(save.indexOf("health.connectionsChanged(tenant)")).toBeGreaterThan(save.indexOf("appStore.set("))
    expect(save).toContain("...previousTenants, ...connectedTenantIds()")
    const remove = main.match(/handleTrusted\("storage:remove",([\s\S]*?)\n {2}\}\)/)?.[1] ?? ""
    expect(remove.indexOf("health.connectionsChanged(tenant)")).toBeGreaterThan(remove.indexOf("appStore.delete("))
  })

  it("keeps observations in the encrypted app state", () => {
    expect(host).toContain("store: appStore,")
  })

  it("registers every channel the preload bridge invokes, and only for a connected tenant", () => {
    for (const channel of ["health:report", "health:check", "health:acknowledge", "services:setAccess", "services:setArea"]) {
      expect(preload).toContain(`"${channel}"`)
      const handler = main.split("\n").find((line) => line.includes(`handleTrusted("${channel}"`)) ?? ""
      expect(handler).not.toBe("")
      const body = main.slice(main.indexOf(`handleTrusted("${channel}"`), main.indexOf(`handleTrusted("${channel}"`) + 400)
      expect(body).toContain("connectedTenant(tenantId)")
    }
    expect(preload).toContain('subscribe<string>("health:changed", listener)')
    expect(main).toContain('mainWindow?.webContents.send("health:changed", tenantId)')
  })

  it("saves the access level and the opt-in areas through the tenant's settings, and answers with its health", () => {
    expect(main).toMatch(/handleTrusted\("services:setAccess"[\s\S]{0,200}moduleSettings\.setAccess\(tenant, id, access\)\n\s+return health\.report\(tenant\)/)
    expect(main).toMatch(/handleTrusted\("services:setArea"[\s\S]{0,220}moduleSettings\.setArea\(tenant, id, area, enabled\)\n\s+return health\.report\(tenant\)/)
  })

  it("asks Microsoft on Check again, and answers a page that opens from a recent check", () => {
    expect(main).toContain('health.check(connectedTenant(tenantId), again === true ? "again" : "opened")')
    expect(preload).toContain('check: (tenantId, again) => invoke("health:check", tenantId, again === true)')
  })
})

describe("the start of a backup", () => {
  it("is announced once for a request that got a job of its own, before the job ends", async () => {
    const started: string[] = []
    const order: string[] = []
    const backups = fixture(scriptedGraph({}), {
      services: () => ({ services: ["intune"] }),
      onStarted: (job) => { started.push(job.id); order.push("started") },
      onFinished: () => order.push("finished"),
    })
    const request = { tenantId: TENANT, clientId: CLIENT, storageAccountName: backups.account }
    const first = backups.engine.start(request)
    // A request that joins the running job starts nothing.
    const joined = backups.engine.start(request)
    expect(joined).toBe(first)
    // Nor does one that is refused because of it.
    const refused: BackupJob = backups.engine.start({ ...request, scope: { excluded: ["Apps"] } })
    expect(refused.status).toBe("Failed")
    await backups.engine.waitForJob(first)
    expect(started).toEqual([first.id])
    expect(order[0]).toBe("started")
  })

  it("goes on when the listener throws", async () => {
    const backups = fixture(scriptedGraph({}), { services: () => ({ services: ["intune"] }), onStarted: () => { throw new Error("listener failed") }, onToken: () => { throw new Error("listener failed") } })
    expect((await backups.run()).status).toBe("Completed")
  })
})
