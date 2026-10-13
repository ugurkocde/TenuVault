import type { RouteModule } from "../api/host"
import type { FeatureDeps } from "./deps"
import * as scores from "./scores"
import * as hygiene from "./hygiene"
import * as baselineUpgrades from "./baseline-upgrades"
import * as promotion from "./promotion"
import * as healthReview from "./health-review"
import * as standards from "./standards"
import * as customBaselines from "./custom-baselines"
import * as cisRemediation from "./cis-remediation"

const MODULES = [scores, hygiene, baselineUpgrades, promotion, healthReview, standards, customBaselines, cisRemediation]

/** Every roadmap workflow route, merged into the API host next to the file routes. */
export function featureRoutes(deps: FeatureDeps): Record<string, RouteModule> {
  return Object.assign({}, ...MODULES.map((module) => module.routes(deps)))
}

/**
 * Starts background work of the roadmap workflows (scheduled reviews).
 * It runs only while the app runs; returns a function that stops everything.
 */
export function startFeatures(deps: FeatureDeps): () => void {
  const stops = MODULES.map((module) => module.start(deps))
  return () => stops.forEach((stop) => stop())
}
