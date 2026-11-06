import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearSettingNames } from "../src/portal/lib/drift/setting-names"
import { handleOib, setOibStore } from "../src/main/oib/service"
import { resetOibSource } from "../src/main/oib/source"
import { definitionIdsOf, describePolicy, MAX_SETTING_ROWS, policyChanges, type OibPolicyChanges, type OibPolicySettings } from "../src/shared/oib/policy-settings"
import { memoryStore } from "./helpers"

const simple = (id: string, value: unknown) => ({ id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: id, settingInstanceTemplateReference: null, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value } } })
const choice = (id: string, value: string, children: unknown[] = []) => ({ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: id, choiceSettingValue: { value, children } } })
const child = (setting: { settingInstance: unknown }) => setting.settingInstance

const CLOUD = "device_vendor_msft_policy_config_defender_allowcloudprotection"
const LEVEL = "device_vendor_msft_policy_config_defender_cloudblocklevel"
const catalogPolicy = (settings: unknown[]) => ({ source: "WINDOWS/sc.json", name: "Win - OIB - SC - Defender - v4.0", folder: "ConfigurationPolicies", snapshot: { name: "Win - OIB - SC - Defender - v4.0", settings } as never })

describe("OIB policy settings", () => {
  it("lists Settings Catalog settings in policy order, with names and choice labels from Graph", () => {
    const policy = catalogPolicy([choice(CLOUD, `${CLOUD}_1`, [child(choice(LEVEL, `${LEVEL}_2`))]), simple("device_vendor_msft_policy_config_defender_submitsamplesconsent", 3)])
    const names = { settings: { [CLOUD]: "Allow Cloud Protection", [LEVEL]: "Cloud Block Level" }, options: { [`${CLOUD}_1`]: "Allowed. Turns on Cloud Protection.", [`${LEVEL}_2`]: "High" } }
    const view = describePolicy(policy, names)
    expect(view.total).toBe(2)
    expect(view.settings[0]).toEqual({ id: CLOUD, label: "Allow Cloud Protection", lines: ["Allowed. Turns on Cloud Protection.", "  Cloud Block Level: High"] })
    // Without a name from Graph the label comes from the setting ID.
    expect(view.settings[1]).toMatchObject({ label: "Defender: Submit samples consent", lines: ["3"] })
  })

  it("falls back to option tokens without names", () => {
    const view = describePolicy(catalogPolicy([choice(CLOUD, `${CLOUD}_1`)]))
    expect(view.settings[0]).toMatchObject({ label: "Defender: Allow cloud protection", lines: ["1"] })
  })

  it("lists properties of other policy types in policy order and leaves out names and metadata", () => {
    const view = describePolicy({ source: "c.json", name: "Win - OIB - CP - Password", folder: "CompliancePolicies", snapshot: {
      "@odata.type": "#microsoft.graph.windows10CompliancePolicy", id: "x", displayName: "Win - OIB - CP - Password", version: 3, passwordRequired: true, passwordMinimumLength: 12,
      osMinimumVersion: null, validOperatingSystemBuildRanges: [], allowedDataStorageLocations: ["oneDriveForBusiness", "sharePoint"], "passwordRequired@odata.type": "#Boolean",
    } })
    expect(view.settings).toEqual([
      { id: "passwordRequired", label: "Password Required", lines: ["true"] },
      { id: "passwordMinimumLength", label: "Password Minimum Length", lines: ["12"] },
      { id: "allowedDataStorageLocations", label: "Allowed Data Storage Locations", lines: ["oneDriveForBusiness, sharePoint"] },
    ])
  })

  it("lists administrative templates with their state and values", () => {
    const def = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    const view = describePolicy({ source: "a.json", name: "Admx", folder: "GroupPolicyConfigurations", snapshot: { definitionValues: [
      { enabled: true, definition: { id: def, displayName: "Turn on script scanning" }, presentationValues: [{ value: "5", presentation: { id: "p" } }] },
    ] } })
    expect(view.settings).toEqual([{ id: def, label: "Turn on script scanning", lines: ["Enabled", "  Value: 5"] }])
  })

  it("cuts long lists and says how many settings there are", () => {
    const view = describePolicy(catalogPolicy(Array.from({ length: MAX_SETTING_ROWS + 3 }, (_, index) => simple(`device_vendor_msft_s${index}`, index))))
    expect(view.settings).toHaveLength(MAX_SETTING_ROWS)
    expect(view.total).toBe(MAX_SETTING_ROWS + 3)
  })

  it("collects every setting definition, children included", () => {
    expect(definitionIdsOf({ settings: [choice(CLOUD, `${CLOUD}_1`, [child(choice(LEVEL, `${LEVEL}_2`))])] } as never).sort()).toEqual([CLOUD, LEVEL].sort())
  })
})

