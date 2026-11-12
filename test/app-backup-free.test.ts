import { describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import { appBackupClientId } from "../src/main/app-backup/sign-in"
import { readAppBackupAccount } from "../src/main/app-backup/account"
import { isAppBackupPath } from "../src/renderer/lib/app-backup-route"

const tenant = "11111111-1111-1111-1111-111111111111", account = "22222222-2222-2222-2222-222222222222"

describe("free App Backup account read", () => {
  it.each([{}, { storageAccountName: "" }])("resolves a configured registration without backup storage %j", resources => {
    expect(appBackupClientId(tenant.toUpperCase(), JSON.stringify([{ credentials: { tenantId: tenant, appId: account }, resources }]))).toBe(account)
  })
  it.each([null, "invalid JSON", "{}", JSON.stringify([{ credentials: { tenantId: account, appId: tenant } }]), JSON.stringify([{ credentials: { tenantId: tenant, appId: "invalid" } }])])("refuses missing or mismatched configured registrations %s", records => {
    expect(() => appBackupClientId(tenant, records)).toThrow("Microsoft app registration")
  })
  it("uses only a tenant's authenticated read-only beta singleton request, independently of licensing", async () => {
    const token = vi.fn(async () => "test-token"), fetcher = vi.fn(async () => Response.json({ intuneAccountId: account }))
    expect(await readAppBackupAccount(tenant, token, fetcher)).toBe(account)
    expect(token).toHaveBeenCalledWith(tenant)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://graph.microsoft.com/beta/deviceManagement?$select=intuneAccountId", expect.objectContaining({ method: "GET", headers: { authorization: "Bearer test-token" }, redirect: "error" }))
  })
  it.each([400, 401, 403, 500])("refuses HTTP %s without treating it as enrollment evidence", async status => {
    await expect(readAppBackupAccount(tenant, async () => "token", async () => new Response("denied", { status }))).rejects.toThrow(`HTTP ${status}`)
  })
  it.each([null, {}, { intuneAccountId: "invalid" }])("refuses an incomplete or malformed account response", async body => {
    await expect(readAppBackupAccount(tenant, async () => "token", async () => Response.json(body))).rejects.toThrow()
  })
  it("requires authentication and validates the tenant before requesting a token", async () => {
    const token = vi.fn(async () => ""), fetcher = vi.fn()
    await expect(readAppBackupAccount("invalid", token, fetcher)).rejects.toThrow()
    expect(token).not.toHaveBeenCalled()
    await expect(readAppBackupAccount(tenant, token, fetcher)).rejects.toThrow("Sign in")
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("keeps App Backup independent of billing without exempting other routes or privileged API access", async () => {
    for (const path of ["/portal/app-backup", "/portal/app-backup/versions"]) expect(isAppBackupPath(path)).toBe(true)
    for (const path of ["/portal/backup", "/portal/app-backup-other", "/api/app-backup/recovery-start", "/license"]) expect(isAppBackupPath(path)).toBe(false)
    const main = await readFile("src/main/index.ts", "utf8"), start = main.indexOf("const appSources = new AppSourceService"), end = main.indexOf('handleTrusted("app:info"', start)
    expect(main.slice(start, end)).not.toMatch(/requireEntitlement|featureDeps\.graph|withPlanError|requireRecovery|tenantProfile/)
    const product = await Promise.all(["src/main/app-sources/service.ts", "src/main/app-backup/account.ts", "src/main/app-backup/device-check.ts"].map(path => readFile(path, "utf8")))
    expect(product.join("\n")).not.toMatch(/authorizeAttach|requireEntitlement|requireRecovery|CommunityLimit|plan-errors/)
  })
})
