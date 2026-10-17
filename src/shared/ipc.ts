import type { PlanIpcError } from "./plan-errors"
import type { BackupScope } from "./intune/scope"
import type { ReportPayload } from "./oib/report"
import type { PdfBranding } from "./pdf/theme"

/** The saved PDF branding and whether any tenant on this machine is on a plan that applies it. */
export interface PdfBrandingState {
  branding: PdfBranding | null
  available: boolean
}

/** Serialized request forwarded from the renderer `fetch` bridge to the main-process API host. */
export interface ApiRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: Uint8Array
}

export interface ApiResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  /** Raw bytes, so binary downloads such as zip files survive IPC unchanged. */
  body: Uint8Array
}

export interface SignedInAccount {
  tenantId: string
  clientId: string
  username: string
  name?: string
}

/** License state of one tenant on this machine. */
export interface TenantLicenseStatus {
  tenantId: string
  /** An admin is signed in to the tenant in this app. */
  signedIn: boolean
  /** An activation for the tenant is stored on this machine, whether or not its token is still valid. */
  activated: boolean
  /** The tenant may be used: a verified, unexpired entitlement token is bound to it and to this installation. */
  entitled: boolean
  /** Where the entitlement comes from: this machine's key, or the organization license shared with the tenant. */
  source: "key" | "tenant" | null
  /** Community when the tenant uses the free plan (it then has no entitlement token). */
  plan: "community" | "pro" | "msp" | null
  /** Tenants the license covers in total. */
  tenants: number | null
  /** When the cached token expires. The app refreshes it long before, and keeps working offline until then. */
  expiresAt: string | null
  /** When the license key expires, if supplied by the service. Separate from the offline token expiry. */
  validUntil: string | null
  /** Key licenses: whether other admins in the tenant may use it, as last confirmed by the licensing service. */
  shared: boolean | null
  /** Key licenses: sharing could not be confirmed without a fresh sign-in. */
  shareNeedsSignIn: boolean
  /** Organization licenses: the masked key, such as ****ABCDEF. */
  displayKey: string | null
  /** Why the last activation or refresh for this tenant failed. */
  message: string | null
}

export interface LicenseStatus {
  hasKey: boolean
  /** Saved key outcome, separate from tenant coverage and sign-in guidance. */
  keyState: "none" | "pending" | "active" | "failed"
  /** Refusal or verification reason when the saved key has no valid activation. */
  keyMessage: string | null
  /** The last four characters of the key, such as ****ABCD. */
  keyHint: string | null
  /** False when OS encryption is unavailable: the license is kept in memory only. */
  persisted: boolean
  /** The last call to the licensing service did not reach it. */
  offline: boolean
  message: string | null
  /** Plan and tenant allowance of this machine's key, from its latest valid token. */
  plan: "pro" | "msp" | null
  tenantLimit: number | null
  /** Earliest license key expiry among the tenants, or null when none is supplied. */
  validUntil: string | null
  /** The one tenant the free Community plan covers, once a tenant has used it. */
  communityTenantId: string | null
  /** Signed-in tenants and tenants with a stored activation. */
  tenants: TenantLicenseStatus[]
}

export interface SignInRequiredEvent {
  tenantId: string
  clientId: string
  message: string
  /** The resource scope that needs the sign-in. */
  scope: string
}

export interface BackupSettings {
  /** Folder that holds encrypted backups for tenants that store backups on this device. */
  localFolder: string
  /** Non-secret identifier of the current backup encryption key. */
  keyFingerprint: string
  /** The current key fingerprint matches the recorded recovery key export. */
  recoveryExported: boolean
  /** Encrypted backup files exist in the local folder. Null means the scan could not rule them out. */
  hasLocalBackups: boolean | null
}

/** What a tenant backs up. `saved` is false while the tenant uses the default. */
export interface BackupScopeSetting {
  scope: BackupScope
  saved: boolean
}

export interface ScheduleInput {
  tenantId: string
  enabled: boolean
  frequency: "daily" | "weekly"
  /** Local time, "HH:MM". */
  time: string
  /** 0 = Sunday. Required for weekly schedules. */
  weekday?: number
}

export interface BackupSchedule extends ScheduleInput {
  /** When the schedule was last changed; slots before it are not caught up. */
  since: string
  /** The last successful automatic backup. */
  lastRunAt?: string
  /** When the last automatic attempt finished, including failures. */
  lastAttemptAt?: string
  /** Scheduled slot whose attempt budget is recorded, as an ISO timestamp. */
  attemptSlot?: string
  /** Failed attempts in the most recent attempted slot; reset on success. */
  attempts: number
  lastStatus?: "Completed" | "Failed" | "Cancelled"
  lastMessage?: string
  nextRunAt: string | null
}

