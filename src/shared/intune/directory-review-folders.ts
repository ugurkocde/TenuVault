export const APPLICATION_REVIEW_FOLDERS = ["Applications", "ServicePrincipals", "OAuth2PermissionGrants"]
export const PRIVILEGED_REVIEW_FOLDERS = ["EntraRoleAssignments", "RoleEligibilitySchedules", "RoleAssignmentSchedules", "PimGroupEligibilitySchedules", "PimGroupAssignmentSchedules", "AdministrativeUnits"]
export const PRIVILEGED_RESTORE_BLOCKER = "Restoring roles and PIM is not available yet. You can review what would change."
export const DIRECTORY_REVIEW_FOLDERS = ["Users", "Groups", ...APPLICATION_REVIEW_FOLDERS, ...PRIVILEGED_REVIEW_FOLDERS]
