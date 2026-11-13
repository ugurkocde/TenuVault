import { execFile } from "node:child_process"
import { join } from "node:path"
import { sourceTenant } from "../app-sources/store"
import { evaluateDevice, observeWindowsEnrollment } from "./device-check"

/** These identifiers stay in main. The renderer cannot choose a different capture device. */
export function assignmentDeviceId(tenant: string, status: string): string {
  const field = (name: string) => [...status.matchAll(new RegExp(`^\\s*${name}\\s*:\\s*([^\\r\\n]+)$`, "gm"))].map(match => match[1]!.trim())
  const devices = field("DeviceId"), tenants = field("TenantId"), joined = field("AzureAdJoined")
  if (devices.length !== 1 || tenants.length !== 1 || joined.length !== 1 || joined[0] !== "YES" || sourceTenant(tenants[0]) !== sourceTenant(tenant)) throw new Error("This PC's Entra tenant and device identity could not be matched. Check its work or school connection.")
  return sourceTenant(devices[0])
}

export async function readAssignmentDevice(tenant: string, account: () => Promise<string>): Promise<string> {
  // Starting both Windows probes can be slow on a busy enrolled workstation.
  const probeTimeout = 30_000
  const [intuneAccount, observation, status] = await Promise.all([
    account(), observeWindowsEnrollment(probeTimeout),
    new Promise<string>((resolve, reject) => execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "dsregcmd.exe"), ["/status"], { timeout: probeTimeout, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))),
  ])
  if (evaluateDevice(tenant, intuneAccount, observation).enrollment !== "matched") throw new Error("This PC's current Intune enrollment could not be matched to the selected tenant. Check its enrollment before changing assignments.")
  return assignmentDeviceId(tenant, status)
}
