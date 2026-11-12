import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import type { RecoveryDeviceStatus } from "../../shared/app-sources/types"
import { sourceTenant } from "../app-sources/store"

export interface EnrollmentObservation {
  elevated: boolean
  enrollments: Array<{ tenantId: string; thumbprint: string }>
  certificates: Array<{ thumbprint: string; accountId: string; notBefore: string; notAfter: string; hasPrivateKey: boolean }>
}
const reason = "Recovery from Intune is not available in this version. Device checks are read-only."
const unknown = (platform: RecoveryDeviceStatus["platform"]): RecoveryDeviceStatus => ({ platform, enrollment: "unknown", certificate: "unknown", elevated: false, captureAvailable: false, reason })

/** Public enrollment/certificate metadata only. Never opens or signs with a private key. */
export const DEVICE_CHECK_SCRIPT = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$enrollments=@(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -ErrorAction SilentlyContinue | ForEach-Object {
 $p=Get-ItemProperty $_.PSPath
 if($p.AADTenantID -and $p.DMPCertThumbPrint){@{tenantId=[string]$p.AADTenantID;thumbprint=[string]$p.DMPCertThumbPrint}}
})
$certificates=@(Get-ChildItem Cert:\LocalMachine\My | Where-Object {$_.Extensions.Oid.Value -contains '1.2.840.113556.5.6'} | ForEach-Object {
 $cert=$_;$raw=@($cert.Extensions | Where-Object {$_.Oid.Value -eq '1.2.840.113556.5.6'})[0].RawData
 if($raw.Length -eq 18 -and $raw[0] -eq 4 -and $raw[1] -eq 16){$raw=[byte[]]$raw[2..17]}
 if($raw.Length -eq 16){@{thumbprint=$cert.Thumbprint;accountId=(New-Object Guid (,$raw)).ToString();notBefore=$cert.NotBefore.ToUniversalTime().ToString('o');notAfter=$cert.NotAfter.ToUniversalTime().ToString('o');hasPrivateKey=$cert.HasPrivateKey}}
})
@{elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);enrollments=$enrollments;certificates=$certificates} | ConvertTo-Json -Depth 5 -Compress
`

export function evaluateDevice(tenant: string, intuneAccount: string, data: EnrollmentObservation, now = Date.now()): RecoveryDeviceStatus {
  sourceTenant(tenant); sourceTenant(intuneAccount)
  const state = { ...unknown("win32"), elevated: data.elevated === true }
  if (!Array.isArray(data.enrollments) || !Array.isArray(data.certificates)) return state
  const enrolled = data.enrollments.filter(e => typeof e.tenantId === "string" && e.tenantId.toLowerCase() === tenant)
  if (!enrolled.length) return { ...state, enrollment: data.enrollments.length ? "different-tenant" : "not-enrolled", certificate: "missing" }
  const matches = data.certificates.filter(c => c.hasPrivateKey === true && typeof c.accountId === "string" && c.accountId.toLowerCase() === intuneAccount && Date.parse(c.notBefore) <= now && Date.parse(c.notAfter) > now && typeof c.thumbprint === "string" && enrolled.some(e => typeof e.thumbprint === "string" && e.thumbprint.replaceAll(" ", "").toUpperCase() === c.thumbprint.toUpperCase()))
  const matchingEnrollments = enrolled.filter(e => matches.some(c => e.thumbprint.replaceAll(" ", "").toUpperCase() === c.thumbprint.toUpperCase()))
  if (matches.length !== 1 || matchingEnrollments.length !== 1) return { ...state, enrollment: "unknown", certificate: matches.length > 1 || matchingEnrollments.length > 1 ? "ambiguous" : "missing" }
  return { ...state, enrollment: "matched", certificate: "matched" }
}

export async function checkRecoveryDevice(tenant: string, account: () => Promise<string>, options: { platform?: RecoveryDeviceStatus["platform"]; probe?: () => Promise<EnrollmentObservation> } = {}): Promise<RecoveryDeviceStatus> {
  const platform = options.platform ?? process.platform as RecoveryDeviceStatus["platform"]
  sourceTenant(tenant)
  if (platform !== "win32") return { ...unknown(platform), reason: "Device checks require a Windows PC enrolled in the selected tenant. Recovery is not available in this version." }
  try {
    const id = sourceTenant(await account())
    const data = await (options.probe ?? (async () => {
      const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      const result = await promisify(execFile)(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(DEVICE_CHECK_SCRIPT, "utf16le").toString("base64")], { timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true })
      return JSON.parse(result.stdout) as EnrollmentObservation
    }))()
    return evaluateDevice(tenant, id, data)
  } catch { return { ...unknown(platform), reason: "The device's enrollment could not be confirmed. Sign in and retry the check. Recovery is not available in this version." } }
}
