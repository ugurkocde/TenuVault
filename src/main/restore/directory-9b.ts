import type { Item } from "../../shared/intune/registry"
import { MICROSOFT_ORGANIZATION_ID } from "../../shared/intune/entra-directory"
import { RestoreSafetyError, guardRestoreItem, mergeConsentScopes, type RestoreActor } from "../../shared/intune/restore-guards"
import { restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { isGuid } from "../../shared/security"
import { cloudObject, type DirectoryReview } from "./directory-9a"
import type { GuardedStep } from "./guarded-run"

export const DIRECTORY_9B_FOLDERS = ["Applications", "ServicePrincipals", "OAuth2PermissionGrants"]
export const DIRECTORY_9B_BLOCKER = "Application restore is staged. Phase 2 live lifecycle, delegated safety and cleanup evidence are required."
export const APP_POLICY_REFERENCES: Record<string, string> = { tokenLifetimePolicies: "TokenLifetimePolicies", claimsMappingPolicies: "ClaimsMappingPolicies", homeRealmDiscoveryPolicies: "HomeRealmDiscoveryPolicies", appManagementPolicies: "AppManagementPolicies", tokenIssuancePolicies: "TokenIssuancePolicies" }
export const appIdentity = (value: unknown): string => {
  if (!isGuid(value)) throw new RestoreSafetyError("An application reference could not be resolved.")
  return value.toLowerCase()
}
export function restorableApp(item: Item, folder: string) {
  cloudObject(item)
  if (folder === "ServicePrincipals" && (item.appOwnerOrganizationId === MICROSOFT_ORGANIZATION_ID || item.servicePrincipalType !== "Application" || !isGuid(item.appOwnerOrganizationId))) throw new RestoreSafetyError("Microsoft first-party or unresolved enterprise apps are never restorable.")
}
export function appPayload(folder: string, action: string, source: Item): Item {
  restorableApp(source, folder)
  if (folder === "ServicePrincipals" && action === "create") return { appId: appIdentity(source.appId) }
  if (action === "gallery") return { displayName: String(source.displayName ?? "") }
  if (!["create", "update"].includes(action)) throw new RestoreSafetyError("Unsupported application metadata action.")
  const result: Item = {}
  for (const field of ["displayName", "description"]) if (source[field] !== undefined) {
    if (typeof source[field] !== "string" && source[field] !== null) throw new RestoreSafetyError("Unsupported application metadata.")
    result[field] = source[field]!
  }
  if (action === "create" && !result.displayName) throw new RestoreSafetyError("App creation requires a display name.")
  return result
}
export function applicationAdmission(step: GuardedStep): string | undefined {
  const contract = restoreMatrixRow(step.folder)?.directoryRestore
  const action = step.directory?.action
  // Recycle recovery can revive credentials and access without individual approvals.
  if (action === "recycle") return "Recycle-bin recovery is blocked until credentials, inherited access and every recovered relationship can be completely verified. Recreation cannot bypass the recycle bin."
  if (action === "policy") return "App policy bindings require a verified layer 8 configuration mapping and a separately admitted binding contract."
  if (contract?.phase !== "enabled" || !action || contract.evidence?.[action]?.result !== "round-trip-matched") return contract?.contracts?.find(row => row.action === action)?.blocker ?? DIRECTORY_9B_BLOCKER
}
export function applicationPermissions(step: GuardedStep): string[] {
  if (step.directory?.action === "consent") return ["DelegatedPermissionGrant.ReadWrite.All"]
  if (step.directory?.action === "app-role") return ["AppRoleAssignment.ReadWrite.All", "Application.Read.All"]
  if (step.directory?.action === "owner") return ["Application.ReadWrite.All", "Directory.Read.All"]
  if (step.folder === "Applications" && step.directory?.action === "create") return ["AppRegistration.Create"]
  return ["Application.ReadWrite.All"]
}
export function applicationReview(step: GuardedStep, current: Item | null, resource: Item, principal: Item | null, actor: RestoreActor): DirectoryReview {
  const action = step.directory!.action
  const approvals = ["directory-item"], notices: string[] = []
  const person = principal && typeof principal.displayName === "string" && typeof principal["@odata.type"] === "string" ? { id: appIdentity(principal.id), name: principal.displayName, type: String(principal["@odata.type"]).replace("#microsoft.graph.", "") } : null
  const relationship = ["owner", "consent", "app-role"].includes(action)
  const privileged = action === "owner" || (action === "consent" && step.desired.consentType === "AllPrincipals") || action === "app-role"
  if (privileged) approvals.push("privileged-relationship")
  if (relationship && (!current || action === "owner" && current.present !== true || action === "consent" && current.scope !== step.desired.scope)) { approvals.push("security-response"); notices.push("The current state looks deliberate. Restoring removed access may undo a security response.") }
  if (step.folder === "Applications" && action === "create") notices.push("Recreation gets a new app ID. This breaks every client that uses the old app ID. Use recycle-bin recovery to preserve it where possible; that recovery remains blocked until completely verified.")
  if (step.folder === "ServicePrincipals") notices.push("SAML signing keys, provisioning secrets and all credentials are never restored. Set up single sign-on and provisioning again.")
  if (action === "recycle") notices.push("The recycle bin preserves the object ID and app ID, but can recover credentials and previous access. It is offered for review only and remains blocked.")
  let blocker: string | undefined
  if (relationship && !person) blocker = "The principal no longer resolves to a current name and type. This item is blocked."
  try {
    if (action !== "app-role") restorableApp(resource, step.folder === "Applications" ? "Applications" : "ServicePrincipals")
    guardRestoreItem(actor, step.folder, step.targetId, { complete: true, principals: person ? [person.id] : [], applications: [String(resource.id ?? ""), String(resource.appId ?? ""), String(step.directory?.clientAppId ?? "")] }, false, ["identity-references"])
  } catch (error) { blocker = (error as Error).message }
  if (step.directory?.unresolved) blocker = step.directory.unresolved
  blocker ??= applicationAdmission(step)
  const desired = action === "consent" ? { ...step.desired, scope: mergeConsentScopes(String(current?.scope ?? ""), String(step.desired.scope)) } : step.desired
  if (relationship && current && Object.entries(desired).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value))) blocker = "This relationship already matches. No addition is needed."
  return { principal: person, resource: { id: String(resource.id ?? step.sourceId), name: String(resource.displayName ?? "Unresolved resource"), type: step.folder === "Applications" ? "application" : "servicePrincipal" }, privilege: action === "consent" ? `Delegated scopes: ${desired.scope}` : action === "app-role" ? `App role: ${step.directory?.roleName ?? "Unresolved role"}` : action, scope: `${actor.tenantId}/${action === "consent" ? step.desired.consentType : "application"}/${resource.id ?? step.sourceId}`, approvals, notices, blocker, roleAssignable: false, changes: Object.entries(desired).filter(([key, value]) => JSON.stringify(current?.[key]) !== JSON.stringify(value)).map(([property, after]) => ({ property, before: current?.[property] ?? null, after })) }
}
