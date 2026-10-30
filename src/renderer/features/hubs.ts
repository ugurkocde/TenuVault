import { lazy, type ComponentType, type LazyExoticComponent } from "react"
import type { Feature } from "../../shared/plans"
import type { FeatureRoutePath } from "../../shared/feature-routes"
import type { FeatureTabProps } from "./types"

export interface HubTab {
  id: string
  label: string
  feature: Feature
  path: FeatureRoutePath
  /** What the screen does, for the locked preview. */
  summary: string
  points: string[]
  Component: LazyExoticComponent<ComponentType<FeatureTabProps>>
}

export interface Hub {
  id: string
  title: string
  description: string
  tabs: HubTab[]
}

/** The roadmap workflows, grouped into three hubs so the sidebar stays short. */
export const HUBS: Hub[] = [
  {
    id: "governance",
    title: "Governance",
    description: "Are we compliant, where do we deviate on purpose, who accepted it? Posture, findings and standards for the selected tenant.",
    tabs: [
      {
        id: "overview",
        label: "Overview",
        feature: "baselineScores",
        path: "/api/scores",
        summary: "Posture at a glance: the latest baseline score, open hygiene findings, accepted deviations and standard upgrades, each with its source and age, plus a one-file evidence pack.",
        points: ["Built only from what the other Governance screens already show; nothing is read live.", "Every figure names its evidence and how old it is, so a stale snapshot never reads as current.", "Decisions made in Governance are recorded in the Audit Log."],
        Component: lazy(() => import("./governance/OverviewTab")),
      },
      {
        id: "scores",
        label: "Baseline scores",
        feature: "baselineScores",
        path: "/api/scores",
        summary: "Scores per framework from saved native comparisons, with evaluated coverage and unknowns shown separately.",
        points: ["Score = matching capabilities divided by evaluated capabilities, shown with its coverage; unknown capabilities and framework references without a check are left out of the score. OpenIntuneBaseline scores count expected settings.", "Trends only connect assessments of the same framework version, profile and scope.", "MSP: per-tenant scores and a portfolio drill-down."],
        Component: lazy(() => import("./scores/ScoresTab")),
      },
      {
        id: "hygiene",
        label: "Conflicts and hygiene",
        feature: "hygieneExplorer",
        path: "/api/hygiene",
        summary: "Finds candidate conflicting settings, duplicate profiles, unassigned policies and broken references.",
        points: ["Separates definite configuration problems from possible overlaps that need group or device context.", "Acknowledge findings or mark false positives with a documented reason.", "Never deletes or changes a policy."],
        Component: lazy(() => import("./hygiene/HygieneTab")),
      },
      {
        id: "deviations",
        label: "Accepted deviations",
        feature: "customizations",
        path: "/api/standards",
        summary: "One register of what this tenant knowingly does differently: documented customizations, accepted hygiene findings and approved standard exceptions, with owner, reason and expiry.",
        points: ["Expired deviations sort first, so re-review is obvious.", "Read-only by design: changing a decision happens on its owning screen.", "Every decision behind the register is recorded in the Audit Log."],
        Component: lazy(() => import("./governance/DeviationsTab")),
      },
      {
        id: "customizations",
        label: "Customizations",
        feature: "customizations",
        path: "/api/standards",
        summary: "Records where your organization deliberately differs from its installed baseline, with reason, owner and an optional re-review date.",
        points: ["Versioned records; retiring one keeps its history.", "Baseline upgrades mark settings documented here.", "Nothing here changes the tenant."],
        Component: lazy(() => import("./standards/CustomizationsTab")),
      },
      {
        id: "standards",
        label: "Golden standards",
        feature: "goldenStandards",
        path: "/api/standards",
        summary: "Reusable versioned golden standards for MSP customers, adopted per tenant through reviewed change sets.",
        points: ["Immutable standard versions with provenance and change notes.", "Customer overlays, parameters and exceptions kept separate from the base.", "A new base version never changes a customer tenant by itself."],
        Component: lazy(() => import("./standards/GoldenStandardsTab")),
      },
    ],
  },
  {
    id: "changes",
    title: "Changes",
    description: "What will we change, and who reviewed and approved it? Dev to Prod promotion and baseline upgrades, applied only through reviewed change sets.",
    tabs: [
      {
        id: "promotion",
        label: "Dev to Prod",
        feature: "promotion",
        path: "/api/promotion",
        summary: "Promotes selected Settings Catalog policies from a development tenant to production, one way and on demand.",
        points: ["Pro: between the two tenants of your license.", "Production is backed up and checked for changes right before apply.", "Assignments are excluded until reviewed separately."],
        Component: lazy(() => import("./promotion/PromotionTab")),
      },
      {
        id: "baseline-upgrades",
        label: "Baseline upgrades",
        feature: "baselineUpgrades",
        path: "/api/baseline-upgrades",
        summary: "Compares the installed baseline version, your changes and a new upstream version.",
        points: ["Keeps unchanged local overrides and asks you to resolve conflicting edits.", "Without recorded provenance it offers a manual reviewed comparison.", "Applies only through a confirmed change set with backup and read-back."],
        Component: lazy(() => import("./baseline-upgrades/BaselineUpgradesTab")),
      },
    ],
  },
  {
    id: "operations",
    title: "Operations",
    description: "Scheduled health review of backups and work signals.",
    tabs: [
      {
        id: "health-review",
        label: "Health review",
        feature: "healthReview",
        path: "/api/health-review",
        summary: "A scheduled review of stale backups, pending upgrades, conflicts, deviations and stale scores, with opt-in notifications.",
        points: ["Notifications go only to an endpoint you configure, with a preview of what is sent.", "No tokens, credentials or policy content are sent.", "Runs only while TenuVault runs; the last review time is always shown."],
        Component: lazy(() => import("./health-review/HealthReviewTab")),
      },
    ],
  },
]
