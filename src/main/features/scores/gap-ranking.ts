import type { Gap } from "./formula"

export type Priority = "critical" | "high" | "medium" | "low"

export const PRIORITIES: readonly Priority[] = ["critical", "high", "medium", "low"]

export interface Ranking {
  level: Priority
  /** 0 to 100; higher first. */
  score: number
  /** One plain sentence per criterion that contributed, shown next to the priority. */
  reasons: string[]
}

/**
 * Documented ranking criteria for the top gaps a score shows (docs/roadmap/137-dashboard-baseline-scores.md). Pure and
 * deterministic: the same gap always gets the same priority and the same reasons.
 *
 * Risk (what the gap exposes):
 * - Conditional Access or tenant-wide gap: +30. Identity controls apply to every sign-in.
 * - A setting is configured to a different value: +25; a setting is missing: +20. A
 *   different value on an assigned policy is an active misconfiguration: +10.
 * Impact (how much of the framework it touches):
 * - A directly evidenced control is affected: +15; only supporting controls: +5.
 * - Each affected control: +4, at most +20.
 * Confidence (never raises the priority):
 * - Mixed policy evidence, unknown checks, unknown assignment or incomplete collection add
 *   no points; they add a reason telling the admin to confirm the evidence first.
 *
 * Levels: 70 and above critical, 50 high, 30 medium, below 30 low.
 */
export function rankGap(gap: Pick<Gap, "platform" | "result" | "policies" | "controls" | "mixed" | "unknownChecks">, incompleteCollection: string[] = []): Ranking {
  let score = 0
  const reasons: string[] = []
  if (gap.platform === "tenant") {
    score += 30
    reasons.push("Conditional Access or tenant-wide setting: applies to every sign-in.")
  }
  if (gap.result === "different") {
    score += 25
    reasons.push("A policy sets a different value than the framework expects.")
    if (gap.policies.some((policy) => policy.assignment === "assigned")) {
      score += 10
      reasons.push("The different value is on an assigned policy.")
    }
  } else {
    score += 20
    reasons.push("The expected setting is missing.")
  }
  if (gap.controls.some((control) => control.evidenceStrength === "direct")) {
    score += 15
    reasons.push("Directly evidences at least one framework control.")
  } else if (gap.controls.length) {
    score += 5
    reasons.push("Supports framework controls that also need other evidence.")
  }
  const breadth = Math.min(20, gap.controls.length * 4)
  if (breadth) {
    score += breadth
    reasons.push(`Affects ${gap.controls.length} framework control${gap.controls.length === 1 ? "" : "s"}.`)
  }
  if (gap.mixed) reasons.push("Mixed evidence: an assigned policy matches part of this capability. Review targeting before changing anything.")
  if (gap.unknownChecks) reasons.push(`${gap.unknownChecks} related check${gap.unknownChecks === 1 ? " was" : "s were"} unknown; confirm the evidence first.`)
  if (gap.policies.some((policy) => policy.assignment === "unknown")) reasons.push("Assignment of an affected policy is unknown.")
  if (incompleteCollection.length) reasons.push("Policy collection was incomplete; other evidence may be missing.")
  score = Math.min(100, score)
  const level: Priority = score >= 70 ? "critical" : score >= 50 ? "high" : score >= 30 ? "medium" : "low"
  return { level, score, reasons }
}

/** Sort order of priorities, critical first. */
export function priorityRank(level: Priority): number {
  return PRIORITIES.indexOf(level)
}
