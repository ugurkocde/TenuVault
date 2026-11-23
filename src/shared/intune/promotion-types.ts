/** Intune types supported by both Dev to Prod and Copy to Tenants. */
export const PROMOTION_TYPES = [
  { folder: "ConfigurationPolicies", label: "Settings Catalog policies", shortLabel: "Settings Catalog" },
  { folder: "CompliancePolicies", label: "Compliance policies", shortLabel: "Compliance" },
  { folder: "DeviceConfigurations", label: "Device configuration profiles", shortLabel: "Device configuration" },
  { folder: "EndpointSecurityIntents", label: "Endpoint security policies", shortLabel: "Endpoint security" },
  { folder: "GroupPolicyConfigurations", label: "Built-in administrative templates", shortLabel: "Administrative templates" },
  { folder: "PowerShellScripts", label: "Windows PowerShell scripts", shortLabel: "PowerShell scripts" },
  { folder: "ShellScripts", label: "macOS shell scripts", shortLabel: "macOS shell scripts" },
  { folder: "Remediations", label: "Custom remediations", shortLabel: "Remediations" },
  { folder: "FeatureUpdateProfiles", label: "Windows feature update profiles", shortLabel: "Feature updates" },
  { folder: "AssignmentFilters", label: "Assignment filters", shortLabel: "Assignment filters" },
  { folder: "ScopeTags", label: "Custom scope tags", shortLabel: "Scope tags" },
] as const

export const PROMOTION_FOLDERS = PROMOTION_TYPES.map(({ folder }) => folder)
