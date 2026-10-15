import type { Item } from "../intune/registry"

export const OIB_REPO = "SkipToTheEndpoint/OpenIntuneBaseline"
export const OIB_LICENSE = "GPL-3.0 · SkipToTheEndpoint and contributors"

export type OibPlatform = "windows" | "macos" | "win365" | "byod" | "ios" | "android"

/** The release channels the releases.json manifest publishes: tested, early-access and unversioned. */
export type OibChannel = "stable" | "beta" | "unstable"

/** Whether a platform has a usable baseline or is still being built upstream. */
export type OibPlatformStatus = "available" | "in-development"

/**
 * A platform release listed in the releases.json manifest, pinned to the commit its tag or branch
 * pointed to when the manifest was read. Beta releases live on their own branch and have no tag.
 */
export interface OibPublishedRelease {
  platform: OibPlatform
  /** Upstream version, e.g. "4.0". */
  version: string
  /** Optional edition name, e.g. "26H2 Edition". */
  name?: string
  channel: OibChannel
  /** Beta and unstable releases are prereleases, only offered by default when prereleases are allowed. */
  prerelease: boolean
  releaseDate: string
  /** The branch the release lives on ("main" for stable releases cut from main). */
  branch: string
  /** The published tag, or the branch name for beta releases without one. Loads are keyed by it. */
  tag: string
  /** The commit the tag or branch pointed to when the manifest was read. */
  commit: string
  /** The upstream page for the release. */
  url?: string
}

/** A platform the manifest lists, with its development status and changelog path. */
export interface OibPlatformInfo {
  platform: OibPlatform
  status: OibPlatformStatus
  /** Repository path of the platform changelog, when published. */
  changelog?: string
}

/** The OpenIntuneBaseline versions a session can use: manifest releases and the current main commit. */
export interface OibVersions {
  main: { commit: string; committedAt?: string }
  /** Every platform the manifest lists, with its status. */
  platforms: OibPlatformInfo[]
  /** Newest first. */
  releases: OibPublishedRelease[]
  /** Set when GitHub could not be reached and the versions known from an earlier session are shown. */
  warning?: string
}

/** The version used for a platform: a manifest release (`tag` is its tag or beta branch), or main. */
export interface OibSelection {
  commit: string
  tag?: string
}

export const OIB_PLATFORMS: Record<OibPlatform, { label: string; root: string; description: string }> = {
  windows: { label: "Windows", root: "WINDOWS/", description: "Windows 11 devices deployed by Autopilot" },
  macos: { label: "macOS", root: "MACOS/", description: "Apple macOS devices deployed by ABM" },
  win365: { label: "Windows 365", root: "WINDOWS365/", description: "Cloud PCs" },
  byod: { label: "BYOD", root: "BYOD/", description: "App protection policies" },
  ios: { label: "iOS", root: "IOS/", description: "Fully managed iOS devices" },
  android: { label: "Android", root: "ANDROID/", description: "Android Enterprise devices" },
}

/** Maps releases.json platform ids to TenuVault's internal platform ids (win365 is "windows365" upstream). */
export const OIB_MANIFEST_IDS: Record<string, OibPlatform> = {
  windows: "windows",
  windows365: "win365",
  macos: "macos",
  ios: "ios",
  android: "android",
  byod: "byod",
}

export interface OibReplacement {
  oibId: string
  name: string
}

/** One policy of an OIB pack, without its content (the main process keeps the content). */
export interface OibPolicy {
  /** Repository path; identifies the policy within a loaded pack. */
  source: string
  name: string
  /** Registry folder the policy is created in. */
  folder: string
  /** Manifest policy type, or one derived from the path for packs without a manifest. */
  policyType: string
  oibId?: string
  previousVersions: string[]
  replacements: OibReplacement[]
  skuRequirements: string
  licenseRequirements: string
  status: string
  scope?: string
}

export interface OibDeprecated {
  oibId: string
  name: string
  replacements: OibReplacement[]
}

export interface OibCatalog {
  platform: OibPlatform
  commit: string
  /** The published release tag the pack was loaded as; absent for main. */
  tag?: string
  version?: string
  reference: string
  source: string
  license: string
  /** Whether a PolicyManifest.json was found; without it matching falls back to names. */
  manifest: boolean
  policies: OibPolicy[]
  deprecated: OibDeprecated[]
}

export interface TenantPolicy {
  id: string
  name: string
  folder: string
  oibId?: string
}

export type MatchStatus = "missing" | "current" | "outdated" | "newer" | "duplicate"

