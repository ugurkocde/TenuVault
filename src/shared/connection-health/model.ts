/**
 * Connection health: what TenuVault observed about a tenant's connection, and what it concludes.
 *
 * A connection is a tenant, an app registration (client ID) and a sign-in mode: the signed-in admin
 * with delegated permissions, or the Backup Reader with application permissions. Observations are
 * kept per connection, so a tenant whose services use more than one registration stays possible.
 *
 * An observation is something Microsoft said at a known time: the answer to a token request made
 * for the check, or how a backup run ended for each type. Nothing here is a token, a secret, a
 * name or a message: only permission names, error classes and codes, folder names and times.
 */

import type { ModuleId, AccessLevel } from "../services/modules"
import type { SignInErrorClass, SignInErrorState } from "../sign-in-errors"

export type ConnectionMode = "delegated" | "app-only"

/**
 * The class of a failed token request, as the sign-in boundary reports it. The classes of the error
 * table for a code Microsoft gave, and for a failure without a known code:
 * - session: no sign-in is stored, its session is gone, or Microsoft asks for interaction.
 * - throttled: Microsoft answered with HTTP 429.
 * - unreachable: the request got no answer.
 * - readerCheck: Microsoft issued a token, but it did not pass the Backup Reader's own checks.
 * - unknown: anything else; the code, when there is one, is kept.
 */
export type FailureClass = SignInErrorClass | "unreachable" | "readerCheck" | "unknown"

export interface SignInFailure {
  class: FailureClass
  /** Microsoft's error code, such as AADSTS50076, when it gave one. */
  code?: string
}

/** What a token request made for a check was answered with. Never the result of a cached token. */
export interface TokenObservation {
  /** When the check ran. */
  at: string
  /** The permissions in the token Microsoft issued: scopes of an admin, roles of the Backup Reader. */
  permissions?: string[]
  failure?: SignInFailure
}

/** Why a read was refused, as far as the run could tell. */
export type RefusalCause = "permission" | "role" | "license"

/** How a backup run ended for the types it selected. Types the scope or a service that is off left out are not in it. */
export interface RunObservation {
  runId: string
  /** When the run ended. */
  at: string
  trigger: "manual" | "scheduled" | "tray"
  status: string
  /** The account that ran it; absent for the Backup Reader. */
  account?: string
  /** Folders the run read: saved, or found not configured. */
  read: string[]
  /** Folders Microsoft refused to the run. */
  refused: Array<{ folder: string; cause: RefusalCause; status?: number; code?: string }>
  /** Folders the run could not read for another reason, such as a failed request. It says nothing about access. */
  unread: string[]
  /** Folders left out by design: the Backup Reader does not read them, or only a signed-in admin can. It says nothing about access. */
  excluded: Array<{ folder: string; cause: "reader" | "signedIn" }>
}

/** What this device knows about the tenant's Backup Reader. Never its certificate or key. */
export interface ReaderObservation {
  /** When the facts were read. */
  at: string
  state: "pending" | "verified"
  /** Expiry of the certificate in use. */
  notAfter: string
  verifiedAt: string | null
  verifiedRoles: string[] | null
  /** How the roles of the reader's last token differed from the verified ones. */
  roleChange: { added: string[]; removed: string[]; at: string } | null
}

/**
 * What was known when the changes were last looked at. Changes are reported against it. A value
 * that was not known then is filled in the first time it is, without counting as a change.
 */
export interface Snapshot {
  /** When the state last agreed with this snapshot. */
  at: string
  /** The account the permissions were seen for. */
  account?: string
  permissions?: string[]
  /** Per "service/area": whether its backup permissions were present. */
  ready?: Record<string, boolean>
  /** The "service/area" keys that had lost access. */
  lost?: string[]
  /** The registration this one took the tenant over from, with the permissions that one had. */
  replaces?: { clientId: string; permissions?: string[] }
}

/** A run that refused a folder its connection had read before. */
export interface FolderRefusal {
  runId: string
  /** When that run ended. */
  at: string
  cause: RefusalCause
}

/** The refusals kept per folder: the first since its last read, which says since when, and the latest, which says why. */
export const MAX_FOLDER_REFUSALS = 2

export interface ConnectionRecord {
  clientId: string
  mode: ConnectionMode
  /** Whose sign-in the observations below are; absent for the Backup Reader. */
  account?: string
  graph?: TokenObservation
  storage?: TokenObservation
  reader?: ReaderObservation
  /** The last runs, oldest first. */
  runs: RunObservation[]
  /** Per folder: when a run of this connection and account last read it. */
  verified: Record<string, string>
  /**
   * Per folder: the runs that refused it since that read, each once and oldest first. Kept per
   * folder and apart from `runs`, so backups that leave a folder out never push out the evidence
   * that access to it was lost.
   */
  refused: Record<string, FolderRefusal[]>
  snapshot?: Snapshot
  /** When the record last took an observation, by this device's clock. */
  updatedAt: string
}

/** How long a token answer says something about the sign-in. */
export const TOKEN_MAX_AGE_MS = 7 * 86_400_000
/** How long a backup run says something about access. */
export const RUN_MAX_AGE_MS = 90 * 86_400_000
/** From how many days before its expiry a Backup Reader certificate counts as expiring, as its reminders do. */
export const CERTIFICATE_EXPIRING_DAYS = 30

