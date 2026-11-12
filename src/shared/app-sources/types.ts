/** Local sources are administrator-selected files, never proof of Intune content equivalence. */
export interface StoredAppSource {
  id: string
  tenantId: string
  fileName: string
  appName: string
  bytes: number
  keyId: string
  sha256: string
  createdAt: string
  provenance: "administrator-selected"
  format: "intunewin"
}

export interface RecoveryDeviceStatus {
  platform: "win32" | "darwin" | "linux"
  enrollment: "matched" | "different-tenant" | "not-enrolled" | "unknown"
  certificate: "matched" | "missing" | "ambiguous" | "access-denied" | "unknown"
  elevated: boolean
  captureAvailable: false
  reason: string
}

export interface AppSourceState {
  storeName: string
  sources: StoredAppSource[]
  warnings: string[]
}

export interface AppSourcesBridge {
  list: (tenantId: string) => Promise<AppSourceState>
  chooseStore: (tenantId: string) => Promise<boolean>
  attach: (tenantId: string, operationId: string, appName: string) => Promise<boolean>
  export: (tenantId: string, operationId: string, sourceId: string) => Promise<boolean>
  cancel: (tenantId: string, operationId: string) => Promise<void>
  deviceStatus: (tenantId: string) => Promise<RecoveryDeviceStatus>
}
