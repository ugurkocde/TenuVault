const stableFolders = [
  "DeviceRegistrationPolicy", "MdmEnrollmentPolicies", "MamEnrollmentPolicies",
  "AuthenticationMethodsPolicy", "AuthenticationContexts", "TermsOfUseAgreements",
  "Groups", "GroupLifecyclePolicies", "OwnerlessGroupPolicy", "EntraDevices",
]

const stableEntraFolders = new Set(stableFolders.map(folder => folder.toLowerCase()))
export const expandedEntraScope = typeof __TV_LAB_EXPANDED_ENTRA__ !== "undefined" && __TV_LAB_EXPANDED_ENTRA__
  ? "expanded-entra-lab-scope"
  : undefined

export const includesEntraFolder = (folder: string) => Boolean(expandedEntraScope) || stableEntraFolders.has(folder.toLowerCase())
