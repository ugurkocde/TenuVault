import { afterEach, describe, expect, it, vi } from "vitest"
import { buildTenantProfile } from "../src/renderer/lib/desktop-tenant"

const credentials = { tenantId: "tenant", appId: "app", clientSecret: "secret" }

function answer(body: unknown, status = 200) {
  vi.stubGlobal("fetch", async () => Response.json(body, { status }))
}

describe("tenant profile from Microsoft Graph details", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("names the tenant after its organization and keeps unreadable counts unknown, never zero", async () => {
    answer({
      organization: { displayName: "Contoso", primaryDomain: "contoso.com" },
      statistics: {
        userCount: null, deviceCount: 8, complianceRate: null,
        policies: { deviceConfigurations: 0, compliancePolicies: 21, configurationPolicies: 1300, appProtectionPolicies: null },
      },
      unavailable: ["users", "compliant devices", "iOS app protection policies"],
    })
    const tenant = await buildTenantProfile(credentials)
    expect(tenant).toMatchObject({ name: "Contoso", domain: "contoso.com", users: null, devices: 8, complianceRate: null, configCount: 1300 })
    // Configuration profiles include Settings Catalog policies, even with no legacy device configurations.
    expect(tenant.policies).toEqual({ compliance: 21, configuration: 1300, apps: null, deviceConfigurations: 0, configurationPolicies: 1300, appProtectionPolicies: null })
  })

  it("leaves the configuration total unknown when either part could not be read", async () => {
    answer({ organization: { displayName: "Contoso" }, statistics: { policies: { deviceConfigurations: 4, configurationPolicies: null } } })
    const tenant = await buildTenantProfile(credentials)
    expect(tenant.policies.configuration).toBeNull()
    expect(tenant.configCount).toBeNull()
  })

  it("prefers the display name the admin typed and falls back when the details cannot be read", async () => {
    answer({ organization: { displayName: "Contoso" } })
    expect((await buildTenantProfile({ ...credentials, displayName: "Contoso Production" })).name).toBe("Contoso Production")
    answer({ error: "The organization could not be read" }, 502)
    const tenant = await buildTenantProfile(credentials)
    expect(tenant).toMatchObject({ name: "New tenant", users: null, policies: { compliance: null, configuration: null, apps: null } })
  })
})
