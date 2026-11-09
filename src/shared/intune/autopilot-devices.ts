import type { Item, Json, ReviewChange, Step } from "./registry"
import { csvCell } from "../security"

/**
 * Windows Autopilot devices (Devices > Enrollment > Windows Autopilot > Devices), read from
 * deviceManagement/windowsAutopilotDeviceIdentities.
 *
 * Microsoft Graph never returns a device's hardware hash once it is imported, so a backup records the
 * device's registration details and cannot register a deleted device again. Restore puts the properties
 * Intune lets admins edit back on a device that is still registered, with updateDeviceProperties. That
 * action leaves properties its body does not name unchanged, clears the group tag and the device name with
 * "", and refuses an empty user or friendly name: unassignUserFromDevice clears both instead.
 * Intune applies the changes asynchronously, property by property, within a few minutes.
 */

/**
 * What a backup keeps of each device. Status and contact times change on their own, the product key and
 * the Surface Hub device account password are never stored, and the Intune and Entra device IDs change
 * when a device is enrolled again or rejoins Entra.
 */
export const AUTOPILOT_DEVICE_PROPERTIES = [
  "serialNumber",
  "manufacturer",
  "model",
  "systemFamily",
  "skuNumber",
  "groupTag",
  "purchaseOrderIdentifier",
  "userPrincipalName",
  "addressableUserName",
  "displayName",
  "resourceName",
  "deviceAccountUpn",
  "deviceFriendlyName",
]

export const AUTOPILOT_DEVICE_REIMPORT =
  "This device is not registered in Windows Autopilot in this tenant. Backups cannot include its hardware hash, so it cannot be registered again from a backup: import it again with its hardware hash, then restore it to bring back its group tag, user and device name."

export const AUTOPILOT_DEVICE_DELAY = "Intune applies Autopilot device changes within a few minutes."

const FIELDS: Array<{ key: string; label: string }> = [
  { key: "groupTag", label: "Group tag" },
  { key: "displayName", label: "Device name" },
  { key: "userPrincipalName", label: "Assigned user" },
  { key: "addressableUserName", label: "User friendly name" },
]

const text = (value: Json | undefined): string => (typeof value === "string" ? value : "")
const shown = (value: Json | undefined): string => text(value) || "Not set"

/**
 * How the assigned user and its friendly name are put back. updateDeviceProperties refuses an empty user,
 * an empty friendly name and a friendly name without a user, so a friendly name is only sent with the
 * backed-up user, and unassignUserFromDevice is the only way to clear either. A friendly name the backup
 * leaves empty while it keeps a user, or holds without a user, cannot be written.
 */
function userRestore(snapshot: Item, current: Item): { body: Item; unassign: boolean; friendlyRestored: boolean } {
  const user = text(snapshot.userPrincipalName)
  const friendly = text(snapshot.addressableUserName)
  const liveUser = text(current.userPrincipalName)
  const liveFriendly = text(current.addressableUserName)
  if (!user) {
    // Unassigning clears the user and its friendly name; with no live user there is nothing to unassign.
    const unassign = Boolean(liveUser)
    return { body: {}, unassign, friendlyRestored: !friendly && (unassign || !liveFriendly) }
  }
  const body: Item = {}
  if (user !== liveUser || (friendly && friendly !== liveFriendly)) {
    body.userPrincipalName = user
    if (friendly) body.addressableUserName = friendly
  }
  return { body, unassign: false, friendlyRestored: friendly ? true : !liveFriendly }
}

/** The editable properties that differ between the live device and the backup. */
export function autopilotDeviceChanges(snapshot: Item, current: Item): ReviewChange[] {
  const { friendlyRestored } = userRestore(snapshot, current)
  return FIELDS.filter(({ key }) => text(snapshot[key]) !== text(current[key])).map(({ key, label }) => ({
    label,
    from: shown(current[key]),
    to: shown(snapshot[key]),
    restored: key !== "addressableUserName" || friendlyRestored,
  }))
}

/** The requests that put the backed-up editable properties back, or nothing when none differs. */
export function autopilotDeviceUpdate(snapshot: Item, current: Item): Step[] {
  const body: Item = {}
  for (const key of ["groupTag", "displayName"]) if (text(snapshot[key]) !== text(current[key])) body[key] = text(snapshot[key])
  const user = userRestore(snapshot, current)
  Object.assign(body, user.body)
  const steps: Step[] = []
  if (Object.keys(body).length) steps.push({ method: "POST", path: "{collection}/{id}/updateDeviceProperties", body, kind: "content" })
  if (user.unassign) steps.push({ method: "POST", path: "{collection}/{id}/unassignUserFromDevice", body: {}, kind: "content" })
  return steps
}

/** The columns of the device list export, in Intune's names. */
const CSV_COLUMNS: Array<{ key: string; label: string }> = [
  { key: "serialNumber", label: "Serial number" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "model", label: "Model" },
  { key: "groupTag", label: "Group tag" },
  { key: "purchaseOrderIdentifier", label: "Purchase order" },
  { key: "userPrincipalName", label: "Assigned user" },
  { key: "addressableUserName", label: "User friendly name" },
  { key: "displayName", label: "Device name" },
]

/**
 * The backed-up devices as CSV, one row per device sorted by serial number, so the group tags can be
 * joined with hardware hash files by serial number before devices are imported again. Cells are escaped
 * against formula injection.
 */
export function autopilotDevicesCsv(devices: Item[]): string {
  const rows = [...devices]
    .sort((a, b) => text(a.serialNumber).localeCompare(text(b.serialNumber)))
    .map((device) => CSV_COLUMNS.map(({ key }) => csvCell(text(device[key]))).join(","))
  return [CSV_COLUMNS.map(({ label }) => csvCell(label)).join(","), ...rows].join("\r\n") + "\r\n"
}
