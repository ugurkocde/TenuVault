import type { ConnectionHealthReport, HealthCause, HealthChange, ReaderHealthState, SignInHealthState, VerifiedHealth } from "../../shared/connection-health/model"
import { knownPermissions } from "../../shared/services/manifest"
import { MODULE_BY_ID } from "../../shared/services/modules"

export const healthDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })

/** A state gives the observed problem, its impact and the next step, without guessing a diagnosis. */
export const SIGN_IN_HEALTH_TEXT: Record<SignInHealthState, string> = {
  healthy: "Connected. Token permissions are available; a backup verifies what can be read.",
  notChecked: "Not checked yet. Backup access is not known. Select Check again.",
  local: "Backups stay on this computer. No storage sign-in is needed.",
  unknown: "Microsoft refused the check for an unknown reason. Backups may need attention. Check the code and sign-in logs, then check again.",
  signInNeeded: "Sign-in needed. Backups using this sign-in may stop. Sign in again.",
  mfaRequired: "Microsoft requires MFA or another challenge. Backups using this sign-in may stop. Sign in again and complete the prompt.",
  blockedByConditionalAccess: "Conditional Access blocked this sign-in. Backups using it may stop. Ask your administrator to check the sign-in logs for the policy and use a device and location it allows.",
  consentMissing: "Permission or admin consent is missing. Backups using this sign-in may stop. Ask an administrator to check API permissions and grant consent, then check again.",
  registrationNotFoundInTenant: "App registration not found in this tenant. Backups using it may stop. It may have been removed, belong to another tenant, or lack consent here. Check the tenant, client ID and consent with your administrator.",
  registrationMisconfigured: "The app registration is not configured for this sign-in. Backups using it may stop. Check its public client and localhost redirect settings with your administrator.",
  applicationDisabled: "The enterprise application is disabled. Backups using it may stop. Ask your administrator to allow sign-in to that enterprise application.",
  servicePrincipalMissing: "The enterprise application is missing from this tenant. Backups using it may stop. Ask your administrator to check the tenant and provision or consent to the application.",
  notAssigned: "Your account is not assigned to the application. Backups using your sign-in may stop. Ask your administrator to assign your account or group.",
  accountDisabled: "Your account is disabled. Backups using your sign-in may stop. Contact your administrator.",
  accountLockedOrBlocked: "Your account is locked or Microsoft blocked the sign-in address. Backups using your sign-in may stop. Ask your administrator to check the sign-in logs; this code does not distinguish the two causes.",
  wrongTenantOrAccount: "The tenant or account does not match. Backups using this sign-in may stop. Check the tenant and sign in with an admin account of that tenant.",
  throttled: "Microsoft asked TenuVault to slow down. The check could not finish. Wait a few minutes, then check again.",
  unreachable: "Microsoft did not answer the check. Current access is not known. Check your connection, then check again.",
}

/** A storage token does not prove the account can write blobs in the selected storage account. */
export const STORAGE_HEALTH_TEXT: Record<SignInHealthState, string> = {
  healthy: "Storage token acquired. This does not verify write access to your storage account. Run a backup to prove files can be written.",
  local: "Backups stay on this computer. No storage token is needed. A backup proves files can be written to the selected folder.",
  notChecked: "Storage token not checked yet. Write access is not known. Select Check again, then run a backup to prove files can be written.",
  unknown: "Microsoft refused the storage token check for an unknown reason. Backups may be unable to write files. Check the code and sign-in logs in storage settings, then check again.",
  signInNeeded: "Storage sign-in needed. Backups may be unable to write files. Sign in again in storage settings, then run a backup to verify writes.",
  mfaRequired: "Microsoft requires MFA or another challenge for the storage token. Backups may be unable to write files. Sign in again in storage settings and complete the prompt.",
  blockedByConditionalAccess: "Conditional Access blocked the storage token. Backups may be unable to write files. Ask your administrator to check the sign-in logs and use a device and location the policy allows.",
  consentMissing: "Permission or admin consent for the storage token is missing. Backups may be unable to write files. Ask your administrator to check Azure Storage delegated permissions and consent, then check again.",
  registrationNotFoundInTenant: "App registration not found in this tenant during the storage token check. Backups may be unable to write files. Check the tenant, client ID and consent in storage settings.",
  registrationMisconfigured: "The app registration is not configured for the storage sign-in. Backups may be unable to write files. Ask your administrator to check public client and localhost redirect settings.",
  applicationDisabled: "The enterprise application is disabled for the storage sign-in. Backups may be unable to write files. Ask your administrator to allow sign-in to that enterprise application.",
  servicePrincipalMissing: "The enterprise application is missing for the storage sign-in. Backups may be unable to write files. Ask your administrator to check the tenant and provision or consent to the application.",
  notAssigned: "Your account is not assigned to the storage sign-in application. Backups may be unable to write files. Ask your administrator to assign your account or group.",
  accountDisabled: "Your account is disabled for the storage sign-in. Backups may be unable to write files. Contact your administrator.",
  accountLockedOrBlocked: "Your account is locked or Microsoft blocked the storage sign-in address. Backups may be unable to write files. Ask your administrator to check the sign-in logs; this code does not distinguish the causes.",
  wrongTenantOrAccount: "The tenant or account for the storage token does not match. Backups may be unable to write files. Check the tenant and sign in again in storage settings.",
  throttled: "Microsoft asked TenuVault to slow down the storage token check. Write access is not known. Wait a few minutes, then check again.",
  unreachable: "Microsoft did not answer the storage token check. Write access is not known. Check your connection, then check again.",
}

