/** The Microsoft Graph read scopes shared by scheduled and interactive backups. */
export const READER_REQUIRED_ROLES = [
  "DeviceManagementApps.Read.All",
  "DeviceManagementConfiguration.Read.All",
  "DeviceManagementRBAC.Read.All",
  "DeviceManagementScripts.Read.All",
  "DeviceManagementServiceConfig.Read.All",
] as const

/** Optional: also exposes the managed device inventory, so it is opt-in for the two types that need it. */
export const DEVICE_INVENTORY_ROLE = "DeviceManagementManagedDevices.Read.All"
