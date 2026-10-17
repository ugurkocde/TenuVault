import type {
  CapabilityStatus,
  ControlStatus,
  FrameworkAssessment,
} from "./types";

export function frameworkCoverageLabel(
  assessment: FrameworkAssessment,
): string | undefined {
  if (assessment.framework.id === "essential-eight") {
    const mapped = assessment.controls.filter(
      (row) => row.capabilityIds.length || row.excludedCapabilityIds.length,
    ).length;
    return `${assessment.framework.totalRequirements} published requirement entries; showing ${mapped} with Intune or Conditional Access policy checks. Operational-only requirements are excluded. Target level only; achieved maturity is not assessed.`;
  }
  const total = assessment.framework.totalRequirements;
  if (total === undefined) return undefined;
  return `${assessment.summary.totalControls} of ${total} published requirements have Intune evidence mappings. Supporting evidence only; this is not a full assessment or compliance score.`;
}

export const CONTROL_STATUS_LABELS: Record<ControlStatus, string> = {
  evidenceFound: "Configuration evidence",
  partialEvidence: "Supporting or partial evidence",
  noEvidence: "No recognized evidence",
  notApplicable: "Outside selected scope",
  notAssessed: "Not assessed",
  conflictingEvidence: "Mixed policy evidence",
};

export const CAPABILITY_STATUS_LABELS: Record<CapabilityStatus, string> = {
  enforced: "Setting configured and assigned",
  requirementAssigned: "Compliance requirement assigned",
  configuredNotAssigned: "Configured, not assigned",
  disabledByPolicy: "Non-enforcing setting detected",
  noEvidence: "No recognized evidence",
  assignmentUnknown: "Assignment unknown",
  conflictingEvidence: "Mixed policy evidence",
  partialConfiguration: "Some required settings missing",
  collectionIncomplete: "Collection incomplete",
  notApplicable: "Outside selected scope",
};

export const CONTROL_STATUS_ORDER: Record<ControlStatus, number> = {
  conflictingEvidence: 0,
  notAssessed: 1,
  noEvidence: 2,
  partialEvidence: 3,
  evidenceFound: 4,
  notApplicable: 5,
};

export const CONTROL_STATUS_COLORS: Record<
  ControlStatus,
  [number, number, number]
> = {
  evidenceFound: [31, 133, 83],
  partialEvidence: [196, 113, 31],
  noEvidence: [100, 116, 139],
  notApplicable: [100, 116, 139],
  notAssessed: [196, 113, 31],
  conflictingEvidence: [185, 28, 28],
};

export const CAPABILITY_STATUS_COLORS: Record<
  CapabilityStatus,
  [number, number, number]
> = {
  enforced: [31, 133, 83],
  requirementAssigned: [37, 99, 235],
  configuredNotAssigned: [196, 113, 31],
  disabledByPolicy: [185, 28, 28],
  noEvidence: [100, 116, 139],
  assignmentUnknown: [196, 113, 31],
  conflictingEvidence: [185, 28, 28],
  partialConfiguration: [196, 113, 31],
  collectionIncomplete: [196, 113, 31],
  notApplicable: [100, 116, 139],
};

/** Setting-level comparison outcomes, as counted by comparisonCounts. */
export const CHECK_RESULT_LABELS = {
  matches: "Matches",
  different: "Different",
  missing: "Missing",
  // The Governance score views call the same outcome Unknown; one term everywhere.
  unableToCheck: "Unknown",
  outsideScope: "Outside scope",
} as const;

export const CHECK_RESULT_COLORS: Record<keyof typeof CHECK_RESULT_LABELS, [number, number, number]> = {
  matches: [31, 133, 83],
  different: [196, 113, 31],
  missing: [201, 75, 48],
  unableToCheck: [100, 116, 139],
  outsideScope: [100, 116, 139],
};

export const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  ios: "iOS / iPadOS",
  android: "Android",
  tenant: "Conditional Access",
};

export const COLLECTION_FAMILY_LABELS: Record<string, string> = {
  settingsCatalog: "Settings catalog",
  deviceConfigurations: "Device configuration profiles",
  administrativeTemplates: "Administrative templates",
  compliancePolicies: "Compliance policies",
  securityBaselines: "Security baselines",
  appProtectionPolicies: "App protection policies",
  windowsUpdatePolicies: "Windows update profiles",
  conditionalAccessPolicies: "Conditional Access policies",
  scripts: "Scripts",
  appConfigurations: "App configuration policies",
  enrollmentConfigurations: "Enrollment configurations",
};

export const COLLECTION_STATUS_LABELS: Record<string, string> = {
  complete: "Complete",
  incomplete: "Incomplete",
  unknown: "Unknown",
  notCollected: "Not collected",
};

/** A stable, locale independent timestamp for reports, e.g. 2026-09-30 14:05 UTC. */
export function formatReportDate(value: string | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