/** A backup TenuVault did not run because the license did not cover the tenant. */
export interface BackupRefusal {
  at: string
  tenantId: string
  tenantName: string
  /** Started by the tenant's schedule, or by "Back up all tenants now" in the tray. */
  trigger: "scheduled" | "tray"
  /** Why the license check refused the tenant. */
  reason: string
}

/** A backup attempt that failed, kept on this device. One that also left a folder is counted from the folder. */
export interface FailedBackupAttempt {
  at: string
  tenantId: string
  /** The backup job's id, which its folder records as RunId; a unique id when no job ran. */
  runId: string
  trigger: "manual" | "scheduled" | "tray"
  /** Scheduled only: the slot it ran for, as an ISO timestamp. */
  slot?: string
  /** Set when Microsoft or the storage could not be reached. */
  unreachable?: boolean
  /** The first line of the failure, shortened. */
  message: string
}

export interface AppPreferences {
  /** Start TenuVault (hidden, in the tray) when the admin signs in to the computer. */
  startAtLogin: boolean
  /** Keep running in the tray when the window closes, so schedules keep working. */
  keepRunningInTray: boolean
  /** Delete backups older than this many days after each backup. 0 keeps everything. */
  retentionDays: number
  /** Whether the one-time successful backup note has been shown on this machine. */
  firstBackupNoteSeen: boolean
  autoUpdate: boolean
  /** Follow nightly prereleases instead of stable releases. Defaults to on for nightly builds. */
  nightlyUpdates: boolean
  /** ISO timestamp of the last dismissal of the Community notice on this machine. */
  communityBannerDismissedAt?: string
  /** Set when an administrator turned automatic updates off by policy. */
  autoUpdateManaged: boolean
}

export type UpdateStatus =
  | { state: "idle" | "checking" | "not-available" | "disabled" }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string }

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  trayIconLoaded: boolean
  /** Internal CIS Benchmarks access from the server-issued license claim, as derived by the main process. Off when absent. */
  internalCisBenchmarks?: boolean
}

