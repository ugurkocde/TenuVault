export const APPLICATION_REVIEW_FOLDERS = ["Applications", "ServicePrincipals", "OAuth2PermissionGrants"]
export const PRIVILEGED_REVIEW_FOLDERS = ["EntraRoleAssignments", "RoleEligibilitySchedules", "RoleAssignmentSchedules", "PimGroupEligibilitySchedules", "PimGroupAssignmentSchedules", "AdministrativeUnits"]
export const PRIVILEGED_RESTORE_BLOCKER = "Restoring roles and PIM is not available yet. You can review what would change."
export const privilegedRestoreEnabled = typeof __TV_LAB_PRIVILEGED_RESTORE__ !== "undefined" && __TV_LAB_PRIVILEGED_RESTORE__
export const DEFERRED_RESTORE_MESSAGE = "Restore of this item type comes in a later version"

const privilegedFolders = new Set([
  ...APPLICATION_REVIEW_FOLDERS, ...PRIVILEGED_REVIEW_FOLDERS,
  "EntraRoleDefinitions", "RoleManagementPolicies", "PimAlertConfigurations",
].map(folder => folder.toLowerCase()))

export const deferredPrivilegedRestore = (folder: string) => !privilegedRestoreEnabled && privilegedFolders.has(folder.toLowerCase())

export const DIRECTORY_REVIEW_FOLDERS = ["Users", "Groups", ...(privilegedRestoreEnabled ? [...APPLICATION_REVIEW_FOLDERS, ...PRIVILEGED_REVIEW_FOLDERS] : [])]
