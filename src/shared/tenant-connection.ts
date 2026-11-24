import type { SignedInAccount } from "./ipc"

export const GRAPH_CLI_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
export const TENUVAULT_CLIENT_ID = "61eff188-672b-4be4-acac-2d254a6f9e05"

export const GRAPH_CLI_CONSENT_WARNING = "If Microsoft asks you to approve permissions, cancel and choose another sign-in method."
export const GRAPH_CLI_UNAVAILABLE = "Start now is not available in this tenant."
export const GRAPH_CLI_DISABLED = "Start now sign-in is currently unavailable."
export const GRAPH_CLI_UPGRADE = "Upgrade to the TenuVault app"
export const OWN_APP_UPGRADE = "Use your own app registration"
export const GRAPH_CLI_NEXT_STEP = "Choose the TenuVault app or use your own app registration in Sign-in and access."
export const CONNECTION_WRITE_REFUSED = "CONNECTION_WRITE_REFUSED"
export const GRAPH_CLI_READ_ONLY = `Start now is read-only. ${GRAPH_CLI_NEXT_STEP}`

export const ORGANIZATION_RENEWAL_NOTICE = "Ask the license key holder to share the license using the new app registration. Your current license coverage lasts until its existing expiry unless it is renewed sooner."

export const SIGN_IN_METHODS = {
  graphCli: "Start now",
  tenuvaultApp: "TenuVault app",
  ownApp: "Your own app registration",
} as const

export type SignInMethod = keyof typeof SIGN_IN_METHODS

export function sharedSignInMethod(clientId: string | null): "graphCli" | "tenuvaultApp" | undefined {
  const id = clientId?.toLowerCase()
  if (id === GRAPH_CLI_CLIENT_ID) return "graphCli"
  if (id === TENUVAULT_CLIENT_ID) return "tenuvaultApp"
}

export interface TenantConnection {
  version: 1
  method: SignInMethod
  clientId: string
  origin: "legacy" | "wizard"
  createdAt: string
  updatedAt: string
  /** Creation timestamp from the disk profile, which 0.5.x assigns when adding a tenant. */
  profileCreatedAt?: string | null
  /** The explicit Graph scopes verified for the shared connection. */
  graphScopes?: string[]
  /** Keep the tenant's own registration for organization license sharing after a switch. */
  ownClientId?: string
  /** Detect a 0.5.x sign-in changing token-cache.bin without changing the 0.6 cache. */
  legacyCacheFingerprint?: string | null
}

export type ConnectionTarget =
  | { method: "graphCli" }
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
