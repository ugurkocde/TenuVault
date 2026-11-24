/**
 * The parts of a service that need their own permissions, and what each sign-in mode needs for them.
 * The services themselves are in ./modules; what to ask Microsoft for is worked out in ./manifest.
 */

/**
 * At least one of these permissions satisfies the requirement. The first is the one TenuVault asks
 * for; the others also satisfy it. ReadWrite always also covers Read.
 */
export type AnyOf = readonly string[]

/** Every group must be satisfied; within a group any one permission does. */
export type Requirement = readonly AnyOf[]

/**
 * How TenuVault reaches Microsoft Graph: as the signed-in admin with delegated permissions, or
 * app-only with application permissions, which only the Backup Reader does.
 */
export type SignInMode = "delegated" | "application"

/** What a sign-in mode needs, or "unsupported" when no permission lets that mode do it. */
export type Need = Requirement | "unsupported"

export type ModeNeeds = Readonly<Record<SignInMode, Need>>

/** Folders of an area that need the same permissions. */
export interface FolderPermissions {
  folders: readonly string[]
  backup: ModeNeeds
  restore: ModeNeeds
  /** Check this part before reading even if the service has no blanket permission check. */
  backupPrecheck?: true
  /** Check this part before restoring even if the service has no blanket permission check. */
  restorePrecheck?: true
  /**
   * The restore permission is declared, so a missing one is named, but setup never asks for it: it
   * reaches far beyond these folders, so an admin who wants to restore them adds it by hand.
   */
  restoreNotRequested?: true
}

/** A part of a service the admin sees as one thing, such as Intune apps or Entra tenant settings. */
export interface PermissionArea {
  /** The key the area is stored under in a tenant's settings; unique within its service. */
  id: string
  label: string
  /** Every folder of the area. */
  folders: readonly string[]
  /** The same folders with what they need; folders listed together need the same permissions. */
  parts: readonly FolderPermissions[]
  /** Delegated reads included with the restore tier for review-only relationships. */
  restoreReview?: Requirement
  /** Off even when its service is on, until the admin turns the area on for the tenant. */
  optIn?: true
  /** The area holds personal data, such as users or group members. */
  personalData?: true
  /**
   * The Backup Reader gets the area's permission only on request, because the application permission
   * shows more than the area needs. Backups with the admin's sign-in always include the area.
   */
  appOnlyOptIn?: true
}

export function area(definition: Omit<PermissionArea, "folders" | "parts">, parts: readonly FolderPermissions[]): PermissionArea {
  return { ...definition, folders: parts.flatMap((part) => part.folders), parts }
}

/**
 * Folders with what they need: `backup` and `restore` as the signed-in admin, `reader` to back them
 * up app-only as the Backup Reader. Nothing is ever restored app-only.
 */
export function part(folders: readonly string[], backup: Requirement, reader: Need, restore: Need, options: Pick<FolderPermissions, "backupPrecheck" | "restorePrecheck" | "restoreNotRequested"> = {}): FolderPermissions {
  return { folders, backup: { delegated: backup, application: reader }, restore: { delegated: restore, application: "unsupported" }, ...options }
}
