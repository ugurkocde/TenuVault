import { backupManifest, incompleteReason, snapshotHash } from "./backup-manifest"
import { dependencyReferences } from "../../../shared/intune/dependencies"
import { assignmentsUnread } from "../../../shared/intune/read"
import { INTUNE_TYPES, itemName, typeForFolder, type Item } from "../../../shared/intune/registry"
import { buildRestorePlan, buildUpdatePlan, restoreBlocker } from "../../../shared/intune/restore-plan"

/**
 * A restore dry run: reads a whole backup back and checks every item without writing to the
 * tenant. This module never calls Microsoft Graph and never creates a change set; it only
 * reads snapshots through the reader it is given and reuses the restore manifest checks and
 * the restore planner, so a passing item is one a real restore could read and rebuild.
 */

export type ValidationCheckId = "read" | "fingerprint" | "payload" | "assignments"

export interface ValidationCheck {
  id: ValidationCheckId
  label: string
  ok: boolean
  detail?: string
}

export interface ItemValidation {
  path: string
  folder: string
  label: string
  name: string
  ok: boolean
  checks: ValidationCheck[]
}

export interface TypeValidation {
  folder: string
  label: string
  total: number
  passed: number
  failed: number
}

export interface BackupValidation {
  backupId: string
  ok: boolean
  manifest: { ok: boolean; detail: string }
  total: number
  passed: number
  failed: number
  byType: TypeValidation[]
  items: ItemValidation[]
}

/** One snapshot read: the parsed snapshot, or why it could not be read or decrypted. */
export type SnapshotRead = { ok: true; snapshot: Item } | { ok: false; error: string }