export interface PolicyMatch {
  source: string
  status: MatchStatus
  method?: "oibid" | "name"
  tenant?: TenantPolicy
  /** Every tenant policy that matched when the match is ambiguous. */
  matches?: TenantPolicy[]
  /** Other tenant copies of this policy next to the matched one: older OIB versions, or same or unknown version copies. */
  legacy: TenantPolicy[]
  tenantVersion?: string
  oibVersion?: string
}

export interface DeprecatedMatch {
  oibId: string
  name: string
  tenant: TenantPolicy
  replacements: Array<OibReplacement & { deployed: boolean }>
}

export interface OibComparison {
  tenantId: string
  platform: OibPlatform
  commit: string
  reference: string
  comparedAt: string
  tenantPolicyCount: number
  matches: PolicyMatch[]
  deprecated: DeprecatedMatch[]
}

export interface SettingDiff {
  settingDefinitionId: string
  label: string
  path?: string
  oibValue?: string
  tenantValue?: string
}

export interface ValidationResult {
  totalOib: number
  totalTenant: number
  matched: number
  /** Root setting counts, independent of the bounded leaf-difference lists. */
  different?: number
  missing?: number
  extra?: number
  mismatches: SettingDiff[]
  oibOnly: SettingDiff[]
  tenantOnly: SettingDiff[]
  compliant: boolean
}

export interface PolicyValidation {
  source: string
  name: string
  folder: string
  tenantPolicyId: string
  tenantPolicyName: string
  status: "compliant" | "drifted" | "unsupported" | "error"
  /** Expected root settings, retained even when the live policy cannot be read. */
  expectedSettings?: number
  error?: string
  result?: ValidationResult
}

export interface ValidationRun {
  runId: string
  tenantId: string
  platform: OibPlatform
  commit: string
  reference: string
  validatedAt: string
  /** Increment when the comparison/counting semantics change. Older runs have no version. */
  validationVersion?: 1
  results: PolicyValidation[]
}

export interface DeployItem {
  source: string
  mode: "create" | "update"
  /** The tenant policy an update replaces. */
  targetId?: string
}

export interface RunObject {
  folder: string
  id: string
  name: string
  warnings?: string[]
  partial?: boolean
}

export interface UpdatedObject extends RunObject {
  /** The name before the update. */
  previousName: string
  /** The object as it was before the update, read like a backup; kept so undo can put it back. */
  before?: Item
}

export interface OibRun {
  runId: string
  tenantId: string
  createdAt: string
  kind: "deploy" | "fix"
  platform: OibPlatform
  reference: string
  /** The exact OIB commit deployed; absent on Quick Start runs whose release commit is unknown. */
  commit?: string
  /** Set on runs migrated from the earlier Quick Start, which only created policies. */
  legacy?: "quickstart"
  /** The backup taken or reused before the run; set for backup modes new and reuse. */
  backupFolder?: string
  /** Absent on runs recorded before the backup choice existed (those backed up when backupFolder is set). */
  backupMode?: OibBackupMode
  pilotGroupId?: string
  created: RunObject[]
  updated: UpdatedObject[]
  failed: { name: string; error: string }[]
  skipped?: { name: string; reason: string }[]
}

export interface UndoResult {
  run: OibRun | null
  results: { name: string; id: string; action: "removed" | "restored"; done: boolean; error?: string }[]
}

/** What a deployment or Fix drift does before it writes: back up now, reuse a recent backup, or skip. */
export type OibBackupMode = "new" | "reuse" | "none"

/** The `backup` field of oib-deploy and oib-fix; a boolean (true = new, false = none) is still accepted. */
export type OibBackupChoice = { mode: "new" } | { mode: "reuse"; folder: string } | { mode: "none" }

/** A backup can be reused for this many minutes after it completed. */
export const OIB_BACKUP_REUSE_MINUTES = 24 * 60

/** The tenant's newest backup, as oib-backup-options reports it for the folders a run writes. */
export interface OibRecentBackup {
  folder: string
  /** ISO time the backup finished. */
  completedAt: string
  ageMinutes: number
  /** Status Success, no failures, and every requested folder collected. */
  complete: boolean
  /** Labels of requested types the backup does not hold (left out of scope, skipped or failed). */
  missing: string[]
  /** Why the backup is not complete, in words; absent when complete. */
  reason?: string
}

export interface OibBackupOptions {
  recent: OibRecentBackup | null
}

/** oib-progress: what a running deployment, fix, undo or validation is doing; null when nothing runs. */
export interface OibProgress {
  stage: string
  done: number
  total: number
  kind: "deploy" | "fix" | "undo" | "validate"
  startedAt: string
  /** Backup job progress 0 to 100, while the pre-change backup runs. */
  percent?: number
  backupJobId?: string
}
