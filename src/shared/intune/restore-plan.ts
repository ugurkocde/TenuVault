import { cleanAssignment, COMMON_READ_ONLY, itemName, type IntuneType, type Item, type Json, type Step } from "./registry"
import { isGraphId } from "../security"

/**
 * Turns a backed-up snapshot into the Graph requests that recreate it.
 *
 * Pure, so restore, tests and the lab verification CLI build the same requests. Step paths and
 * body `@odata.bind` references may contain `{id}`, the ID Graph returns for the created object.
 */

export interface RestorePlan {
  create: { method: "POST"; path: string; body: Item }
  /** Requests that complete the object, such as ADMX values or targeted apps. */
  steps: Step[]
  /** Requests that restore assignments; empty unless requested. */
  assignments: Step[]
}

export interface PlanOptions {
  /** Prepended to the name so a copy is recognisable, for example "[Restored]". */
  prefix?: string
  includeAssignments?: boolean
}

export class NotRestorableError extends Error {}

/** Why a snapshot cannot be recreated, or undefined when it can. */
export function restoreBlocker(type: IntuneType, snapshot: Item): string | undefined {
  if (type.restore === "metadata") return type.limitation ?? "This type is backed up for reference only."
  return type.restorable?.(snapshot)
}

const MAC_PASSWORD_RESET = "Macs that get this policy make every local account, including LAPS and Platform SSO accounts, set a new password at the next sign-in. Tell those users before you restore it."
const WINDOWS_PASSWORD_RESET = "Windows devices that get this policy can make local accounts, such as a local administrator, set a new password at the next sign-in, even when the current one meets the rules. Tell those users before you restore it."
const PASSWORD_REQUIRED: Record<string, string> = {
  "#microsoft.graph.macOSCompliancePolicy": MAC_PASSWORD_RESET,
  "#microsoft.graph.macOSGeneralDeviceConfiguration": MAC_PASSWORD_RESET,
  "#microsoft.graph.windows10CompliancePolicy": WINDOWS_PASSWORD_RESET,
  "#microsoft.graph.windows10GeneralConfiguration": WINDOWS_PASSWORD_RESET,
}
/** Settings catalog choices that force a password change: macOS Change At Next Auth = True, and Windows DeviceLock DevicePasswordEnabled = Enabled (0). */
const PASSWORD_RESET_CHOICES: Record<string, string> = {
  "com.apple.mobiledevice.passwordpolicy_changeatnextauth_true": MAC_PASSWORD_RESET,
  "device_vendor_msft_policy_config_devicelock_devicepasswordenabled_0": WINDOWS_PASSWORD_RESET,
}

/**
 * Why writing this snapshot to devices makes users set a new local password, or undefined. macOS compliance and
 * device restrictions password settings expire existing passwords; on Windows, a changed password requirement
 * prompts local accounts even when their password complies.
 */
export function passwordResetWarning(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined
  const item = snapshot as Item
  const type = item["@odata.type"]
  if (typeof type === "string" && Object.hasOwn(PASSWORD_REQUIRED, type)) return item.passwordRequired === true ? PASSWORD_REQUIRED[type] : undefined
  if (!Array.isArray(item.settings)) return undefined
  const pending: Json[] = [item.settings]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === "string" && Object.hasOwn(PASSWORD_RESET_CHOICES, value)) return PASSWORD_RESET_CHOICES[value]
    if (value && typeof value === "object") pending.push(...Object.values(value))
  }
  return undefined
}

/** Separate creation from replacement; defaults can only be updated in place. */
export function restoreCapabilities(type: IntuneType, snapshot: Item, current: Item = snapshot): { blocker?: string; replaceBlocker?: string } {
  let blocker = restoreBlocker(type, snapshot)
  let replaceBlocker: string | undefined
  if (!blocker) {
    try { buildRestorePlan(type, snapshot) } catch (error) { blocker = error instanceof Error ? error.message : String(error) }
  }
  try {
    if (typeof snapshot.id !== "string" || !snapshot.id) throw new Error("The snapshot has no original object ID.")
    buildUpdatePlan(type, snapshot, snapshot.id, { current })
  } catch (error) { replaceBlocker = error instanceof Error ? error.message : String(error) }
  return { blocker, replaceBlocker }
}

export function buildRestorePlan(type: IntuneType, snapshot: Item, options: PlanOptions = {}): RestorePlan {
  const blocker = restoreBlocker(type, snapshot)
  if (blocker) throw new NotRestorableError(blocker)

  const payload = cleanPayload(type, snapshot)
  if (options.prefix) {
    const key = type.nameKey in payload ? type.nameKey : "displayName"
    payload[key] = `${options.prefix} ${itemName(type, snapshot)}`
  }

  const collection = (step: Step): Step => ({ ...step, path: step.path.replace("{collection}", type.path) })
  const steps = (type.after?.(snapshot) ?? []).map(collection)
  const content = steps.filter((step) => step.kind === "content")
  const extraAssignments = steps.filter((step) => step.kind === "assignments")

  return {
    create: { method: "POST", path: type.createPath?.(snapshot) ?? type.path, body: payload },
    steps: content,
    assignments: options.includeAssignments ? [...assignmentSteps(type, snapshot), ...extraAssignments] : [],
  }
}