describe("OIB policy changes", () => {
  it("lists changed, added and removed settings and counts the unchanged ones", () => {
    const next = catalogPolicy([simple("device_vendor_msft_a", 1), simple("device_vendor_msft_b", 2), simple("device_vendor_msft_new", 3)])
    const live = { name: "Win - OIB - SC - Defender - v3.0", settings: [{ ...simple("device_vendor_msft_a", 1), id: "7" }, simple("device_vendor_msft_b", 9), simple("device_vendor_msft_old", 4)] }
    const changes = policyChanges(next, { id: "t1", name: "Win - OIB - SC - Defender - v3.0", policy: live as never })
    expect(changes).toMatchObject({ supported: true, unchanged: 1, tenantPolicyName: "Win - OIB - SC - Defender - v3.0", counts: { changed: 1, added: 1, removed: 1 } })
    expect(changes.changed).toEqual([{ id: "device_vendor_msft_b", label: "B", before: ["9"], after: ["2"] }])
    expect(changes.added.map(r => r.id)).toEqual(["device_vendor_msft_new"])
    expect(changes.removed.map(r => r.id)).toEqual(["device_vendor_msft_old"])
  })

  it("reports no changes when only the name differs", () => {
    const next = catalogPolicy([simple("device_vendor_msft_a", 1)])
    const changes = policyChanges(next, { id: "t1", name: "old", policy: { name: "old", settings: [simple("device_vendor_msft_a", 1)] } as never })
    expect(changes).toMatchObject({ supported: true, unchanged: 1, counts: { changed: 0, added: 0, removed: 0 } })
  })

  it("does not compare policy types that Policy Validation does not compare", () => {
    const changes = policyChanges({ source: "ios.json", name: "iOS", folder: "AppProtectionIOS", snapshot: { pinRequired: true } }, { id: "t", name: "iOS", policy: { pinRequired: false } })
    expect(changes).toMatchObject({ supported: false, changed: [], added: [], removed: [] })
  })
})

const tenantId = "11111111-1111-1111-1111-111111111111"
const appId = "22222222-2222-2222-2222-222222222222"
const commit = "b".repeat(40)
const EXISTING = "55555555-5555-5555-5555-555555555555"
const SC = "WINDOWS/IntuneManagement/SettingsCatalog/Win - OIB - SC - Defender - v4.0.json"
const base = { tenantId, appId, platform: "windows", commit }

/** GitHub, the token endpoint and Graph; `requests` records every call that is not GitHub. */
function world(requests: string[], options: { batch?: number } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    if (url.endsWith("/commits/main")) return Response.json({ sha: commit, commit: { committer: { date: "2026-09-01T00:00:00Z" } } })
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [{ type: "blob", path: SC }] })
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      return Response.json({ name: "Win - OIB - SC - Defender - v4.0", description: "Tenant %OrganizationId%", settings: [choice(CLOUD, `${CLOUD}_1`), simple("device_vendor_msft_policy_config_defender_tenant", "%OrganizationId%")] })
    }
    if (url.includes("oauth2")) return Response.json({ access_token: "test" })
    const path = url.replace("https://graph.microsoft.com/beta/", "")
    requests.push(`${method} ${path}`)
    if (method === "POST" && path === "$batch") {
      if (options.batch && options.batch !== 200) return Response.json({}, { status: options.batch })
      const { requests: reads } = JSON.parse(String(init!.body)) as { requests: Array<{ id: string; url: string }> }
      return Response.json({ responses: reads.map(read => read.url.endsWith(CLOUD)
        ? { id: read.id, status: 200, body: { displayName: "Allow Cloud Protection", options: [{ itemId: `${CLOUD}_1`, displayName: "Allowed" }] } }
        : { id: read.id, status: 404 }) })
    }
    if (method === "GET" && path.startsWith(`deviceManagement/configurationPolicies/${EXISTING}`)) {
      if (path.includes("/assignments")) return Response.json({ value: [] })
      return Response.json({ id: EXISTING, name: "Win - OIB - SC - Defender - v3.0", settings: [choice(CLOUD, `${CLOUD}_0`)] })
    }
    if (method === "GET" && path.startsWith("deviceManagement/configurationPolicies/")) return Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 })
    return new Response(null, { status: 204 })
  })
}

