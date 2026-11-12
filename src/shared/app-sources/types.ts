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
  unreadableSources?: boolean
}

export interface AppSourcesBridge {
  details: (tenantId: string, appId: string) => Promise<IntuneAppDetails>
  printDetails: (tenantId: string, appId: string) => Promise<boolean>
  downloadScript: (tenantId: string, appId: string, scriptId: string) => Promise<boolean>
  apps: (tenantId: string) => Promise<{ apps: IntuneBackupApp[]; fetchedAt: string }>
  list: (tenantId: string) => Promise<AppSourceState>
  chooseStore: (tenantId: string) => Promise<boolean>
  attach: (tenantId: string, operationId: string, appName: string) => Promise<boolean>
  export: (tenantId: string, operationId: string, sourceId: string) => Promise<boolean>
  cancel: (tenantId: string, operationId: string) => Promise<void>
  deviceStatus: (tenantId: string) => Promise<RecoveryDeviceStatus>
  signIn: (tenantId: string) => Promise<void>
}

export interface IntuneBackupApp {
  id: string
  name: string
  publisher: string
  version?: string | null
  icon?: string | null
  modifiedAt?: string | null
  installContext?: string | null
  assigned?: boolean | null
}
export interface IntuneAppScript {
  id: string
  name: string
  kind: "install" | "uninstall" | "detection" | "requirement"
  content: string | null
  signatureCheck: boolean | null
  runAs32Bit: boolean | null
}
export interface IntuneAppAssignment {
  intent: string
  target: string
  groupId: string | null
  filterId: string | null
  filterType: string | null
}
export interface IntuneAppDetails extends IntuneBackupApp {
  description: string
  createdAt: string | null
  fileName: string | null
  packageBytes: number | null
  installCommand: string | null
  uninstallCommand: string | null
  restartBehavior: string | null
  maxRunTimeMinutes: number | null
  scripts: IntuneAppScript[]
  scriptWarning: string | null
  assignments: IntuneAppAssignment[] | null
  assignmentWarning: string | null
  rules: Array<{ type: string; purpose: string; properties: Record<string, string | number | boolean | null> }>
}
