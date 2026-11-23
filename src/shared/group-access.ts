export const GROUP_READ_PERMISSION = "GroupMember.Read.All"
export const GROUP_READ_PERMISSIONS = [
  GROUP_READ_PERMISSION, "GroupMember.ReadWrite.All", "Group.Read.All", "Group.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All",
] as const

export const GROUP_CHECK_GUIDANCE = "TenuVault cannot read groups in this tenant, so the groups could not be checked. Add the delegated GroupMember.Read.All permission to the app registration and grant admin consent."
export const GROUP_CHECK_REQUIRED = `${GROUP_CHECK_GUIDANCE} Nothing was changed.`

export const HYGIENE_GROUP_READ_HINT = "Group reads need the delegated GroupMember.Read.All permission. New app registrations get it. For an older one, add it in Entra, grant admin consent, then select Check again in Settings > Services and permissions and rescan."

export const GROUP_SEARCH_LIMIT = 15
export const GROUP_COUNT_LIMIT = 50

export interface TenantGroup {
  id: string
  displayName: string
  kind: "security" | "microsoft365" | "other"
  dynamic: boolean
}

export interface GroupSearchResult {
  readable: boolean
  groups: TenantGroup[]
}

export interface GroupCounts {
  users: number
  devices: number
  groups: number
}