/** The state of a sign-in: the signed-in admin for Microsoft Graph or for Azure Storage. */
export type SignInHealthState =
  | "healthy"
  /** No answer recent enough to say anything. */
  | "notChecked"
  /** Backups stay on this device, so there is no storage sign-in. */
  | "local"
  /** Microsoft refused with a code TenuVault has no meaning for; the code is given. */
  | "unknown"
  | Exclude<SignInErrorState, "refused">

export type ReaderHealthState =
  | "notSetUp"
  /** A certificate was created and waits for its first verification. */
  | "pending"
  | "healthy"
  | "certificateExpiring"
  /** By the certificate's own date. No answer of Microsoft leads here. */
  | "certificateExpired"
  /** The reader's permissions changed since the verification; it waits to be verified again. */
  | "rolesChanged"
  /** Microsoft, or TenuVault's own checks, refused the reader. */
  | "refused"
  | "throttled"
  | "unreachable"

export interface SignInHealth {
  state: SignInHealthState
  /** When the answer behind the state was given; null when there is none. */
  checkedAt: string | null
  class?: FailureClass
  code?: string
  /** Microsoft's description of the code. */
  link?: string
}

export interface ReaderHealth {
  state: ReaderHealthState
  /** When Microsoft last answered a token request of the reader, for a check or for a verification that came after a refused check; null when it never did. */
  checkedAt: string | null
  class?: FailureClass
  code?: string
  link?: string
  notAfter?: string
  /** Whole days until the certificate expires; zero or less once it has. */
  daysLeft?: number
  roleChange?: { added: string[]; removed: string[]; at: string }
}

/** Whether the token carries the permissions; unknown without a recent token. */
export type PermissionState = "present" | "missing" | "unknown"

/**
 * Why access to a type was lost: the cause the refused runs found with the token they had
 * (license also covers a product never set up), or notVerifiedYet: a run of the admin lacked a
 * permission that the admin's token carries now, so that cause is gone, and whether the read works
 * shows when a backup reads the type. The token of today never turns a cause into another one.
 */
export type LossCause = RefusalCause | "notVerifiedYet"

/**
 * Why the last backup did not read a type:
 * - permission, role, license, notVerifiedYet: Microsoft refused the read (see LossCause).
 * - signedIn: only a signed-in admin can read it, and only the Backup Reader ran.
 * - reader: only the Backup Reader ran, and it leaves the type out by design. Nothing was asked of
 *   Microsoft and nothing is to fix.
 * - notRead: the read failed for another reason.
 */
export type HealthCause = LossCause | "signedIn" | "reader" | "notRead"

export interface VerifiedHealth {
  /**
   * verified: the last backup read every type it selected; partly: some of them; notVerified: none;
   * noBackup: no recent backup selected a type of it.
   */
  state: "verified" | "partly" | "notVerified" | "noBackup"
  /** When the latest backup behind the state ended. */
  at?: string
  cause?: HealthCause
  /** Whose backup the cause comes from. */
  mode?: ConnectionMode
  /** The folders the last backup did not read. */
  notVerified: string[]
}

export interface AreaHealth {
  id: string
  label: string
  optIn: boolean
  personalData: boolean
  /** The service is on, and so is the area when it is opt-in. */
  enabled: boolean
  /** Whether the signed-in admin's token carries what backing the area up needs. */
  permissions: PermissionState
  /** The same for restoring it. */
  restore: PermissionState
  /** The Microsoft Graph permissions to add for the service's access level. */
  missing: string[]
  verified: VerifiedHealth
  /** A type that was read before was refused by two backups since. */
  lostAccess: boolean
}

export interface ServiceHealth {
  id: ModuleId
  label: string
  enabled: boolean
  access: AccessLevel
  /** Whether this version backs up any type of the service. */
  hasTypes: boolean
  /** Over the areas that are on. */
  permissions: PermissionState
  /** The Microsoft Graph permissions to add for what is turned on, at the service's access level. */
  missing: string[]
  verified: VerifiedHealth
  areas: AreaHealth[]
}

export type HealthChange =
  | { kind: "permissionsAdded"; permissions: string[] }
  | { kind: "permissionsRemoved"; permissions: string[] }
  /** The tenant is connected with another app registration than before. `lacks` is what the earlier one had and this one does not. */
  | { kind: "registrationReplaced"; previousClientId: string; lacks: string[] }
  /** The backup permissions of a service (every area that is on), or of one area, arrived. */
  | { kind: "becameReady"; service: ModuleId; area?: string }
  /** `cause` and `mode` are those of the connection that lost access: what its own refusals found, and whose sign-in it is. */
  | { kind: "lostAccess"; service: ModuleId; area: string; cause: LossCause; mode: ConnectionMode; folders: string[]; since: string }

export interface ConnectionHealthReport {
  tenantId: string
  /** The app registration the tenant is connected with. */
  clientId: string
  evaluatedAt: string
  graph: SignInHealth
  reader: ReaderHealth
  storage: SignInHealth
  services: ServiceHealth[]
  /** What changed since `since`. Empty for the first snapshot. */
  changes: HealthChange[]
  /** When the state last agreed with what the changes are compared to; null before the first snapshot. */
  since: string | null
  /** The permissions in the signed-in admin's last token; null without a recent one. */
  granted: string[] | null
}
