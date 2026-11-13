import { spawn } from "node:child_process"
import type { DeviceContent } from "./capture-download"
import { bindCapture } from "./capture-identity"
import { sourceTenant } from "../app-sources/store"

export interface CaptureHelperRequest { tenantId: string; appId: string; jobId: string; accessToken: string }
export interface AuthorizedDeviceContent extends DeviceContent { appName: string }

/** The private helper output is main-process-only. Never expose it through renderer IPC. */
export function requestWindowsContent(executable: string, request: CaptureHelperRequest, signal: AbortSignal): Promise<AuthorizedDeviceContent> {
  sourceTenant(request.tenantId); sourceTenant(request.appId); sourceTenant(request.jobId)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["broker", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    let output = Buffer.alloc(0), settled = false
    const finish = (error?: Error, content?: AuthorizedDeviceContent) => {
      if (settled) return
      settled = true; clearTimeout(timeout); signal.removeEventListener("abort", cancel)
      child.kill(); output.fill(0)
      if (error) reject(error); else resolve(content!)
    }
    // Keep this job occupied until an outstanding OS consent dialog is answered.
    // Closing stdin marks the request cancelled; the broker never sends its token
    // after that point. This prevents queued stale prompts from repeated retries.
    const cancel = () => child.stdin.end()
    const timeout = setTimeout(() => finish(new Error("Windows capture approval or authorization timed out. Retry Backup.")), 365_000)
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) { finish(new Error("Source operation cancelled.")); return }
    child.on("error", () => finish(new Error("The Windows capture helper could not start. Reinstall this TenuVault build.")))
    child.stdin.on("error", () => finish(new Error("The Windows capture helper disconnected.")))
    // Do not forward native exception details, URLs or tokens into app logs.
    child.stderr.resume()
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) { chunk.fill(0); return }
      if (output.length + chunk.length > 512 * 1024) { finish(new Error("The Windows capture helper returned an oversized response.")); return }
      const previous = output; output = Buffer.concat([previous, chunk]); previous.fill(0)
    })
    child.on("close", code => {
      if (settled) return
      if (signal.aborted) { finish(new Error("Source operation cancelled.")); return }
      try {
        if (!output.length && code === 3) { finish(new Error("Windows approval timed out. Start Backup again when you can approve the prompt.")); return }
        const result = JSON.parse(output.toString("utf8")) as AuthorizedDeviceContent & { error?: unknown }
        if (typeof result.error === "string" && result.error.length <= 500) { finish(new Error(result.error)); return }
        if (code !== 0 || typeof result.appName !== "string" || result.appName.length > 300 || typeof result.downloadUrl !== "string" || result.downloadUrl.length > 16384 || !result.encryption || result.identity.tenantId !== request.tenantId || result.identity.appId !== request.appId) throw new Error()
        bindCapture(result.identity, result.identity)
        finish(undefined, result)
      } catch { finish(new Error("The Windows capture helper returned an invalid response. No backup was created.")) }
    })
    const body = Buffer.from(JSON.stringify(request)), prefix = Buffer.alloc(4)
    prefix.writeUInt32LE(body.length)
    child.stdin.write(prefix)
    // Keep stdin open while authorization runs; cancellation terminates the broker.
    child.stdin.write(body, () => body.fill(0))
  })
}
