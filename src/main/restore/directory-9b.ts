import type { Item } from "../../shared/intune/registry"
import { MICROSOFT_ORGANIZATION_ID } from "../../shared/intune/entra-directory"
import { RestoreSafetyError, guardRestoreItem, mergeConsentScopes, type RestoreActor } from "../../shared/intune/restore-guards"
import { restoreMatrixRow } from "../../shared/intune/restore-matrix"
import { isGuid } from "../../shared/security"
import { cloudObject, type DirectoryReview } from "./directory-9a"
import type { GuardedStep } from "./guarded-run"
import type { ModuleSetting } from "../services/settings"

export function requireApplicationRestoreAccess(setting: ModuleSetting | undefined) {
  if (!setting?.enabled || setting.access !== "restore" || setting.areas.applications !== true) throw new RestoreSafetyError("Enable Entra ID and the Applications area with Backup and restore access before restoring application metadata.")
}

export const DIRECTORY_9B_FOLDERS = ["Applications", "ServicePrincipals", "OAuth2PermissionGrants"]
export const DIRECTORY_9B_BLOCKER = "This application operation has no verified live restore contract and remains blocked."
export const APP_POLICY_REFERENCES: Record<string, string> = { tokenLifetimePolicies: "TokenLifetimePolicies", claimsMappingPolicies: "ClaimsMappingPolicies", homeRealmDiscoveryPolicies: "HomeRealmDiscoveryPolicies", appManagementPolicies: "AppManagementPolicies", tokenIssuancePolicies: "TokenIssuancePolicies" }
export const appIdentity = (value: unknown): string => {
  if (!isGuid(value)) throw new RestoreSafetyError("An application reference could not be resolved.")
  return value.toLowerCase()
}
export const TENUVAULT_DESKTOP_APP_ID = "d390dc50-d001-4127-859b-828e39bd71e0"
export function restorableApp(item: Item, folder: string, requireOwner = false, protectedAppIds: readonly string[] = []) {
  cloudObject(item)
  const appId = appIdentity(item.appId)
  const ownerTenant = isGuid(item.appOwnerOrganizationId) ? appIdentity(item.appOwnerOrganizationId) : undefined
  if ([TENUVAULT_DESKTOP_APP_ID, ...protectedAppIds].some(id => appIdentity(id) === appId)
    || typeof item.notes === "string" && /^(?:Used by the TenuVault desktop app|TenuVault Backup Reader:)/i.test(item.notes)
    || typeof item.displayName === "string" && /^TenuVault (?:Desktop|Backup Reader)$/i.test(item.displayName)) throw new RestoreSafetyError("TenuVault-owned app registrations are protected.")
  if (folder === "Applications" && (ownerTenant === MICROSOFT_ORGANIZATION_ID || requireOwner && (!ownerTenant || item.servicePrincipalType !== "Application"))) throw new RestoreSafetyError("Microsoft first-party or unresolved app registrations are never restorable.")
  if (folder === "ServicePrincipals" && (ownerTenant === MICROSOFT_ORGANIZATION_ID || item.servicePrincipalType !== "Application" || !ownerTenant)) throw new RestoreSafetyError("Microsoft first-party or unresolved enterprise apps are never restorable.")
}
export function appPayload(folder: string, action: string, source: Item): Item {
  restorableApp(source, folder)
  if (folder === "ServicePrincipals" && action === "create") return { appId: appIdentity(source.appId) }
  if (action === "gallery") return { displayName: String(source.displayName ?? "") }
  if (!["create", "update"].includes(action)) throw new RestoreSafetyError("Unsupported application metadata action.")
  const result: Item = {}
  for (const field of ["displayName", "description"]) if (source[field] !== undefined) {
    if (typeof source[field] !== "string" || !source[field].trim()) continue
    result[field] = source[field]!
  }
  if (action === "create" && !result.displayName) throw new RestoreSafetyError("App creation requires a display name.")
  return result
}
export function applicationAdmission(step: GuardedStep): string | undefined {
  if (step.folder !== "Applications" || step.directory?.action !== "update") {
    // Evidence cannot open another production writer or permission request.
    const reason = restoreMatrixRow(step.folder)?.directoryRestore?.contracts?.find(row => row.action === step.directory?.action)?.blocker
    if (step.directory?.action === "recycle") return "Recycle-bin recovery is blocked until credentials, inherited access and every recovered relationship can be completely verified. Recreation cannot bypass the recycle bin."
    if (step.directory?.action === "consent" && step.desired.consentType === "Principal") return "Principal-specific consent needs a verified typed user mapping. Raw saved principal IDs are never replayed."
    if (step.directory?.action === "policy") return "App policy bindings require a verified layer 8 configuration mapping and a separately admitted binding contract."
    return reason ?? DIRECTORY_9B_BLOCKER
  }
  const contract = restoreMatrixRow(step.folder)?.directoryRestore
  const action = step.directory?.action
  if (contract?.phase !== "enabled" || !action || contract.evidence?.[action]?.result !== "round-trip-matched") return contract?.contracts?.find(row => row.action === action)?.blocker ?? DIRECTORY_9B_BLOCKER
}
export function applicationPermissions(step: GuardedStep): string[] {
  return step.folder === "Applications" && step.directory?.action === "update" && !applicationAdmission(step) ? ["Application.ReadWrite.All"] : []
}
export function applicationReview(step: GuardedStep, current: Item | null, resource: Item, principal: Item | null, actor: RestoreActor): DirectoryReview {
  const action = step.directory!.action
  const approvals = ["directory-item"], notices: string[] = [...(step.directory?.metadataNotices ?? [])]
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
    restorableApp(resource, step.folder === "Applications" ? "Applications" : "ServicePrincipals", true)
    guardRestoreItem(actor, step.folder, step.targetId, { complete: true, principals: person ? [person.id] : [], applications: [String(resource.id ?? ""), String(resource.appId ?? ""), String(step.directory?.clientAppId ?? "")] }, false, ["identity-references"])
  } catch (error) { blocker = (error as Error).message }
  if (step.directory?.unresolved) blocker = step.directory.unresolved
  blocker ??= applicationAdmission(step)
  const desired = action === "consent" ? { ...step.desired, scope: mergeConsentScopes(String(current?.scope ?? ""), String(step.desired.scope)) } : step.desired
  if (action === "update" && !relationship && !Object.entries(desired).some(([key, value]) => JSON.stringify(current?.[key]) !== JSON.stringify(value))) blocker ??= "No nonempty metadata changes are available. Clearing names or descriptions remains blocked."
  if (relationship && current && Object.entries(desired).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value))) blocker = "This relationship already matches. No addition is needed."
  return { principal: person, resource: { id: String(resource.id ?? step.sourceId), name: String(resource.displayName ?? "Unresolved resource"), type: step.folder === "Applications" ? "application" : "servicePrincipal" }, privilege: action === "consent" ? `Delegated scopes: ${desired.scope}` : action === "app-role" ? `App role: ${step.directory?.roleName ?? "Unresolved role"}` : action, scope: `${actor.tenantId}/${action === "consent" ? step.desired.consentType : "application"}/${resource.id ?? step.sourceId}`, approvals, notices, ...(blocker ? { blocker } : {}), roleAssignable: false, changes: Object.entries(desired).filter(([key, value]) => JSON.stringify(current?.[key]) !== JSON.stringify(value)).map(([property, after]) => ({ property, before: current?.[property] ?? null, after })) }
}
