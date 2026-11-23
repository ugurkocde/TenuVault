export const APPLICATION_REVIEW_FOLDERS = ["Applications", "ServicePrincipals", "OAuth2PermissionGrants"]
export const PRIVILEGED_REVIEW_FOLDERS = ["EntraRoleAssignments", "RoleEligibilitySchedules", "RoleAssignmentSchedules", "PimGroupEligibilitySchedules", "PimGroupAssignmentSchedules", "AdministrativeUnits"]
export const DIRECTORY_REVIEW_FOLDERS = ["Users", "Groups", ...APPLICATION_REVIEW_FOLDERS, ...PRIVILEGED_REVIEW_FOLDERS]
