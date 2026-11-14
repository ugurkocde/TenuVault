import type { AcknowledgementRequired } from "../disclaimer"

interface SourceDescriptor {
  id: string
  tenantId: string
  fileName: string
  appName: string
  bytes: number
  keyId: string
  sha256: string
  createdAt: string
}

/** Local archives are not captured backups and must never become restore inputs. */
export interface LocalAppArchive extends SourceDescriptor {
  provenance: "administrator-selected"
  format: "intunewin"
}

export interface CaptureIdentity {
  tenantId: string
  appId: string
  appType: "#microsoft.graph.win32LobApp"
  contentVersion: string
  /** SHA-256 of the opaque device service DoFileId, prefixed sha256:. Never a Graph file-ID claim. */
  contentFileId: string
}

export interface CapturedAppSource extends SourceDescriptor {
  provenance: "intune-capture"
  format: "win32-source-zip"
  configurationSha256?: string
  receipt: CaptureIdentity & { schema: 1; encryptedSha256: string; encryptedBytes: number }
}

export type StoredAppSource = LocalAppArchive | CapturedAppSource

export interface RecoveryDeviceStatus {
  platform: "win32" | "darwin" | "linux"
  enrollment: "matched" | "different-tenant" | "not-enrolled" | "unknown"
  certificate: "matched" | "missing" | "ambiguous" | "access-denied" | "unknown"
  elevated: boolean
  /** Metadata-only checks cannot establish content authorization; do not gate Backup on this value. */
  captureAvailable: false
  reason: string
}

export interface AppSourceState {
  storeName: string
  sources: StoredAppSource[]
  warnings: string[]
  unreadableSources?: boolean
}

export interface AppAssignmentCheck {
  appId: string
  checkedAt: string
  status: "device-targeted" | "review" | "unavailable" | "unsupported"
  summary: string
  steps: string[]
  warnings: string[]
  assignments: Array<{
    id: string
    intent: string
    target: string
    match: "included" | "excluded" | "not-member" | "user" | "unknown"
    detail: string
    filter: { name: string; mode: string; rule: string | null } | null
  }>
}

export type AppCapturePhase = "authorizing" | "windows-approval" | "downloading" | "verifying"
export interface AppCaptureProgress { phase: AppCapturePhase; receivedBytes: number; totalBytes: number | null }

export interface AppSourcesBridge {
  deviceSignIn: (tenantId: string) => Promise<AppDeviceCode>
  deviceSignInStatus: (tenantId: string) => Promise<AppDeviceSignInStatus | null>
  cancelDeviceSignIn: (tenantId: string) => Promise<void>
  restoreReview: (tenantId: string, sourceId: string) => Promise<AppRestoreReview>
  loadRestoreSettings: (tenantId: string, sourceId: string) => Promise<AppRestoreReview>
  restore: (tenantId: string, operationId: string, sourceId: string, targetTenantId: string, name: string, settingsHash: string) => Promise<AppRestoreResult | AcknowledgementRequired>
  restoreProgress: (tenantId: string, operationId: string) => Promise<AppRestoreProgress | null>
  assignments: (tenantId: string, appId: string) => Promise<AppAssignmentCheck>
  capture: (tenantId: string, operationId: string, appId: string) => Promise<CapturedAppSource>
  captureProgress: (tenantId: string, operationId: string) => Promise<AppCaptureProgress | null>
  details: (tenantId: string, appId: string) => Promise<IntuneAppDetails>
  printDetails: (tenantId: string, appId: string) => Promise<boolean>
  downloadScript: (tenantId: string, appId: string, scriptId: string) => Promise<boolean>
  apps: (tenantId: string) => Promise<{ apps: IntuneBackupApp[]; fetchedAt: string }>
  list: (tenantId: string) => Promise<AppSourceState>
  chooseStore: (tenantId: string) => Promise<boolean>
  export: (tenantId: string, operationId: string, sourceId: string) => Promise<boolean>
  openFolder: (tenantId: string, sourceId: string) => Promise<void>
  cancel: (tenantId: string, operationId: string) => Promise<void>
  deviceStatus: (tenantId: string) => Promise<RecoveryDeviceStatus>
  signIn: (tenantId: string) => Promise<void>
}

export interface AppDeviceCode { verificationUri: string; userCode: string; expiresAt: string }
export interface AppDeviceSignInStatus { status: "waiting" | "completed" | "failed"; error?: string }

export interface AppRestoreReview {
  settingsHash: string | null
  observedAt: string | null
  currentSettings: boolean
  name: string
  version: string | null
  publisher: string | null
  installCommand: string | null
  uninstallCommand: string | null
  runAs: string | null
  detectionRules: number
  requirementRules: number
  blocker: string | null
}
export interface AppRestoreResult { appId: string; tenantId: string; name: string; contentVersion: string; sourceId: string }
export interface AppRestoreProgress {
  phase: "verifying" | "creating" | "uploading" | "committing" | "publishing" | "completed"
  uploadedBytes: number
  totalBytes: number
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
