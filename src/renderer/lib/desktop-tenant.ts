import type { Tenant } from "~/contexts/TenantContext"
import type { TenantCredentials } from "../overrides/add-tenant-modal"

/** A count is null when Microsoft Graph could not read it; it is never shown as zero. */
interface TenantDetails {
  organization?: { displayName?: string; primaryDomain?: string }
  statistics?: {
    userCount?: number | null
    deviceCount?: number | null
    complianceRate?: number | null
    policies?: {
      deviceConfigurations?: number | null
      compliancePolicies?: number | null
      configurationPolicies?: number | null
      appProtectionPolicies?: number | null
    }
  }
}

const known = (value: number | null | undefined): number | null => (typeof value === "number" ? value : null)

/** Builds a tenant profile from Microsoft Graph details, without placeholder values. */
export async function buildTenantProfile(credentials: TenantCredentials): Promise<Tenant> {
  let details: TenantDetails = {}
  try {
    const response = await fetch("/api/fetch-tenant-details", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    })
    if (response.ok) details = (await response.json()) as TenantDetails
  } catch {
    // The profile still works; details refresh from the Tenants page.
  }
  const policies = details.statistics?.policies ?? {}
  const deviceConfigurations = known(policies.deviceConfigurations)
  const configurationPolicies = known(policies.configurationPolicies)
  // Legacy device configurations and Settings Catalog policies together, or null when either is unknown.
  const configuration = deviceConfigurations !== null && configurationPolicies !== null ? deviceConfigurations + configurationPolicies : null
  return {
    id: Date.now(),
    name: credentials.displayName || details.organization?.displayName || "New tenant",
    domain: details.organization?.primaryDomain ?? "",
    status: "healthy",
    lastBackup: "",
    configCount: configuration,
    storageUsed: "",
    client: "",
    license: "",
    region: "",
    tags: [],
    users: known(details.statistics?.userCount),
    devices: known(details.statistics?.deviceCount),
    complianceRate: known(details.statistics?.complianceRate),
    industry: "",
    environment: "",
    lastSync: new Date().toISOString(),
    syncStatus: "idle",
    policies: {
      compliance: known(policies.compliancePolicies),
      configuration,
      apps: known(policies.appProtectionPolicies),
      deviceConfigurations,
      configurationPolicies,
      appProtectionPolicies: known(policies.appProtectionPolicies),
    },
    credentials: { tenantId: credentials.tenantId, appId: credentials.appId, clientSecret: credentials.clientSecret },
    resources: {
      subscriptionId: credentials.subscriptionId ?? "",
      subscriptionName: "",
      resourceGroupName: credentials.resourceGroupName ?? "",
      storageAccountName: credentials.storageAccountName ?? "",
      automationAccountName: "",
      resourceGroupLocation: credentials.resourceGroupLocation ?? "",
    },
  }
}
