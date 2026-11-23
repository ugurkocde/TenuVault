export type OperationAction = "create" | "update" | "delete"

/** The types available to generic change sets and automatic rollback. */
export const SUPPORTED_OPERATIONS: Readonly<Record<string, readonly OperationAction[]>> = {
  ConfigurationPolicies: ["create", "update", "delete"],
  CompliancePolicies: ["create", "update", "delete"],
  DeviceConfigurations: ["create", "update", "delete"],
  EndpointSecurityIntents: ["create", "update", "delete"],
}

export function supportsAutomaticRollback(folder: string): boolean {
  return Object.hasOwn(SUPPORTED_OPERATIONS, folder)
}

export function manualRollbackNote(name: string): string {
  return `Undo changes to "${name}" in Intune. Automatic rollback is unavailable for this policy type.`
}