/**
 * Requests that put an existing object back to the snapshot, keeping its ID and name.
 * Assignments are replaced as a whole when requested.
 */
export function buildUpdatePlan(type: IntuneType, snapshot: Item, id: string, options: PlanOptions & { current?: Item } = {}): Step[] {
  if (type.restore === "metadata") throw new NotRestorableError(type.limitation ?? "This type is backed up for reference only.")
  if (options.includeAssignments && (type.assign === "post" || type.folder === "RoleDefinitions")) {
    throw new NotRestorableError(`Assignment replacement is not supported for ${type.label}. Turn off Restore assignments and reconcile assignments in Intune.`)
  }
  const payload = cleanPayload(type, snapshot)
  const collection = (step: Step): Step => ({ ...step, path: step.path.replace("{collection}", type.path) })
  const after = (type.after?.(snapshot) ?? []).map(collection)
  const content = type.update
    ? type.update(payload, snapshot, options.current ?? {}).map(collection)
    : [{ method: "PATCH", path: `${type.path}/{id}`, body: payload, kind: "content" } as Step, ...after.filter((step) => step.kind === "content")]
  // Additive assignment steps (such as new role assignments) would duplicate what already exists.
  const assignments = [...assignmentSteps(type, snapshot, true), ...after.filter((step) => step.kind === "assignments" && step.replacesAll)]
  const steps = [...content, ...(options.includeAssignments ? assignments : [])]
  return steps.map((step) => resolveStep(step, id))
}

function cleanPayload(type: IntuneType, snapshot: Item): Item {
  let payload = structuredClone(snapshot)
  for (const key of [...COMMON_READ_ONLY, ...(type.readOnly ?? [])]) delete payload[key]
  stripAnnotations(payload)
  if (type.prepare) payload = type.prepare(payload, snapshot)
  return payload
}

/** With `replace`, an empty list is sent too, so assignments added since the backup are removed. */
function assignmentSteps(type: IntuneType, snapshot: Item, replace = false): Step[] {
  const assignments = (Array.isArray(snapshot.assignments) ? (snapshot.assignments as Item[]) : [])
    // Assignments inherited from a policy set come back with the set; copying them would make them direct.
    .filter((assignment) => typeof assignment.source !== "string" || assignment.source === "direct")
    .map(cleanAssignment)
    .filter((assignment) => !(type.exclusionsUnsupported && isExclusion(assignment)))
  if (!type.assign || (!assignments.length && !replace)) return []
  if (type.assign === "post") {
    return assignments.map((body) => ({ method: "POST", path: `${type.path}/{id}/assignments`, body, kind: "assignments" }))
  }
  return [{ method: "POST", path: `${type.path}/{id}/assign`, body: { [type.assign.key]: assignments as Json }, kind: "assignments" }]
}

function isExclusion(assignment: Item): boolean {
  const target = assignment.target as Item | undefined
  return typeof target?.["@odata.type"] === "string" && target["@odata.type"].toLowerCase().includes("exclusion")
}

/**
 * Removes OData annotations such as @odata.context and settings@odata.nextLink, keeping @odata.type and binds,
 * and action annotations such as "#microsoft.graph.assign" that exports written by other tools include.
 */
function stripAnnotations(value: Json): void {
  if (Array.isArray(value)) {
    for (const entry of value) stripAnnotations(entry)
    return
  }
  if (!value || typeof value !== "object") return
  for (const key of Object.keys(value)) {
    if (key.startsWith("#") || (key.includes("@odata.") && key !== "@odata.type" && !key.endsWith("@odata.bind"))) delete value[key]
    else stripAnnotations(value[key] ?? null)
  }
}

/**
 * Replaces `{id}` with the created object's ID in the step's path (not its query) and in body
 * `@odata.bind` references to the new object. Other body text is never rewritten.
 */
export function resolveStep(step: Step, id: string): Step {
  if (!isGraphId(id)) throw new Error("Microsoft Graph returned an invalid object ID")
  const encoded = encodeURIComponent(id)
  const query = step.path.indexOf("?")
  const path = query < 0 ? step.path.replaceAll("{id}", encoded) : step.path.slice(0, query).replaceAll("{id}", encoded) + step.path.slice(query)
  const body = structuredClone(step.body)
  for (const [key, value] of Object.entries(body)) {
    if (key.endsWith("@odata.bind") && typeof value === "string") body[key] = value.replaceAll("{id}", encoded)
  }
  return { ...step, path, body }
}
