export const GRAPH_CLI_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
export const TENUVAULT_CLIENT_ID = "61eff188-672b-4be4-acac-2d254a6f9e05"

export const SIGN_IN_METHODS = {
  graphCli: "Start now",
  tenuvaultApp: "TenuVault app",
  ownApp: "Your own app registration",
} as const

export type SignInMethod = keyof typeof SIGN_IN_METHODS

export interface TenantConnection {
  version: 1
  method: SignInMethod
  clientId: string
  origin: "legacy" | "wizard"
  createdAt: string
  updatedAt: string
  /** Keep the tenant's own registration for organization license sharing after a switch. */
  ownClientId?: string
}

export type ConnectionTarget =
  | { method: "graphCli" | "tenuvaultApp" }
  | { method: "ownApp"; clientId: string }

export interface ConnectionSwitchResult {
  connection: TenantConnection
  missing: string[]
}
