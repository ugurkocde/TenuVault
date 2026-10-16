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
    description: "Scores, hygiene findings and standards for the selected tenant.",
    tabs: [
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
        id: "standards",
        label: "Standards and customizations",
        feature: "customizations",
        path: "/api/standards",
        summary: "Records your organization's baseline customizations, and for MSPs reusable versioned golden standards with customer overlays.",
        points: ["Immutable standard versions with provenance and change notes.", "Customer overlays, parameters and exceptions kept separate from the base.", "A new base version never changes a customer tenant by itself."],
        Component: lazy(() => import("./standards/StandardsTab")),
      },
    ],
  },
  {
    id: "changes",
    title: "Changes",
    description: "Dev to Prod promotion and baseline upgrades.",
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
