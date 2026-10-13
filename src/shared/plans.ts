/**
 * What each plan includes. The main process enforces it and the renderer uses it for
 * badges and upgrade prompts, so both always agree.
 *
 * Community is free for one tenant; Pro covers two tenants; MSP covers the subscribed
 * quantity. The licensing service enforces tenant counts; this file covers features.
 */

export type Plan = "community" | "pro" | "msp"

export type Feature =
  | "dailySchedule"
  | "customRetention"
  | "azureStorage"
  | "fullRestore"
  | "replaceRestore"
  | "restoreAssignments"
  | "driftRevert"
  | "auditLog"
  | "baselineAllPlatforms"
  | "crossTenant"
  | "bulkActions"
  | "baselineScores"
  | "hygieneExplorer"
  | "baselineUpgrades"
  | "promotion"
  | "healthReview"
  | "customizations"
  | "portfolio"
  | "goldenStandards"
  | "customBaselines"

/** The lowest plan that includes a feature. */
export const FEATURE_PLAN: Record<Feature, Exclude<Plan, "community">> = {
  dailySchedule: "pro",
  customRetention: "pro",
  azureStorage: "pro",
  fullRestore: "pro",
  replaceRestore: "pro",
  restoreAssignments: "pro",
  driftRevert: "pro",
  auditLog: "pro",
  baselineAllPlatforms: "pro",
  crossTenant: "msp",
  bulkActions: "msp",
  baselineScores: "pro",
  hygieneExplorer: "pro",
  baselineUpgrades: "pro",
  promotion: "pro",
  healthReview: "pro",
  customizations: "pro",
  portfolio: "msp",
  goldenStandards: "msp",
  customBaselines: "pro",
}

const FEATURE_NAMES: Record<Feature, string> = {
  dailySchedule: "Daily scheduled backups",
  customRetention: "Custom backup history",
  azureStorage: "Backups in your own Azure storage account",
  fullRestore: "Restoring several items at once",
  replaceRestore: "Replacing items in place",
  restoreAssignments: "Restoring assignments",
  driftRevert: "One click revert of drifted policies",
  auditLog: "The audit log",
  baselineAllPlatforms: "CIS Benchmark and CIS Controls assessments and reports",
  crossTenant: "The cross tenant dashboard",
  bulkActions: "Actions across several tenants",
  baselineScores: "Dashboard baseline scores",
  hygieneExplorer: "The policy conflict and hygiene explorer",
  baselineUpgrades: "Baseline upgrades that keep your customizations",
  promotion: "Dev to Prod settings promotion",
  healthReview: "Scheduled health review and notifications",
  customizations: "Organization baseline customizations",
  portfolio: "Portfolio views across customer tenants",
  goldenStandards: "Reusable golden standards for customers",
  customBaselines: "Custom baselines from OpenIntuneBaseline or a tenant snapshot",
}

/** Licensed CIS content: its assessments and reports need baselineAllPlatforms; other frameworks are free. */
export const CIS_FRAMEWORKS: ReadonlySet<string> = new Set(["cis-benchmarks", "cis-controls"])

/** Backup history kept on Community, in days. */
export const COMMUNITY_RETENTION_DAYS = 30

const RANK: Record<Plan, number> = { community: 0, pro: 1, msp: 2 }

export function allows(plan: Plan, feature: Feature): boolean {
  return RANK[plan] >= RANK[FEATURE_PLAN[feature]]
}

export function planLabel(plan: Plan): string {
  return plan === "msp" ? "MSP" : plan === "pro" ? "Pro" : "Community"
}

/** The plain name of a feature, for previews of locked screens. */
export function featureName(feature: Feature): string {
  return FEATURE_NAMES[feature]
}

/** The message shown when a plan does not include a feature. */
export function upgradeMessage(feature: Feature): string {
  const plan = FEATURE_PLAN[feature]
  return `${FEATURE_NAMES[feature]}: included in TenuVault ${plan === "msp" ? "MSP" : "Pro and MSP"}. Upgrade on the License page.`
}

/** The retention that pruning applies: plans without customRetention keep the Community limit. */
export function effectiveRetentionDays(days: number, plan: Plan | null): number {
  if (plan !== null && allows(plan, "customRetention")) return days
  return days === 0 ? COMMUNITY_RETENTION_DAYS : Math.min(days, COMMUNITY_RETENTION_DAYS)
}

/** Thrown when an action needs a higher plan; the API host answers 402 with its message. */
export class PlanRequired extends Error {
  constructor(readonly feature: Feature) {
    super(upgradeMessage(feature))
    this.name = "PlanRequired"
  }
}