/** API exposed to the renderer on `window.tenuvault` by the preload script. */
export interface TenuVaultBridge {
  api: (request: ApiRequest) => Promise<ApiResponse>
  auth: {
    signIn: (tenant: string, clientId: string) => Promise<SignedInAccount>
    signOut: (tenantId: string) => Promise<void>
    accounts: () => Promise<SignedInAccount[]>
    /** Signs in again to an existing tenant profile, for `scope` (Microsoft Graph when omitted). */
    reauthenticate: (tenantId: string, clientId: string, scope?: string) => Promise<SignedInAccount>
    /** Called when a background request needs the admin to sign in again. Returns an unsubscribe function. */
    onSignInRequired: (listener: (event: SignInRequiredEvent) => void) => () => void
  }
  backups: {
    cancel: (jobId: string) => Promise<void>
    importArchive: () => Promise<{ imported: boolean; tenantId?: string; backupId?: string }>
    settings: () => Promise<BackupSettings>
    /**
     * Why a backup of the tenant to the local folder would fail, such as backups made with a key
     * this device does not have or damaged files; null when it would not. Reads the tenant's
     * backup inventory in the folder, exactly as a backup does.
     */
    inventoryProblem: (tenantId: string) => Promise<string | null>
    /** Lets the admin pick a new folder. Existing backups stay where they are. */
    chooseFolder: () => Promise<BackupSettings>
    openFolder: () => Promise<void>
    /** Saves the recovery key to a file the admin chooses. */
    exportRecoveryKey: () => Promise<{ saved: boolean; path?: string }>
    /** Null when the admin cancels the confirmation. */
    importRecoveryKey: (recoveryKey: string) => Promise<BackupSettings | null>
    /** Throws with an actionable message when the admin cannot write backups to the account. */
    verifyAzureStorage: (tenantId: string, clientId: string, storageAccountName: string) => Promise<void>
    /** What the tenant backs up on schedule and by default. */
    scope: (tenantId: string) => Promise<BackupScopeSetting>
    setScope: (tenantId: string, scope: BackupScope) => Promise<BackupScopeSetting>
    /** The tenant's failed backup attempts, newest first. */
    failedAttempts: (tenantId: string) => Promise<FailedBackupAttempt[]>
    /** Run ids of the tenant's backups still running in this app, manual, scheduled or from the tray. */
    liveRuns: (tenantId: string) => Promise<string[]>
  }
  license: {
    status: () => Promise<LicenseStatus>
    /** Refreshes every cached activation with the licensing service, so a plan or tenant quantity change shows without waiting for the next periodic check. */
    refresh: () => Promise<LicenseStatus>
    /** Saves the key and activates it for every signed-in tenant that is not licensed yet. */
    setKey: (key: string) => Promise<LicenseStatus>
    /** Retries activation for one tenant, or for every signed-in tenant without a license. */
    retry: (tenantId?: string) => Promise<LicenseStatus>
    /** The key holder lets other admins of the tenant use the license, or stops. */
    setShared: (tenantId: string, shared: boolean) => Promise<LicenseStatus>
    /** Releases every activation of this machine and forgets the key. */
    deactivate: () => Promise<LicenseStatus>
    /**
     * Checks the license of a tenant that is being added. When the license does not cover
     * it, the new sign-in is removed and the error says why the tenant was not added.
     */
    checkNewTenant: (tenantId: string) => Promise<LicenseStatus>
    /** Releases the tenant's activation and signs out of it, when the tenant is removed from the app. */
    releaseTenant: (tenantId: string) => Promise<LicenseStatus>
    /** Opens the checkout page (buy) or the customer portal (portal) in the browser. */
    open: (target: "buy" | "portal", options?: { source: string }) => Promise<void>
    /** Called whenever the license state changes in the main process. Returns an unsubscribe function. */
    onChanged: (listener: (status: LicenseStatus) => void) => () => void
  }
  schedules: {
    list: () => Promise<BackupSchedule[]>
    set: (schedule: ScheduleInput) => Promise<BackupSchedule[]>
    remove: (tenantId: string) => Promise<BackupSchedule[]>
    onChanged: (listener: (schedules: BackupSchedule[]) => void) => () => void
    /** Backups refused for the tenant's license, newest first. */
    refusals: (tenantId: string) => Promise<BackupRefusal[]>
    onRefusalsChanged: (listener: () => void) => () => void
  }
  backgroundLaunch: {
    status: () => Promise<{ supported: boolean; installed: boolean }>
    install: () => Promise<{ supported: boolean; installed: boolean }>
    remove: () => Promise<{ supported: boolean; installed: boolean }>
  }
  preferences: {
    get: () => Promise<AppPreferences>
    set: (changes: Partial<AppPreferences>) => Promise<AppPreferences>
  }
  /** Customer branding of every PDF export; it applies to reports of tenants on a plan with pdfBranding. */
  pdfBranding: {
    get: () => Promise<PdfBrandingState>
    /** Rejects with a plan error when no tenant on this machine is on Pro or MSP. */
    set: (branding: PdfBranding) => Promise<PdfBrandingState>
    /** Back to the TenuVault design. */
    clear: () => Promise<PdfBrandingState>
  }
  updates: {
    status: () => Promise<UpdateStatus>
    check: () => Promise<UpdateStatus>
    /** Restarts TenuVault to install a downloaded update. */
    install: () => Promise<void>
    onChanged: (listener: (status: UpdateStatus) => void) => () => void
  }
  storage: {
    /** Synchronous so React state can be hydrated before the first render. */
    getItemSync: (key: string) => string | null
    setItem: (key: string, value: string) => Promise<void>
    removeItem: (key: string) => Promise<void>
  }
  app: {
    info: () => Promise<AppInfo>
    openExternal: (url: string) => Promise<void>
  }
  reports: {
    /** Generates a PDF of an OpenIntuneBaseline report in the main process and asks where to save it. */
    savePdf: (report: ReportPayload, fileName: string) => Promise<{ saved: boolean; path?: string }>
    /** Asks where to save an export and writes it: CSV, JSON or text as UTF-8, a PDF as base64. The extension of `fileName` picks the format. */
    saveFile: (data: string, fileName: string, encoding?: "utf8" | "base64") => Promise<{ saved: boolean; path?: string }>
  }
  disclaimer: {
    /** Records that the admin accepted the current disclaimer for these tenants. */
    accept: (tenantIds: string[]) => Promise<void>
  }
}

/** Plan failures cross the preload boundary as data, then become renderer errors. */
export type TenuVaultPreloadBridge = Omit<TenuVaultBridge, "auth" | "license" | "schedules" | "pdfBranding"> & {
  pdfBranding: Omit<TenuVaultBridge["pdfBranding"], "set"> & {
    set: (branding: PdfBranding) => Promise<PdfBrandingState | PlanIpcError>
  }
  auth: Omit<TenuVaultBridge["auth"], "signIn"> & {
    signIn: (tenant: string, clientId: string) => Promise<SignedInAccount | PlanIpcError>
  }
  license: Omit<TenuVaultBridge["license"], "checkNewTenant"> & {
    checkNewTenant: (tenantId: string) => Promise<LicenseStatus | PlanIpcError>
  }
  schedules: Omit<TenuVaultBridge["schedules"], "set"> & {
    set: (schedule: ScheduleInput) => Promise<BackupSchedule[] | PlanIpcError>
  }
}