export const READER_HEALTH_TEXT: Record<ReaderHealthState, string> = {
  healthy: "Connected. The Backup Reader is available for scheduled backups.",
  notSetUp: "Not set up. Scheduled backups use your sign-in. Set up the optional Backup Reader in Background backups if needed.",
  pending: "Waiting for verification. Scheduled backups use your sign-in. Finish setup and verify in Background backups.",
  certificateExpiring: "The certificate expires soon. Renew and verify it in Background backups before it expires to keep the Backup Reader available.",
  certificateExpired: "The certificate expired. The Backup Reader cannot run scheduled backups; they fall back to your sign-in. Renew and verify it in Background backups.",
  rolesChanged: "The Backup Reader's permissions changed. Scheduled backups use only what its verified permissions still cover. Ask your administrator to confirm the change, then verify again in Background backups.",
  refused: "The Backup Reader was refused. Scheduled backups using it may fail. Check the code with your administrator and verify again in Background backups.",
  throttled: "Microsoft asked the Backup Reader to slow down. Scheduled backups may be delayed. Wait a few minutes, then check again.",
  unreachable: "Microsoft did not answer the Backup Reader check. Current access for scheduled backups is not known. Check the connection and try again.",
}

export const HEALTH_CAUSE_TEXT: Record<HealthCause, string> = {
  permission: "A required permission is missing. Add it and grant admin consent, then check again and run a backup.",
  notVerifiedYet: "Permissions present, not verified yet. Run a backup to verify the read with the new permissions.",
  refusedWithPermission: "Microsoft refused the read although the permission is present. For your sign-in this may be your admin role or a license; TenuVault cannot tell which. Ask your administrator to check, then run a backup.",
  role: "Microsoft reported a missing admin role. Ask your administrator to check the role for this sign-in, then run a backup.",
  license: "Microsoft reported a license or a service that is not onboarded. Ask your administrator to check the license and service setup, then run a backup.",
  signedIn: "This type needs a signed-in admin. Run a manual backup with your sign-in.",
  reader: "The Backup Reader leaves this type out by design. Nothing needs fixing; a manual backup uses your sign-in.",
  notRead: "The last backup could not read this type. Check its backup result for the error, then try again.",
}

export function verificationText(verified: VerifiedHealth): string {
  const who = verified.mode === "app-only" ? "the Backup Reader" : "your sign-in"
  const date = verified.at ? ` on ${healthDate(verified.at)}` : ""
  if (verified.state === "verified") return `Verified by the last backup${date} with ${who}.`
  if (verified.state === "noBackup") return "Not verified by a recent backup. Run a backup to verify access."
  return `The backup${date} with ${who} could not read: ${verified.notVerified.join(", ")}.`
}

