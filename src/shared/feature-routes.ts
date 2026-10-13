import type { Feature } from "./plans"

/**
 * The API routes of the paid workflows added for the pricing page roadmap, and the plan
 * feature each action needs. The main process enforces these in planGuard and again in
 * the route itself; the renderer uses the same table for badges.
 *
 * Every request is `POST { tenantId, action, ... }`. The action name decides the feature:
 * - `list...` and `get...` only return records that were already created and stored, so a
 *   tenant keeps read access to its own evidence after a downgrade or license expiry.
 * - An action with one of the route's `prefixes` needs that feature instead of the route's.
 * - `revoke-...` actions are free too: they only turn off or delete local outbound
 *   configuration (a notification webhook), never tenant settings or
 *   evidence, so an admin can always stop data leaving the device after a downgrade.
 * - `portfolio-...` actions also need `portfolio` (MSP) and name every other tenant they
 *   read in `targetTenants: [{ tenantId }]`, so the plan is checked on each of them.
 * - Every other action needs the route's `feature`.
 */
export interface FeatureRoute {
  feature: Feature
  prefixes?: Record<string, Feature>
}

export const FEATURE_ROUTES = {
  "/api/scores": { feature: "baselineScores" },
  "/api/hygiene": { feature: "hygieneExplorer" },
  "/api/baseline-upgrades": { feature: "baselineUpgrades" },
  "/api/promotion": { feature: "promotion" },
  "/api/health-review": { feature: "healthReview" },
  "/api/standards": { feature: "customizations", prefixes: { "standard-": "goldenStandards" } },
  "/api/custom-baselines": { feature: "customBaselines" },
  "/api/cis-remediation": { feature: "baselineAllPlatforms" },
} as const satisfies Record<string, FeatureRoute>

export type FeatureRoutePath = keyof typeof FEATURE_ROUTES

export function isFeatureRoute(pathname: string): pathname is FeatureRoutePath {
  return Object.prototype.hasOwnProperty.call(FEATURE_ROUTES, pathname)
}

/** Actions that only read stored records and stay available on every plan. */
export function isReadAction(action: string): boolean {
  return /^(list|get|revoke)(-|$)/.test(action)
}

/** The features an action on a feature route needs; empty for stored-record reads. */
export function featureRouteFeatures(pathname: FeatureRoutePath, action: string): Feature[] {
  if (isReadAction(action)) return []
  const route: FeatureRoute = FEATURE_ROUTES[pathname]
  const prefixed = Object.entries(route.prefixes ?? {}).find(([prefix]) => action.startsWith(prefix))?.[1]
  const features: Feature[] = [prefixed ?? route.feature]
  if (action.startsWith("portfolio-")) features.push("portfolio")
  return features
}