export interface ValidateBackupInput {
  backupId: string
  /** The parsed metadata.json, or null when the backup holds none. */
  metadata: Record<string, any> | null
  /** Policy files present in backup storage for this backup. */
  listedPaths: string[]
  readSnapshot: (path: string) => Promise<SnapshotRead>
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CHECK_LABEL: Record<ValidationCheckId, string> = {
  read: "Readable and decryptable",
  fingerprint: "Recorded fingerprint",
  payload: "Policy payload",
  assignments: "Assignment references",
}

const check = (id: ValidationCheckId, ok: boolean, detail?: string): ValidationCheck => ({ id, label: CHECK_LABEL[id], ok, ...(detail ? { detail } : {}) })

function assignmentFailure(type: ReturnType<typeof typeForFolder>, snapshot: Item): string | undefined {
  if (!type) return undefined
  if (snapshot.assignments === undefined) return undefined
  if (!Array.isArray(snapshot.assignments)) return "The recorded assignments are not a list."
  if (assignmentsUnread(type, snapshot)) return undefined
  const assignments = snapshot.assignments as Item[]
  for (const [index, assignment] of assignments.entries()) {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return `Assignment ${index + 1} is not an object.`
    const target = assignment.target as Item | undefined
    if (!target || typeof target !== "object" || Array.isArray(target)) return `Assignment ${index + 1} has no target.`
    if (typeof target["@odata.type"] !== "string" || !target["@odata.type"]) return `Assignment ${index + 1} has no target type.`
    if (target.groupId !== undefined && (typeof target.groupId !== "string" || !GUID.test(target.groupId))) return `Assignment ${index + 1} references a group ID that is not valid: ${String(target.groupId)}`
  }
  try {
    const plan = buildRestorePlan(type, snapshot, { includeAssignments: true })
    const empty = plan.assignments.flatMap((step) => dependencyReferences(step.body)).find((reference) => !reference.id)
    if (empty) return `An assignment reference at ${empty.path} has no target ID.`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

export async function validateBackup(input: ValidateBackupInput): Promise<BackupValidation> {
  const { backupId, metadata, listedPaths, readSnapshot } = input
  let manifest: ReturnType<typeof backupManifest> = null
  let manifestError: string | undefined
  try {
    manifest = backupManifest(metadata, backupId)
  } catch (error) {
    manifestError = error instanceof Error ? error.message : "Invalid backup inventory manifest"
  }
  const incomplete = manifestError ?? incompleteReason(metadata, manifest, listedPaths, true)
  const manifestResult = incomplete
    ? { ok: false, detail: incomplete }
    : { ok: true, detail: manifest ? "The backup is complete and every listed file is recorded in its manifest." : "This backup predates recorded manifests; its files were checked as found." }

  const listed = new Set(listedPaths)
  const paths = [...new Set([...listedPaths, ...(manifest ? [...manifest.keys()] : [])])].sort()
  const items: ItemValidation[] = []

  for (const path of paths) {
    const folder = path.split("/")[1] ?? ""
    const type = typeForFolder(folder === "DeviceCompliancePolicies" ? "CompliancePolicies" : folder)
    const fallbackName = (path.split("/")[2] ?? path).replace(/\.json$/, "")
    const entry = manifest?.get(path)
    const checks: ValidationCheck[] = []

    if (manifest && !entry) checks.push(check("fingerprint", false, "This file is not listed in the backup manifest."))
    if (!listed.has(path)) {
      checks.push(check("read", false, "Listed in the backup manifest but the file is missing from backup storage."))
      checks.push(check("fingerprint", false, "Not checked: the file is missing."))
      checks.push(check("payload", false, "Not checked: the file is missing."))
      checks.push(check("assignments", false, "Not checked: the file is missing."))
      items.push({ path, folder: type?.folder ?? folder, label: type?.label ?? folder, name: fallbackName, ok: false, checks })
      continue
    }

    const read = await readSnapshot(path)
    if (!read.ok) {
      checks.push(check("read", false, read.error))
      checks.push(check("fingerprint", false, "Not checked: the file could not be read."))
      checks.push(check("payload", false, "Not checked: the file could not be read."))
      checks.push(check("assignments", false, "Not checked: the file could not be read."))
      items.push({ path, folder: type?.folder ?? folder, label: type?.label ?? folder, name: fallbackName, ok: false, checks })
      continue
    }
    checks.push(check("read", true))
    const snapshot = read.snapshot

    if (!checks.some((entryCheck) => entryCheck.id === "fingerprint")) {
      if (!manifest) checks.push(check("fingerprint", true, "No recorded fingerprint in this backup."))
      else if (entry && (snapshot.id !== entry.id || snapshotHash(snapshot) !== entry.hash)) checks.push(check("fingerprint", false, "This backup file does not match its recorded fingerprint."))
      else checks.push(check("fingerprint", true))
    }

    if (!type) {
      checks.push(check("payload", false, "This backup file is not an Intune type TenuVault can restore."))
      checks.push(check("assignments", false, "Not checked: the policy payload cannot be used."))
    } else {
      // A tenant-wide setting is never created, only replaced in place, so its update is what is checked.
      const singleton = type.restore === "singleton"
      const blocker = singleton ? undefined : restoreBlocker(type, snapshot)
      if (blocker) {
        checks.push(check("payload", false, blocker))
        checks.push(check("assignments", false, "Not checked: the policy payload cannot be restored."))
      } else {
        try {
          if (singleton) buildUpdatePlan(type, snapshot, String(snapshot.id ?? ""), { current: {} })
          else buildRestorePlan(type, snapshot, { includeAssignments: false })
          checks.push(check("payload", true, singleton ? "Tenant-wide setting: restore replaces it in place." : undefined))
        } catch (error) {
          checks.push(check("payload", false, error instanceof Error ? error.message : String(error)))
        }
        if (checks.find((entryCheck) => entryCheck.id === "payload")?.ok) {
          const failure = assignmentFailure(type, snapshot)
          checks.push(failure ? check("assignments", false, failure) : check("assignments", true, snapshot.assignments === undefined ? "No assignments recorded." : undefined))
        } else {
          checks.push(check("assignments", false, "Not checked: the policy payload cannot be restored."))
        }
      }
    }

    const name = type ? itemName(type, snapshot) : fallbackName
    items.push({ path, folder: type?.folder ?? folder, label: type?.label ?? folder, name, ok: checks.every((entryCheck) => entryCheck.ok), checks })
  }

  const order = new Map(INTUNE_TYPES.map((type, index) => [type.folder, index]))
  const groups = new Map<string, TypeValidation>()
  for (const item of items) {
    const group = groups.get(item.folder) ?? { folder: item.folder, label: item.label, total: 0, passed: 0, failed: 0 }
    group.total++
    if (item.ok) group.passed++
    else group.failed++
    groups.set(item.folder, group)
  }
  const byType = [...groups.values()].sort((a, b) => (order.get(a.folder) ?? 999) - (order.get(b.folder) ?? 999) || a.label.localeCompare(b.label))
  const passed = items.filter((item) => item.ok).length
  return {
    backupId,
    ok: manifestResult.ok && passed === items.length,
    manifest: manifestResult,
    total: items.length,
    passed,
    failed: items.length - passed,
    byType,
    items,
  }
}
