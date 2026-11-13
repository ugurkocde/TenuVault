import { generateKeyPairSync, sign } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import { requireCaptureEnabled, verifyCapturePolicy } from "../src/main/app-backup/capture-policy"

const purpose = "tenuvault-app-backup-capture-v1"
const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const keys = [publicKey.export({ format: "pem", type: "spki" }).toString()]
const nonce = "a".repeat(64), now = 1_000_000
const claim = { v: 1, purpose, nonce, platform: "win32", enabled: true, minimumVersion: "0.3.0-nightly.0", iat: now, exp: now + 300 }
function token(changes: Record<string, unknown> = {}, prefix = purpose): string {
  const body = Buffer.from(JSON.stringify({ ...claim, ...changes })).toString("base64url")
  return `${body}.${sign(null, Buffer.from(`${prefix}.${body}`), privateKey).toString("base64url")}`
}

describe("signed capture policy", () => {
  it("accepts a fresh enable claim with a retained verification key", () => {
    expect(() => verifyCapturePolicy(token(), ["invalid key", ...keys], nonce, "0.3.0", now)).not.toThrow()
    expect(() => verifyCapturePolicy(token(), keys, nonce, "0.3.0-nightly.20261113200000", now)).not.toThrow()
  })
  it.each([
    { v: 2 }, { purpose: "license" }, { nonce: "b".repeat(64) }, { platform: "darwin" },
    { enabled: "true" }, { iat: now + 31 }, { iat: now - 301 }, { exp: now },
    { exp: now + 301 }, { iat: now, exp: now - 1 }, { iat: "1000000" },
    { minimumVersion: "garbage" }, { minimumVersion: "0.3.0-beta.1" },
  ])("rejects invalid, expired or mismatched claims: %j", changes => {
    expect(() => verifyCapturePolicy(token(changes), keys, nonce, "0.3.0", now)).toThrow("unavailable")
  })
  it("rejects unknown signers, modified claims and signatures for another purpose", () => {
    expect(() => verifyCapturePolicy(token(), [], nonce, "0.3.0", now)).toThrow()
    expect(() => verifyCapturePolicy(token({}, "license"), keys, nonce, "0.3.0", now)).toThrow()
    const [body, signature] = token().split(".")
    const changed = Buffer.from(JSON.stringify({ ...claim, enabled: false })).toString("base64url")
    expect(() => verifyCapturePolicy(`${changed}.${signature}`, keys, nonce, "0.3.0", now)).toThrow()
    expect(() => verifyCapturePolicy(`${body}.AA`, keys, nonce, "0.3.0", now)).toThrow()
    expect(() => verifyCapturePolicy("a".repeat(16 * 1024 + 1), keys, nonce, "0.3.0", now)).toThrow()
  })
  it("honors explicit disable and version floors, including nightly ordering", () => {
    expect(() => verifyCapturePolicy(token({ enabled: false }), keys, nonce, "0.3.0", now)).toThrow("paused")
    for (const version of ["0.2.9", "0.3.0-nightly.1"]) {
      expect(() => verifyCapturePolicy(token({ minimumVersion: "0.3.0" }), keys, nonce, version, now)).toThrow("Update TenuVault")
    }
    expect(() => verifyCapturePolicy(token({ minimumVersion: "0.3.0-nightly.2" }), keys, nonce, "0.3.0-nightly.1", now)).toThrow("Update TenuVault")
  })
})

describe("free capture policy fetch", () => {
  const options = () => ({ keys, appVersion: "0.3.0", signal: new AbortController().signal })
  it("checks each job with a new nonce and sends no tenant, license or Microsoft credentials", async () => {
    const nonces: string[] = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input)), requestNonce = url.searchParams.get("nonce")!
      nonces.push(requestNonce)
      expect(url.origin + url.pathname).toBe("https://www.tenuvault.com/api/app-backup/capture-policy")
      expect([...url.searchParams.keys()]).toEqual(["nonce"])
      expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", credentials: "omit" })
      expect(init?.headers).toBeUndefined()
      expect(init?.body).toBeUndefined()
      const issued = Math.floor(Date.now() / 1000)
      return Response.json({ token: token({ nonce: requestNonce, iat: issued, exp: issued + 300 }) })
    })
    await requireCaptureEnabled({ ...options(), fetch: fetcher })
    await requireCaptureEnabled({ ...options(), fetch: fetcher })
    expect(nonces).toHaveLength(2)
    expect(nonces[0]).not.toBe(nonces[1])
  })
  it.each([400, 401, 403, 404, 500, 503])("fails closed on HTTP %s", async status => {
    await expect(requireCaptureEnabled({ ...options(), fetch: async () => new Response("private details", { status }) })).rejects.toThrow("temporarily unavailable")
  })
  it.each(["not JSON", "{}", JSON.stringify({ token: "unsigned" }), "a".repeat(16 * 1024 + 1)])("refuses malformed and oversized responses", async body => {
    await expect(requireCaptureEnabled({ ...options(), fetch: async () => new Response(body) })).rejects.toThrow("temporarily unavailable")
  })
  it("does not reuse a previously enabled response or fall back when offline", async () => {
    await expect(requireCaptureEnabled({ ...options(), fetch: async () => Response.json({ token: token() }) })).rejects.toThrow()
    await expect(requireCaptureEnabled({ ...options(), fetch: async () => { throw new Error("network credentials") } })).rejects.toThrow("temporarily unavailable")
  })
  it("cancels without requesting a policy or creating an authorization prompt", async () => {
    const controller = new AbortController(), fetcher = vi.fn()
    controller.abort(new Error("cancelled"))
    await expect(requireCaptureEnabled({ ...options(), signal: controller.signal, fetch: fetcher })).rejects.toThrow("cancelled")
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("checks the policy before acquiring the Microsoft token or launching the helper", async () => {
    const main = await readFile("src/main/index.ts", "utf8")
    const capture = main.slice(main.indexOf("capture: async (tenant, appId, jobId"), main.indexOf("details: (tenant, id) =>"))
    expect(capture.indexOf("await requireCaptureEnabled")).toBeGreaterThan(0)
    expect(capture.indexOf("await requireCaptureEnabled")).toBeLessThan(capture.indexOf("auth.getAccessToken"))
    expect(capture.indexOf("auth.getAccessToken")).toBeLessThan(capture.indexOf("requestWindowsContent"))
  })
})
