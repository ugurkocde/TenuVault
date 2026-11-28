import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { restoreMatrixRow } from "../../shared/intune/restore-matrix"
import type { Item } from "../../shared/intune/registry"

// Matrix membership also supplies the product's blocked reason. It does not enable capability.
export const isConfiguration8c = (folder: string): boolean => restoreMatrixRow(folder)?.configurationRestore?.phase.startsWith("8c") === true
export const STAGED_8C_OPERATIONS: Readonly<Record<string, readonly ("create" | "update")[]>> = {
  CrossTenantAccessPolicy: ["update"], ExternalIdentitiesPolicy: ["update"],
  UserFlowAttributes: ["create", "update"], AccessPackageCatalogs: ["create", "update"],
  AccessReviewPolicy: ["update"], LifecycleWorkflowSettings: ["update"],
  LifecycleWorkflows: ["update"],
}
const fields: Record<string, Record<string, string>> = {
  CrossTenantAccessPolicy: { displayName: "string" }, ExternalIdentitiesPolicy: { allowExternalIdentitiesToLeave: "boolean" },
  UserFlowAttributes: { displayName: "string", description: "string", dataType: "string" },
  AccessPackageCatalogs: { displayName: "string", description: "string", state: "string", isExternallyVisible: "boolean" },
  AccessReviewPolicy: { isGroupOwnerManagementEnabled: "boolean" },
  LifecycleWorkflowSettings: { workflowScheduleIntervalInHours: "number" },
  LifecycleWorkflows: { displayName: "string", description: "string", isEnabled: "boolean", isSchedulingEnabled: "boolean" },
}
function closed(value: unknown, schema: Record<string, string>): value is Item {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, child]) => Object.hasOwn(schema, key) && child !== null && typeof child === schema[key] && (typeof child !== "number" || Number.isFinite(child)))
}
/** Closed subsets. Capability and live evidence gates remain enforced by the production transport. */
export function configuration8cPayload(folder: string, operation: "create" | "update", snapshot: Item): Item {
  const row = restoreMatrixRow(folder), contract = row?.[operation]
  if (!contract || !STAGED_8C_OPERATIONS[folder]?.includes(operation)) throw new RestoreSafetyError(row?.configurationRestore?.blockedReason ?? "No reviewed 8c builder exists.")
  if (folder === "UserFlowAttributes" && snapshot.userFlowAttributeType !== undefined && snapshot.userFlowAttributeType !== "custom") throw new RestoreSafetyError("Built-in attributes are never restored.")
  const body: Item = {}
  for (const [key, value] of Object.entries(snapshot)) {
    // Full backups retain these known read fields, but confirmation permits only the contract subset.
    if (folder === "AccessReviewPolicy" && ["displayName", "description"].includes(key)) continue
    if (folder === "CrossTenantAccessPolicy" && key === "allowedCloudEndpoints" && Array.isArray(value) && value.every(endpoint => typeof endpoint === "string")) continue
    if (folder === "AccessPackageCatalogs" && ["uniqueName", "serviceManagementReference"].includes(key)) {
      if (value !== null) throw new RestoreSafetyError(`Catalog ${key} is configured and needs a reviewed request builder.`)
      continue
    }
    if (folder === "AccessPackageCatalogs" && ((key === "privilegeLevel" && value === "standard") ||
        (key === "dynamicPermissionSettings" && closed(value, { isDetectionAndRemediationEnabled: "boolean", isRequestAndAssignmentEnabled: "boolean" }) &&
          value.isDetectionAndRemediationEnabled === false && value.isRequestAndAssignmentEnabled === false))) continue
    if (folder === "AccessPackageCatalogs" && key === "catalogType" && value !== "userManaged") throw new RestoreSafetyError("Only user-managed catalog backups can be restored.")
    if (folder === "AccessPackageCatalogs" && ((key === "catalogType" && value === "userManaged") || (key === "resources" && Array.isArray(value) && value.length === 0))) continue
    if (folder === "UserFlowAttributes" && (key === "userFlowAttributeType" || (operation === "update" && ["displayName", "dataType"].includes(key)))) continue
    if (["@odata.type", "@odata.context", "@odata.etag", "createdDateTime", "modifiedDateTime"].includes(key) || (key === "id" && !contract.properties.includes(key))) continue
    if (!contract.properties.includes(key)) throw new RestoreSafetyError(`The ${folder} property ${key} needs a reviewed request builder.`)
    body[key] = structuredClone(value)
  }
  if (!Object.keys(body).length || !closed(body, fields[folder]!)) throw new RestoreSafetyError("Invalid or empty closed configuration payload.")
  if (folder === "UserFlowAttributes") {
    if (operation === "create" && (typeof body.displayName !== "string" || !["string", "boolean", "int64"].includes(String(body.dataType)))) throw new RestoreSafetyError("Custom attribute creation needs a display name and supported data type.")
    if (snapshot.userFlowAttributeType !== undefined && snapshot.userFlowAttributeType !== "custom") throw new RestoreSafetyError("Built-in attributes are never restored.")
  }
  if (folder === "AccessPackageCatalogs" && (body.state !== "unpublished" || body.isExternallyVisible !== false)) throw new RestoreSafetyError("The catalog must remain unpublished and hidden externally.")
  if (folder === "LifecycleWorkflowSettings" && (!Number.isInteger(body.workflowScheduleIntervalInHours) || Number(body.workflowScheduleIntervalInHours) < 1 || Number(body.workflowScheduleIntervalInHours) > 24)) throw new RestoreSafetyError("The workflow schedule interval must be an integer from 1 to 24.")
  if (folder === "LifecycleWorkflows") { body.isEnabled = false; body.isSchedulingEnabled = false }
  return body
}
