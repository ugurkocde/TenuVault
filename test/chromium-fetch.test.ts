import { Readable, Writable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import type { ClientRequest, ClientRequestConstructorOptions } from "electron"
import { createChromiumFetch } from "../src/main/chromium-fetch"
import { ProxyAuth } from "../src/main/proxy-auth"
import { SecureStore } from "../src/main/storage/secure-store"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cipher = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString("utf8") }
const PROXY = { isProxy: true, scheme: "basic", host: "proxy.contoso.example", port: 8080, realm: "" }

/** Stands in for Electron's ClientRequest: a writable body plus the events net.request emits. */
class FakeRequest extends Writable {
  headers: Record<string, string> = {}
  body = ""
  aborted = false
  constructor(readonly options: ClientRequestConstructorOptions) {
    super()
  }
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
  }
  abort() {
    this.aborted = true
  }
  override _write(chunk: Buffer, _encoding: string, callback: () => void) {
    this.body += chunk.toString()
    callback()
  }
  /** Emits `login` like Chromium and resolves with the credentials the fetch answered. */
  challenge(authInfo = PROXY): Promise<[string?, string?]> {
    return new Promise((resolve) => this.emit("login", authInfo, (...args: [string?, string?]) => resolve(args)))
  }
  respond(status: number, body: string, headers: Record<string, string | string[]> = {}) {
    this.emit("response", Object.assign(Readable.from([Buffer.from(body)]), { statusCode: status, statusMessage: "", headers }))
  }
}

function harness() {
  const requests: FakeRequest[] = []
  const prompt = vi.fn(async () => ({ username: "contoso\\backup", password: "correct", remember: true }))
  const auth = new ProxyAuth({ store: new SecureStore(join(mkdtempSync(join(tmpdir(), "tv-fetch-")), "s.bin"), cipher), persist: true, prompt })
  const fetchImpl = createChromiumFetch((options) => {
    const request = new FakeRequest(options)
    requests.push(request)
    return request as unknown as ClientRequest
  }, () => auth.attempt())
  return { requests, prompt, fetchImpl }
}

describe("createChromiumFetch", () => {
  it("sends the request like net.fetch and returns the response", async () => {
    const { requests, fetchImpl } = harness()
    const pending = fetchImpl("https://graph.microsoft.com/beta/x", { method: "POST", headers: { Authorization: "Bearer t" }, body: "payload", redirect: "error" })
    await vi.waitFor(() => expect(requests[0]?.writableFinished).toBe(true))
    expect(requests[0]!.options).toMatchObject({ method: "POST", url: "https://graph.microsoft.com/beta/x", credentials: "include", redirect: "error" })
    expect(requests[0]!.headers.authorization).toBe("Bearer t")
    expect(requests[0]!.body).toBe("payload")
    requests[0]!.respond(200, "{\"value\":[]}", { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] })
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ value: [] })
    expect(response.headers.get("content-type")).toBe("application/json")
  })

  it("answers a proxy challenge with the credentials the admin gave", async () => {
    const { requests, prompt, fetchImpl } = harness()
    const pending = fetchImpl("https://www.tenuvault.com/api/desktop-license/refresh")
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(await requests[0]!.challenge()).toEqual(["contoso\\backup", "correct"])
    requests[0]!.respond(200, "ok")
    expect(await (await pending).text()).toBe("ok")
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it("asks once for concurrent requests through the same proxy", async () => {
    const { requests, prompt, fetchImpl } = harness()
    void fetchImpl("https://graph.microsoft.com/a")
    void fetchImpl("https://login.microsoftonline.com/b")
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(await Promise.all(requests.map((request) => request.challenge()))).toEqual([["contoso\\backup", "correct"], ["contoso\\backup", "correct"]])
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it("cancels server challenges without asking", async () => {
    const { requests, prompt, fetchImpl } = harness()
    const pending = fetchImpl("https://example.invalid/protected")
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(await requests[0]!.challenge({ ...PROXY, isProxy: false })).toEqual([])
    requests[0]!.respond(401, "denied")
    expect((await pending).status).toBe(401)
    expect(prompt).not.toHaveBeenCalled()
  })

  it("rejects with transport errors and aborts the request on abort", async () => {
    const { requests, fetchImpl } = harness()
    const failing = fetchImpl("https://graph.microsoft.com/")
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    requests[0]!.emit("error", new Error("net::ERR_PROXY_CONNECTION_FAILED"))
    await expect(failing).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED")

    const controller = new AbortController()
    const aborted = fetchImpl("https://graph.microsoft.com/", { signal: controller.signal })
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" })
    expect(requests[1]!.aborted).toBe(true)
  })
})
