/**
 * The name a tenant keeps after its details are refreshed from Microsoft Graph. The current
 * name wins, including a rename made while the refresh was in flight; only the placeholder
 * names shown before the first successful refresh are replaced by the organization name.
 * Callers must pass the tenant's latest name, not the name captured before the fetch.
 */
export function nameAfterRefresh(latestName: string, organizationName: string): string {
  return latestName === "Loading..." || latestName === "New Tenant" ? organizationName : latestName
}
