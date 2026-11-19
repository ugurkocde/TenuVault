/** The approved difference is kept in the main process; the renderer receives no privileged token. */
export interface PermissionAdditionPreview {
  id: string
  tenantId: string
  clientId: string
  displayName: string
  declare: string[]
  consent: string[]
  declared: string[]
  consented: string[]
}

export interface PermissionAdditionResult {
  state: "complete" | "partial" | "changed"
  preview: PermissionAdditionPreview
  declared: string[]
  consented: string[]
  missingDeclarations: string[]
  missingConsent: string[]
  message: string
}

export const ADD_PERMISSION_ROLES = "Application Administrator, Cloud Application Administrator, Privileged Role Administrator or Global Administrator"
