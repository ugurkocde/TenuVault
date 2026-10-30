/**
 * The tenants an API request changes through Microsoft Graph; empty for requests that only
 * read, back up, assess, preview or plan. The main process asks for the disclaimer before
 * any of these tenants is changed, so a new route or action that writes to a tenant must be
 * added here.
 */
export function tenantWriteTargets(pathname: string, body: Record<string, unknown>): string[] {
  const tenant = typeof body.tenantId === "string" ? [body.tenantId] : []
  const action = typeof body.action === "string" ? body.action : ""
  switch (pathname) {
    case "/api/restore-backup": {
      // A copy to other tenants writes only to them; tenantId then just names the backup's tenant.
      if (body.targetTenants === undefined) return tenant
      return Array.isArray(body.targetTenants)
        ? body.targetTenants.map((target: { tenantId?: unknown }) => target?.tenantId).filter((id): id is string => typeof id === "string")
        : []
    }
    case "/api/revert-policy":
      return action === "revert" || action === "restore" ? tenant : []
    case "/api/oib":
      return WRITE_ACTIONS.oib.has(action) ? tenant : []
    case "/api/frameworks":
      return action === "create" ? tenant : []
    // Change sets are applied to the tenant that holds them; targetTenants are only read.
    case "/api/promotion":
      return WRITE_ACTIONS.promotion.has(action) ? tenant : []
    case "/api/baseline-upgrades":
    case "/api/custom-baselines":
      return action === "change-apply" ? tenant : []
    case "/api/standards":
      return action === "standard-change-apply" ? tenant : []
    case "/api/cis-remediation":
      return WRITE_ACTIONS.cisRemediation.has(action) ? tenant : []
    default:
      return []
  }
}

const WRITE_ACTIONS = {
  oib: new Set(["oib-deploy", "oib-fix", "oib-undo"]),
  promotion: new Set(["apply", "retry", "rollback-apply"]),
  cisRemediation: new Set(["apply", "retry", "rollback-apply"]),
}
