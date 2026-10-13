/**
 * Record domains of the roadmap workflows. Features read each other's records by these
 * names (promotion reads change sets, for example), so a domain is renamed only together
 * with a migration.
 */
export const DOMAINS = {
  hygieneFindings: "hygiene-findings",
  changeSets: "change-sets",
  changeSetContent: "change-set-content",
  baselineInstalls: "baseline-installs",
  baselineUpgrades: "baseline-upgrades",
  promotions: "promotions",
  healthReviews: "health-reviews",
  healthFindings: "health-findings",
  notificationEndpoints: "notification-endpoints",
  customizations: "customizations",
  standards: "standards",
  adoptions: "standard-adoptions",
  scoreSnapshots: "score-snapshots",
  customBaselines: "custom-baselines",
  customBaselineDeployments: "custom-baseline-deployments",
  customBaselineComparisons: "custom-baseline-comparisons",
  cisRemediations: "cis-remediations",
} as const
