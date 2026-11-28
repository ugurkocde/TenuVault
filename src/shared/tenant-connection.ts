import type { SignedInAccount } from "./ipc"

/** Microsoft Graph Command Line Tools client ID, used only by the one-time own-app registration setup helper. */
export const SETUP_HELPER_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
export const TENUVAULT_CLIENT_ID = "61eff188-672b-4be4-acac-2d254a6f9e05"

export const TENUVAULT_APP_UNAVAILABLE = "The TenuVault app is temporarily unavailable."
export const START_NOW_REMOVED_REASON = "Start now was removed in 0.6."
export const OWN_APP_UPGRADE = "Use your own app registration"
export const CONNECTION_WRITE_REFUSED = "CONNECTION_WRITE_REFUSED"

export const ORGANIZATION_RENEWAL_NOTICE = "Ask the license key holder to share the license using the new app registration. Your current license coverage lasts until its existing expiry unless it is renewed sooner."

export const SIGN_IN_METHODS = {
  tenuvaultApp: "TenuVault app",
  ownApp: "Your own app registration",
} as const

export type SignInMethod = keyof typeof SIGN_IN_METHODS

export function isTenuVaultApp(clientId: string | null | undefined): boolean {
  return clientId?.toLowerCase() === TENUVAULT_CLIENT_ID
}

export interface TenantConnection {
  version: 1
  method: SignInMethod | null
  clientId: string
  origin: "legacy" | "wizard"
  createdAt: string
  updatedAt: string
  /** Creation timestamp from the disk profile, which 0.5.x assigns when adding a tenant. */
  profileCreatedAt?: string | null
  /** The explicit Graph scopes verified for the TenuVault app connection. */
  graphScopes?: string[]
  /** Keep the tenant's own registration for organization license sharing after a switch. */
  ownClientId?: string
  /** Detect a 0.5.x sign-in changing token-cache.bin without changing the 0.6 cache. */
  legacyCacheFingerprint?: string | null
  /** Set when a removed 0.6 preview sign-in method requires choosing a replacement method. */
  needsSignInMethod?: true
}

export function connectionNeedsMethod(connection: Pick<TenantConnection, "method" | "needsSignInMethod"> | null | undefined): boolean {
  return Boolean(connection && (connection.needsSignInMethod || connection.method === null))
}

export type ConnectionTarget =
  | { method: "tenuvaultApp" }
  | { method: "ownApp"; clientId: string }

export type BackupCoverageIssue = "permission" | "role" | "license" | "unknown"

/** The selected types and the evidence for their coverage. A null readable list means an unverified grant. */
export interface BackupScopeCoverage {
  service: "entra" | "intune"
  folders: readonly string[]
  readable: readonly string[] | null
  issues?: Readonly<Record<string, BackupCoverageIssue>>
}

export interface ConnectionSwitchResult {
  connection: TenantConnection
  missing: string[]
  coverage?: BackupScopeCoverage[]
}

export type ConnectionSwitchResponse = { result: ConnectionSwitchResult } | { error: { code: string; message: string } }

export type WizardSignInMethod = Exclude<SignInMethod, "ownApp">
export interface WizardSignInResult {
  id: string
  account: SignedInAccount
  organizationName?: string
  verifiedScopes?: string[]
  coverage: BackupScopeCoverage[]
  missing?: string[]
}
export type WizardSignInResponse = { result: WizardSignInResult } | { error: { code: string; message: string } }
export type WizardFinishResponse = { result: true } | { error: { code: string; message: string } }
