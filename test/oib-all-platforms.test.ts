import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleOib, setOibStore } from "../src/main/oib/service"
import { packFolder, packItems, resetOibSource } from "../src/main/oib/source"
import { planGuard } from "../src/main/api/plan-gates"
import type { OibCatalog, OibComparison, OibRun } from "../src/shared/oib/types"
import { memoryStore } from "./helpers"

const TENANT = "11111111-1111-1111-1111-111111111111"
const SECOND = "33333333-3333-3333-3333-333333333333"
const APP = "22222222-2222-2222-2222-222222222222"
const COMMIT = "b".repeat(40)

const macPolicy = {
  "@odata.type": "#microsoft.graph.deviceManagementConfigurationPolicy", name: "MacOS - OIB - FileVault", platforms: "macOS", technologies: "mdm,appleRemoteManagement", roleScopeTagIds: ["7"],
  settings: [{ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "com.apple.mcx.filevault2_enable" } }],
}
const iosProtection = { "@odata.type": "#microsoft.graph.iosManagedAppProtection", displayName: "BYOD - OIB - iOS App Protection", roleScopeTagIds: ["3"] }
const androidProtection = { "@odata.type": "#microsoft.graph.androidManagedAppProtection", displayName: "BYOD - OIB - Android App Protection" }

/** GitHub with a macOS pack and files that are not deployed, the token endpoint, backups and Graph. */
function macFetch(graph: string[], backups: string[], deniedTenant?: string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/commits/main")) return Response.json({ sha: COMMIT })
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [
      { type: "blob", path: "MACOS/README.md" },
      { type: "blob", path: "MACOS/IntuneManagement/SettingsCatalog/MacOS - OIB - FileVault.json" },
      { type: "blob", path: "MACOS/Scripts/Set-Defaults.sh" },
      { type: "blob", path: "MACOS/IntuneManagement/CustomAttributes/Attribute.json" },
    ] })
    if (url.startsWith("https://raw.githubusercontent.com/")) return new Response(JSON.stringify(macPolicy))
    if (url.includes("oauth2")) {
      // The fetch bridge answers the token request with 403 when the license does not cover the tenant.
      return deniedTenant && url.includes(deniedTenant)
        ? Response.json({ error: "unauthorized_client", error_description: "Community covers one tenant" }, { status: 403 })
        : Response.json({ access_token: "test" })
    }
    if (url.endsWith("/api/backup/start")) { backups.push(url); return Response.json({ jobId: "job-1" }) }
    if (url.endsWith("/api/backup/status")) return Response.json({ isComplete: true, isSuccessful: true, backupFolder: "backup-2026-09-30" })
    if (url.endsWith("/api/list-backup-contents")) return Response.json({ content: { groups: [], metadata: { Status: "Success", Failures: 0, Scope: { Excluded: [] }, SkippedTypes: [], FailedTypes: [] } } })
    if ((init?.method ?? "GET") === "GET" && url.includes("$select=")) return Response.json({ value: [] })
    graph.push(`${init?.method} ${url}${init?.body ? ` ${String(init.body)}` : ""}`)
    return url.endsWith("/deviceManagement/configurationPolicies") ? Response.json({ id: "66666666-6666-6666-6666-666666666666", name: macPolicy.name }) : new Response(null, { status: 204 })
  })
}

let store: ReturnType<typeof memoryStore>
beforeEach(() => { store = memoryStore(); setOibStore(store); resetOibSource() })
afterEach(() => { vi.unstubAllGlobals(); setOibStore(null) })

