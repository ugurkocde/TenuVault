import { isLocalAccount } from "../storage/blob-emulator"
import { allows, CIS_FRAMEWORKS, upgradeMessage, type Feature, type Plan } from "../../shared/plans"
import { featureRouteFeatures, isFeatureRoute } from "../../shared/feature-routes"

// Framework report exports: native comparisons and saved policy pack assessments.
const FRAMEWORK_EXPORTS = new Set(["native-pdf", "native-csv", "native-json", "workspace-pdf", "workspace-csv", "workspace-json", "workspace-cis-pdf"])

/** A bulk run names every tenant it touches in targetTenants, like a restore copy, or marks itself bulk, like an OIB deploy to a further tenant. Single tenant calls carry neither. */
function isBulk(body: Record<string, unknown>): boolean {
  return body.bulk === true || body.targetTenants !== undefined
}

/**
 * The paid features an API request uses, from its path and JSON body; empty when every plan
 * may make it. The renderer shows the same limits; this is where they hold.
 */
export function requiredFeatures(pathname: string, body: Record<string, unknown>): Feature[] {
  switch (pathname) {
    case "/api/backup/start": {
      const features: Feature[] = []
      if (typeof body.storageAccountName === "string" && !isLocalAccount(body.storageAccountName)) features.push("azureStorage")
      if (isBulk(body)) features.push("bulkActions")
      return features
    }
    case "/api/detect-drifts":
      return isBulk(body) ? ["bulkActions"] : []
    case "/api/restore-backup": {
      const features: Feature[] = []
      const selected = Array.isArray(body.selectedPolicies) ? body.selectedPolicies.length : 0
      if (body.targetTenants !== undefined) features.push("bulkActions")
      if (body.restoreType !== "selective" || selected > 1) features.push("fullRestore")
      if (body.mode === "replace") features.push("replaceRestore")
      if (body.assignments === true) features.push("restoreAssignments")
      return features
    }
    case "/api/restore-validate":
      return ["fullRestore"]
    case "/api/revert-policy":
      return body.action === "revert" ? ["driftRevert"] : []
    // The audit log is Pro and MSP; /api/audit/log stays open so the main process can write entries.
    case "/api/audit/logs":
    case "/api/audit/stats":
    case "/api/audit/export":
    case "/api/audit/cleanup":
      return ["auditLog"]
    case "/api/frameworks": {
      // Community assesses and exports every framework; licensed CIS content (assessments and
      // reports) is paid.
      const action = typeof body.action === "string" ? body.action : ""
      if ((action === "assess" || FRAMEWORK_EXPORTS.has(action)) && typeof body.frameworkId === "string" && CIS_FRAMEWORKS.has(body.frameworkId)) return ["baselineAllPlatforms"]
      return []
    }
    case "/api/oib": {
      // Community deploys, compares and validates the OpenIntuneBaseline on every platform in one
      // tenant; updating existing policies in place and resetting drift are paid.
      const features: Feature[] = []
      const updates = Array.isArray(body.items) && body.items.some((item: { mode?: unknown }) => item?.mode === "update")
      if (body.action === "oib-deploy" && updates) features.push("replaceRestore")
      if (body.action === "oib-fix") features.push("driftRevert")
      // Deployments to the tenants after the first are an MSP action on each of them.
      if ((body.action === "oib-deploy" || body.action === "oib-fix") && body.bulk === true) features.push("bulkActions")
      return features
    }
    default:
      return isFeatureRoute(pathname) && typeof body.action === "string" ? featureRouteFeatures(pathname, body.action) : []
  }
}

/** The first paid feature a request uses, or null. */
export function requiredFeature(pathname: string, body: Record<string, unknown>): Feature | null {
  return requiredFeatures(pathname, body)[0] ?? null
}

/**
 * An ApiHost guard that answers 402 with an upgrade message when the tenant's plan does
 * not include the feature a request uses. planOf resolves the plan (claiming Community for
 * a first unlicensed tenant); null means the tenant cannot be used, which the request
 * itself then reports.
 */
export function planGuard(planOf: (tenantId: string) => Promise<Plan | null>) {
  return async (request: Request): Promise<Response | null> => {
    if (request.method !== "POST") return null
    const pathname = new URL(request.url).pathname.replace(/\/$/, "")
    let body: Record<string, unknown>
    try {
      body = (await request.clone().json()) as Record<string, unknown>
    } catch {
      return null
    }
    // The roadmap workflows always name the tenant they act on.
    if (isFeatureRoute(pathname) && (typeof body?.tenantId !== "string" || typeof body.action !== "string")) {
      return Response.json({ error: "tenantId and action are required" }, { status: 400 })
    }
    const features = requiredFeatures(pathname, body ?? {})
    if (!features.length) return null
    // A malformed bulk target must not be quietly dropped from the plan check.
    if ((pathname === "/api/backup/start" || pathname === "/api/detect-drifts") && body.targetTenants !== undefined) {
      const malformed = !Array.isArray(body.targetTenants) || body.targetTenants.some((target: { tenantId?: unknown }) => typeof target?.tenantId !== "string")
      if (malformed) return Response.json({ error: "targetTenants must name every tenant in the bulk action" }, { status: 400 })
    }
    // A tenantId of another type must not skip the plan check.
    if (typeof body.tenantId !== "string") {
      return body.tenantId === undefined ? null : Response.json({ error: "tenantId must be a string" }, { status: 400 })
    }
    // Actions across tenants need the plan on every tenant they touch.
    const targets = Array.isArray(body.targetTenants)
      ? body.targetTenants.map((target: { tenantId?: unknown }) => target?.tenantId).filter((id): id is string => typeof id === "string")
      : []
    for (const tenantId of [body.tenantId, ...targets]) {
      const plan = await planOf(tenantId)
      // Single tenant calls leave an unusable tenant to the request itself. A bulk run must be
      // refused as a whole before any work starts, so an unusable tenant refuses it here.
      if (tenantId === body.tenantId && !plan && !((pathname === "/api/backup/start" || pathname === "/api/detect-drifts") && isBulk(body))) return null
      const missing = features.find((feature) => !plan || !allows(plan, feature))
      if (missing) return Response.json({ error: upgradeMessage(missing), upgrade: missing }, { status: 402 })
    }
    return null
  }
}
