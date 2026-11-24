export interface TemporaryGrantScope {
  consentType: "AllPrincipals" | "Principal"
  principalId: string | null
  scope: string
  grantId?: string
}

export interface AppMetadataRemoval {
  runId: string
  status: "active" | "pending" | "verified"
  scopes: TemporaryGrantScope[]
  missingPriorScopes?: TemporaryGrantScope[]
  uncertain?: boolean
  removing?: boolean
}

export const APP_METADATA_REMOVAL_PATH = "Microsoft Entra admin center → Entra ID → Enterprise apps → All applications → TenuVault → Permissions"

export function missingPriorScopeMessages(removal: AppMetadataRemoval): string[] {
  return (removal.missingPriorScopes ?? []).map(({ consentType, principalId, scope }) =>
    `Previously granted ${scope} is now missing from ${consentType === "AllPrincipals" ? "admin consent" : `user consent for user object ID ${principalId}`}. TenuVault left it revoked.`)
}

export function appMetadataRemovalInstructions(removal: AppMetadataRemoval): string {
  const targets = removal.scopes.map(({ consentType, principalId, scope, grantId }) => consentType === "AllPrincipals"
    ? `Admin consent: ${scope}`
    : `User consent for user object ID ${principalId}${grantId ? `, grant ID ${grantId}` : ""}: ${scope}`)
  return [
    `Sign in as an Application Administrator or Cloud Application Administrator. Open ${APP_METADATA_REMOVAL_PATH} and find Microsoft Graph.`,
    ...(removal.uncertain ? ["Check which of these permissions the restore added before revoking anything. The consent result could not be confirmed."] : []),
    ...targets,
    ...(!targets.length ? ["Check the TenuVault app's temporary permissions in Microsoft Entra before retrying."] : []),
    ...missingPriorScopeMessages(removal),
    ...(removal.scopes.some(scope => scope.consentType === "AllPrincipals") ? ["In Admin consent, open the menu for each listed permission and select Revoke permission."] : []),
    ...(removal.scopes.some(scope => scope.consentType === "Principal") ? ["In User consent, locate the grant for the listed user. Use Microsoft Graph to read the grant, then PATCH its scope with the space-separated permissions to keep. DELETE that grant only if no scopes remain. The portal cannot revoke user consent."] : []),
    "Return to TenuVault and select Retry removal to verify the grants.",
  ].join("\n")
}