describe("basic public OIB on every platform", () => {
  it("maps Windows 365 and BYOD app protection files, and resets the author's scope tags", () => {
    expect(packFolder("win365", "WINDOWS365/IntuneManagement/SettingsCatalog/W365.json")).toBe("ConfigurationPolicies")
    expect(packFolder("win365", "WINDOWS365/IntuneManagement/CompliancePolicies/W365.json")).toBe("CompliancePolicies")
    expect(packFolder("byod", "BYOD/IntuneManagement/AppProtection/iOS.json")).toBe("AppProtection")
    expect(packFolder("byod", "BYOD/AppProtection/iOS.json", iosProtection)).toBe("AppProtectionIOS")
    expect(packFolder("byod", "BYOD/IntuneManagement/AppProtection/iOS.json", iosProtection)).toBe("AppProtectionIOS")
    expect(packFolder("byod", "BYOD/IntuneManagement/AppProtection/Android.json", androidProtection)).toBe("AppProtectionAndroid")
    expect(packFolder("byod", "BYOD/IntuneManagement/AppProtection/Other.json", { "@odata.type": "#microsoft.graph.windowsManagedAppProtection" })).toBeUndefined()
    const items = packItems("byod", [{ path: "BYOD/IntuneManagement/AppProtection/iOS.json", json: iosProtection }, { path: "BYOD/IntuneManagement/AppProtection/Android.json", json: androidProtection }])
    expect(items.map(i => [i.folder, i.name])).toEqual([["AppProtectionAndroid", androidProtection.displayName], ["AppProtectionIOS", iosProtection.displayName]])
    expect(items.find(i => i.folder === "AppProtectionIOS")!.snapshot.roleScopeTagIds).toEqual(["0"])
    expect(() => packItems("byod", [{ path: "BYOD/IntuneManagement/AppProtection/Other.json", json: { "@odata.type": "#microsoft.graph.windowsManagedAppProtection", displayName: "x" } }])).toThrow("not a policy type")
  })

  it("lets Community load, compare and deploy the macOS pack in its tenant, backup first", async () => {
    const graph: string[] = [], backups: string[] = []
    vi.stubGlobal("fetch", macFetch(graph, backups))
    const community = planGuard(async () => "community")
    const request = (body: object) => new Request("http://tenuvault.internal/api/oib", { method: "POST", body: JSON.stringify(body) })
    const { commit } = await handleOib({ action: "oib-source" }) as { commit: string }
    const load = { action: "oib-load", tenantId: TENANT, platform: "macos", commit }
    const compare = { ...load, action: "oib-compare", appId: APP }
    const catalog = await handleOib(load) as OibCatalog
    expect(catalog).toMatchObject({ reference: `OpenIntuneBaseline macOS · main @ ${COMMIT.slice(0, 7)}`, license: expect.stringContaining("GPL-3.0"), manifest: false })
    expect(catalog.source).toContain(COMMIT)
    expect(catalog.policies.map(p => p.source)).toEqual(["MACOS/IntuneManagement/SettingsCatalog/MacOS - OIB - FileVault.json"])
    expect((await handleOib(compare) as OibComparison).matches).toMatchObject([{ status: "missing" }])
    const deploy = { action: "oib-deploy", tenantId: TENANT, appId: APP, storageAccountName: `tvlocal-${TENANT}`, platform: "macos", commit, items: [{ source: catalog.policies[0]!.source, mode: "create" }] }
    for (const body of [load, compare, deploy]) expect(await community(request(body))).toBeNull()
    const run = await handleOib(deploy) as OibRun
    expect(backups).toHaveLength(1)
    expect(run).toMatchObject({ tenantId: TENANT, platform: "macos", commit: COMMIT, backupFolder: "backup-2026-09-30", created: [{ name: macPolicy.name }], failed: [] })
    expect(graph).toHaveLength(1)
    expect(graph[0]).toMatch(/^POST https:\/\/graph\.microsoft\.com\/beta\/deviceManagement\/configurationPolicies /)
    expect(graph[0]).toContain('"roleScopeTagIds":["0"]')
  })

  it("refuses a second tenant the license does not cover before any backup or write", async () => {
    const graph: string[] = [], backups: string[] = []
    vi.stubGlobal("fetch", macFetch(graph, backups, SECOND))
    const { commit } = await handleOib({ action: "oib-source" }) as { commit: string }
    await expect(handleOib({ action: "oib-deploy", tenantId: SECOND, appId: APP, storageAccountName: `tvlocal-${SECOND}`, platform: "macos", commit,
      items: [{ source: "MACOS/IntuneManagement/SettingsCatalog/MacOS - OIB - FileVault.json", mode: "create" }] })).rejects.toThrow()
    expect(backups).toEqual([])
    expect(graph).toEqual([])
    expect(store.values.size).toBe(0)
  })

  it("keeps deploying to further tenants MSP only", async () => {
    const request = new Request("http://tenuvault.internal/api/oib", { method: "POST", body: JSON.stringify({ action: "oib-deploy", tenantId: SECOND, platform: "macos", bulk: true, items: [{ source: "a", mode: "create" }] }) })
    expect((await planGuard(async () => "pro")(request.clone()))?.status).toBe(402)
    expect(await planGuard(async () => "msp")(request.clone())).toBeNull()
  })
})
