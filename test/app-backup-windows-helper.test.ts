import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
const spawned = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawned.spawn }))
import { requestWindowsContent } from "../src/main/app-backup/windows-helper"
const tenant = "11111111-1111-1111-1111-111111111111", app = "22222222-2222-2222-2222-222222222222", job = "33333333-3333-3333-3333-333333333333"
const request = { tenantId: tenant, appId: app, jobId: job, accessToken: "private-token" }
function child() {
  const value = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  spawned.spawn.mockReturnValue(value)
  return value
}
afterEach(() => vi.clearAllMocks())
it("passes the request over bounded stdin and never puts secrets in arguments", async () => {
 const process = child(), chunks: Buffer[] = []
 process.stdin.on("data", b => chunks.push(Buffer.from(b)))
 const result = requestWindowsContent("helper.exe", request, new AbortController().signal)
 const body = Buffer.concat(chunks)
 expect(body.readUInt32LE()).toBe(body.length - 4)
 expect(JSON.parse(body.subarray(4).toString())).toEqual(request)
 expect(JSON.stringify(spawned.spawn.mock.calls)).not.toContain("private-token")
 process.stdout.end(JSON.stringify({ error: "Intune refused the request." })); process.emit("close", 1)
 await expect(result).rejects.toThrow("Intune refused")
})
it.each(["tenant", "app", "malformed", "oversized"])("rejects %s helper output without exposing it", async mode => {
 const process = child(), result = requestWindowsContent("helper.exe", request, new AbortController().signal)
 const payload = { appName: "App", downloadUrl: "https://cdn.manage.microsoft.com/private", bytes: 100, encryption: {}, identity: { tenantId: mode === "tenant" ? app : tenant, appId: mode === "app" ? tenant : app, contentFileId: job, contentVersion: "1", appType: "#microsoft.graph.win32LobApp" } }
 process.stdout.write(mode === "oversized" ? Buffer.alloc(512*1024+1) : mode === "malformed" ? "private-secret" : JSON.stringify(payload)); process.emit("close", 0)
 await expect(result).rejects.toThrow(mode === "oversized" ? "oversized" : "invalid response")
 expect(process.kill).toHaveBeenCalled()
})
it("holds a cancelled approval job until the broker exits and refuses a late success", async () => {
 const process = child(), abort = new AbortController()
 const result = requestWindowsContent("helper.exe", request, abort.signal)
 abort.abort()
 expect(process.stdin.writableEnded).toBe(true)
 expect(process.kill).not.toHaveBeenCalled()
 process.emit("close", 0)
 await expect(result).rejects.toThrow("cancelled")
 expect(process.kill).toHaveBeenCalledOnce()
})
