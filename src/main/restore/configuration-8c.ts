import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { restoreMatrixRow } from "../../shared/intune/restore-matrix"
import type { Item } from "../../shared/intune/registry"

// Matrix membership also supplies the product's blocked reason. It does not enable capability.
export const isConfiguration8c = (folder: string): boolean => restoreMatrixRow(folder)?.configurationRestore?.phase.startsWith("8c") === true
export const STAGED_8C_OPERATIONS: Readonly<Record<string, readonly ("create" | "update")[]>> = {
  CrossTenantAccessPolicy: ["update"], ExternalIdentitiesPolicy: ["update"],
  UserFlowAttributes: ["create", "update"], AccessPackageCatalogs: ["create", "update"],
  AccessReviewPolicy: ["update"], LifecycleWorkflowSettings: ["update"],
  LifecycleWorkflows: ["update"], DefenderCustomDetectionRules: ["create", "update"],
}
const fields: Record<string, Record<string, string>> = {
  CrossTenantAccessPolicy: { displayName: "string" }, ExternalIdentitiesPolicy: { allowExternalIdentitiesToLeave: "boolean" },
  UserFlowAttributes: { displayName: "string", description: "string", dataType: "string" },
  AccessPackageCatalogs: { displayName: "string", description: "string", state: "string", isExternallyVisible: "boolean" },
  AccessReviewPolicy: { isGroupOwnerManagementEnabled: "boolean" },
  LifecycleWorkflowSettings: { workflowScheduleIntervalInHours: "number" },
  LifecycleWorkflows: { displayName: "string", description: "string", isEnabled: "boolean", isSchedulingEnabled: "boolean" },
  DefenderCustomDetectionRules: { id: "string", displayName: "string", description: "string", status: "string", queryCondition: "object", schedule: "object", detectionAction: "object" },
}
function closed(value: unknown, schema: Record<string, string>): value is Item {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, child]) => Object.hasOwn(schema, key) && child !== null && typeof child === schema[key] && (typeof child !== "number" || Number.isFinite(child)))
}
/** Candidates only. Capability and live evidence gates remain enforced by the production transport. */
export function configuration8cPayload(folder: string, operation: "create" | "update", snapshot: Item): Item {
  const row = restoreMatrixRow(folder), contract = row?.[operation]
  if (!contract || !STAGED_8C_OPERATIONS[folder]?.includes(operation)) throw new RestoreSafetyError(row?.configurationRestore?.blockedReason ?? "No reviewed 8c builder exists.")
  if (folder === "UserFlowAttributes" && snapshot.userFlowAttributeType !== undefined && snapshot.userFlowAttributeType !== "custom") throw new RestoreSafetyError("Built-in attributes are never restored.")
  const body: Item = {}
  for (const [key, value] of Object.entries(snapshot)) {
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
  if (folder === "AccessPackageCatalogs" && (body.state !== "unpublished" || body.isExternallyVisible !== false)) throw new RestoreSafetyError("The staged catalog must remain unpublished and hidden externally.")
  if (folder === "LifecycleWorkflowSettings" && (!Number.isInteger(body.workflowScheduleIntervalInHours) || Number(body.workflowScheduleIntervalInHours) < 1 || Number(body.workflowScheduleIntervalInHours) > 24)) throw new RestoreSafetyError("The workflow schedule interval must be an integer from 1 to 24.")
  if (folder === "LifecycleWorkflows") { body.isEnabled = false; body.isSchedulingEnabled = false }
  if (folder === "DefenderCustomDetectionRules") {
    body.status = "disabled"
    if (body.queryCondition && (!closed(body.queryCondition, { queryText: "string" }) || typeof (body.queryCondition as Item).queryText !== "string")) throw new RestoreSafetyError("Unsupported detection query condition.")
    if (body.schedule && (!closed(body.schedule, { frequency: "string" }) || !["PT1H", "PT3H", "PT12H", "P1D"].includes(String((body.schedule as Item).frequency)))) throw new RestoreSafetyError("Unsupported detection schedule.")
    if (body.detectionAction) {
      const action = body.detectionAction as Item
      if (!closed(action, { alertTemplate: "object" }) || !closed(action.alertTemplate, { title: "string", description: "string", severity: "string", recommendedActions: "string" }) || !["informational", "low", "medium", "high"].includes(String((action.alertTemplate as Item)?.severity))) throw new RestoreSafetyError("Automated response actions and unsupported alert fields require separate verification and activation approval.")
    }
    if (operation === "create" && ["id", "displayName", "queryCondition", "schedule", "detectionAction"].some(key => !body[key])) throw new RestoreSafetyError("Detection creation needs an explicit key, name, query, schedule and alert template.")
  }
  return body
}
