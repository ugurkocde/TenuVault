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
 * "", and refuses an empty user: unassignUserFromDevice clears the user and its friendly name instead.
 * Intune applies the changes asynchronously, property by property, within a few minutes.
 */

/**
 * What a backup keeps of each device. Status and contact times change on their own, the product key and
 * the Surface Hub device account password are never stored, and the Intune device ID changes on every
 * enrollment.
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
  "azureAdDeviceId",
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

/** The editable properties that differ between the live device and the backup. */
export function autopilotDeviceChanges(snapshot: Item, current: Item): ReviewChange[] {
  return FIELDS.filter(({ key }) => text(snapshot[key]) !== text(current[key])).map(({ key, label }) => ({
    label,
    from: shown(current[key]),
    to: shown(snapshot[key]),
    restored: true,
  }))
}

/** The requests that put the backed-up editable properties back, or nothing when none differs. */
export function autopilotDeviceUpdate(snapshot: Item, current: Item): Step[] {
  const body: Item = {}
  for (const key of ["groupTag", "displayName"]) if (text(snapshot[key]) !== text(current[key])) body[key] = text(snapshot[key])
  const user = text(snapshot.userPrincipalName)
  const liveUser = text(current.userPrincipalName)
  const friendly = text(snapshot.addressableUserName)
  const userChanged = user !== liveUser || friendly !== text(current.addressableUserName)
  const steps: Step[] = []
  if (userChanged && user) {
    body.userPrincipalName = user
    body.addressableUserName = friendly
  } else if (userChanged && !liveUser) {
    // No user either side: only the friendly name differs, which the action sets on its own.
    body.addressableUserName = friendly
  }
  if (Object.keys(body).length) steps.push({ method: "POST", path: "{collection}/{id}/updateDeviceProperties", body, kind: "content" })
  // The backup has no user: unassigning clears the user and its friendly name.
  if (userChanged && !user && liveUser) steps.push({ method: "POST", path: "{collection}/{id}/unassignUserFromDevice", body: {}, kind: "content" })
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