beforeEach(() => { setOibStore(memoryStore()); resetOibSource(); clearSettingNames() })
afterEach(() => { vi.unstubAllGlobals(); setOibStore(null) })

describe("oib-policy-settings and oib-policy-changes", () => {
  it("reads an OIB policy's settings with names from Graph and the tenant ID in place of %OrganizationId%, without writing", async () => {
    const requests: string[] = []
    vi.stubGlobal("fetch", world(requests))
    await handleOib({ action: "oib-source" })
    const view = await handleOib({ ...base, action: "oib-policy-settings", source: SC }) as OibPolicySettings
    expect(view).toMatchObject({ name: "Win - OIB - SC - Defender - v4.0", total: 2 })
    expect(view.namesMissing).toBeUndefined()
    expect(view.settings[0]).toMatchObject({ label: "Allow Cloud Protection", lines: ["Allowed"] })
    expect(view.settings[1]!.lines).toEqual([tenantId])
    expect(requests).toEqual(["POST $batch"])
  })

  it("still lists the settings when Graph cannot give the names", async () => {
    vi.stubGlobal("fetch", world([], { batch: 503 }))
    await handleOib({ action: "oib-source" })
    const view = await handleOib({ ...base, action: "oib-policy-settings", source: SC }) as OibPolicySettings
    expect(view).toMatchObject({ total: 2, namesMissing: true })
    expect(view.settings[0]!.label).toBe("Defender: Allow cloud protection")
  })

  it("rejects a policy that is not in the pack", async () => {
    vi.stubGlobal("fetch", world([]))
    await handleOib({ action: "oib-source" })
    await expect(handleOib({ ...base, action: "oib-policy-settings", source: "WINDOWS/other.json" })).rejects.toThrow("is not part of this OIB pack")
    await expect(handleOib({ ...base, action: "oib-policy-settings" })).rejects.toThrow("Choose an OpenIntuneBaseline policy.")
  })

  it("compares the tenant policy with the OIB version it would be updated to, only reading the tenant", async () => {
    const requests: string[] = []
    vi.stubGlobal("fetch", world(requests))
    await handleOib({ action: "oib-source" })
    const changes = await handleOib({ ...base, action: "oib-policy-changes", source: SC, targetId: EXISTING }) as OibPolicyChanges
    expect(changes).toMatchObject({ supported: true, tenantPolicyId: EXISTING, tenantPolicyName: "Win - OIB - SC - Defender - v3.0", unchanged: 0, counts: { changed: 1, added: 1, removed: 0 } })
    expect(changes.changed[0]).toMatchObject({ label: "Allow Cloud Protection", before: ["0"], after: ["Allowed"] })
    expect(requests.every(request => request.startsWith("GET ") || request === "POST $batch")).toBe(true)
  })

  it("says when the tenant policy is gone and validates the target", async () => {
    vi.stubGlobal("fetch", world([]))
    await handleOib({ action: "oib-source" })
    await expect(handleOib({ ...base, action: "oib-policy-changes", source: SC, targetId: "77777777-7777-7777-7777-777777777777" })).rejects.toThrow("The tenant policy no longer exists. Compare again.")
    await expect(handleOib({ ...base, action: "oib-policy-changes", source: SC, targetId: "../x" })).rejects.toThrow("Choose the tenant policy to compare.")
  })
})
