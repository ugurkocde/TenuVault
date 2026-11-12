import { describe, expect, it, vi } from "vitest"
import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { checkRecoveryDevice, evaluateDevice, type EnrollmentObservation } from "../src/main/app-backup/device-check"
import { ContentRequestVerifier, type ContentRequest, type RequestContext } from "../src/main/app-backup/request"
import { RECOVERY_API_PATHS, isRecoveryBackupRequest } from "../src/main/features/recovery"
import { readFile } from "node:fs/promises"

const tenant = "11111111-1111-1111-1111-111111111111", account = "22222222-2222-2222-2222-222222222222", other = "33333333-3333-3333-3333-333333333333"
const now = Date.now()
function observation(): EnrollmentObservation { return { elevated: false, enrollments: [{ tenantId: tenant, thumbprint: "ABC" }], certificates: [{ accountId: account, thumbprint: "ABC", hasPrivateKey: true, notBefore: new Date(now - 10000).toISOString(), notAfter: new Date(now + 10000).toISOString() }] } }

describe("read-only recovery device check", () => {
  it("binds both the selected tenant enrollment and Intune account, without enabling capture", () => {
    const result = evaluateDevice(tenant, account, observation(), now)
    expect(result).toMatchObject({ enrollment: "matched", certificate: "matched", captureAvailable: false, elevated: false })
    expect(JSON.stringify(result)).not.toContain("ABC")
    expect(JSON.stringify(result)).not.toContain(account)
    expect(evaluateDevice(other, account, observation(), now).enrollment).toBe("different-tenant")
    expect(evaluateDevice(tenant, other, observation(), now).certificate).toBe("missing")
  })
  it.each(["expired", "future", "ambiguous", "no-key", "two-enrollments"])("refuses to confirm %s enrollment evidence", mode => {
    const data = observation()
    if (mode === "expired") data.certificates[0]!.notAfter = new Date(now - 1).toISOString()
    if (mode === "future") data.certificates[0]!.notBefore = new Date(now + 1).toISOString()
    if (mode === "ambiguous") data.certificates.push({ ...data.certificates[0]! })
    if (mode === "no-key") data.certificates[0]!.hasPrivateKey = false
    if (mode === "two-enrollments") data.enrollments.push({ ...data.enrollments[0]! })
    expect(evaluateDevice(tenant, account, data, now).certificate).not.toBe("matched")
    expect(evaluateDevice(tenant, account, data, now).captureAvailable).toBe(false)
  })
  it("keeps unsupported platforms and Graph failures unavailable independently of stored-source access", async () => {
    const fetchAccount = vi.fn(async () => { throw new Error("offline") }), probe = vi.fn(async () => observation())
    expect((await checkRecoveryDevice(tenant, fetchAccount, { platform: "linux", probe })).captureAvailable).toBe(false)
    expect(fetchAccount).not.toHaveBeenCalled()
    expect((await checkRecoveryDevice(tenant, fetchAccount, { platform: "win32", probe })).enrollment).toBe("unknown")
    expect(probe).not.toHaveBeenCalled()
  })
})

describe("future content request contract, no transport", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const context: RequestContext = { tenantId: tenant, intuneAccountId: account, deviceId: other, appId: tenant, contentVersion: "3", requesterObjectId: other, challenge: randomBytes(32).toString("base64url"), appVersion: "1.0.0", jobId: account, contentFileId: other }
  const ticket = (): ContentRequest => ({ v: 1, ...context, requesterTenantId: tenant, issuedAt: now, expiresAt: now + 30_000, roleCheckedAt: now - 1000, appType: "#microsoft.graph.win32LobApp", permission: "update-app" })
  const signed = (value: unknown) => { const payload = JSON.stringify(value); return [payload, sign(null, Buffer.from(payload), privateKey).toString("base64url")] as const }
  it("accepts only one signed request bound to its challenge, tenant, actor, device, job and content", () => {
    const verifier = new ContentRequestVerifier(publicKey, context, () => now), value = signed(ticket())
    expect(verifier.consume(...value).tenantId).toBe(tenant)
    expect(() => verifier.consume(...value)).toThrow("already been used")
  })
  it.each(["expired", "future", "stale-role", "tenant", "actor", "device", "app", "file", "job", "challenge", "subtype", "permission", "extra", "signature"])("rejects %s", mode => {
    const t = { ...ticket() } as ContentRequest & { command?: string }
    if (mode === "expired") t.expiresAt = now
    if (mode === "future") t.issuedAt = now + 1000
    if (mode === "stale-role") t.roleCheckedAt = now - 61_000
    if (mode === "tenant") t.requesterTenantId = other
    if (mode === "actor") t.requesterObjectId = tenant
    if (mode === "device") t.deviceId = tenant
    if (mode === "app") t.appId = other
    if (mode === "file") t.contentFileId = tenant
    if (mode === "job") t.jobId = tenant
    if (mode === "challenge") t.challenge = randomBytes(32).toString("base64url")
    if (mode === "subtype") Object.assign(t, { appType: "#microsoft.graph.win32CatalogApp" })
    if (mode === "permission") Object.assign(t, { permission: "read-app" })
    if (mode === "extra") t.command = "arbitrary"
    const [payload, signature] = signed(t)
    expect(() => new ContentRequestVerifier(publicKey, context, () => now).consume(mode === "signature" ? payload + " " : payload, signature)).toThrow()
  })
  it("cannot inherit the existing expired-license rollback bypass or execute private protocol calls", async () => {
    expect([...RECOVERY_API_PATHS].some(path => path.startsWith("/api/app-backup"))).toBe(false)
    expect(await isRecoveryBackupRequest(new Request("https://tenuvault.local/api/app-backup/recovery-start", { method: "POST", body: JSON.stringify({ tenantId: tenant }) }))).toBe(false)
    const product = await Promise.all(["src/main/app-backup/device-check.ts", "src/main/app-backup/request.ts", "src/main/app-sources/service.ts"].map(p => readFile(p, "utf8")))
    expect(product.join("\n")).not.toMatch(/GetContentInfo|SideCarGateway|CMS|recovery-start/)
  })
})