export function changeText(change: HealthChange, since: string | null): string {
  const date = since ? healthDate(since) : "the previous check"
  const service = "service" in change ? MODULE_BY_ID.get(change.service) : undefined
  const label = service ? `${service.label}${"area" in change && change.area ? ` / ${service.areas.find(a => a.id === change.area)?.label ?? change.area}` : ""}` : ""
  let text: string
  switch (change.kind) {
    case "permissionsAdded": text = `Added since ${date}: ${change.permissions.join(", ")}.`; break
    case "permissionsRemoved": text = `Removed since ${date}: ${change.permissions.join(", ")}.`; break
    case "registrationReplaced": return `App registration replaced. Previous client ID: ${change.previousClientId}. ${change.lacks.length ? `The replacement lacks: ${change.lacks.join(", ")}.` : "No missing permission compared with the previous registration was reported."}`
    case "becameReady": text = `Permissions arrived for ${label} since ${date}. A backup still needs to verify access.`; break
    case "lostAccess": return `${label}: ${change.mode === "app-only" ? "the Backup Reader" : "your sign-in"} lost access to ${change.folders.join(", ")} since ${healthDate(change.since)}. ${HEALTH_CAUSE_TEXT[change.cause]}`
  }
  return "earlierSignIn" in change && change.earlierSignIn ? `${text} Found under an earlier sign-in${change.foundAt ? ` on ${healthDate(change.foundAt)}` : ""}; this is not a check of your current account.` : text
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Exact manifest permission names from the report; resolve their IDs from Microsoft's service principal in the CLI. */
export function permissionRemediation(report: Pick<ConnectionHealthReport, "tenantId" | "clientId">, missing: readonly string[]) {
  const known = new Set(knownPermissions("delegated")[0]!.permissions)
  const names = [...new Set(missing)].filter(name => known.has(name))
  // The CLI replaces Graph grants, including individual grants. Preserve tenant-wide scopes,
  // and stop for administrator review when individual grants would be removed or broadened.
  const commands = [
    "(",
    "set -euo pipefail",
    `az login --tenant ${quote(report.tenantId)} --allow-no-subscriptions || exit 1`,
    'signedInTenant=$(az account show --query tenantId -o tsv) || exit 1',
    `[ "$(printf '%s' "$signedInTenant" | tr '[:upper:]' '[:lower:]')" = ${quote(report.tenantId.toLowerCase())} ] || { echo "Wrong tenant. No permissions changed." >&2; exit 1; }`,
    'graphId=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv) || exit 1',
    '[ -n "$graphId" ] || exit 1',
    `individualGrants=$(az ad app permission list-grants --id ${quote(report.clientId)} --query "[?resourceId=='$graphId' && consentType=='Principal'] | length(@)" -o tsv) || exit 1`,
    '[ "$individualGrants" = "0" ] || { echo "Individual Graph consent exists. Ask your administrator to merge the missing scopes without replacing individual grants." >&2; exit 1; }',
    `existingScopes=$(az ad app permission list-grants --id ${quote(report.clientId)} --query "[?resourceId=='$graphId' && consentType=='AllPrincipals'].scope" -o tsv) || exit 1`,
    ...names.map(name => `permissionId=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query "oauth2PermissionScopes[?value=='${name}'].id | [0]" -o tsv) || exit 1\n[ -n "$permissionId" ] || exit 1\naz ad app permission add --id ${quote(report.clientId)} --api 00000003-0000-0000-c000-000000000000 --api-permissions "$permissionId=Scope" || exit 1`),
    `scopes=$(printf '%s\\n' "$existingScopes" ${quote(names.join(" "))} | tr ' \\t' '\\n' | LC_ALL=C sort -u | sed '/^$/d' | paste -sd ' ' -)`,
    `az ad app permission grant --id ${quote(report.clientId)} --api 00000003-0000-0000-c000-000000000000 --consent-type AllPrincipals --scope "$scopes" || exit 1`,
    ")",
  ].join("\n")
  const request = `Please add exactly these delegated Microsoft Graph permissions to TenuVault's app registration ${report.clientId} in tenant ${report.tenantId}: ${names.join(", ")}. Grant tenant-wide delegated consent for these scopes only, preserving existing consent. Do not consent other pending permissions. The Azure CLI route merges existing tenant-wide Graph scopes and stops if individual grants exist, so they can be preserved separately. Then I will select Check again in Services and permissions and run a backup to verify access.`
  return { names, commands, request }
}
