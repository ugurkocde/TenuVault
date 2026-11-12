import { execFile } from "node:child_process"
import { join } from "node:path"
import type { RecoveryDeviceStatus } from "../../shared/app-sources/types"
import { sourceTenant } from "../app-sources/store"

export interface EnrollmentObservation {
  elevated: boolean
  certificateAccessDenied?: boolean
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
$certificateAccessDenied=$false
try {$certificates=@(Get-ChildItem Cert:\LocalMachine\My | Where-Object {$_.Extensions.Oid.Value -contains '1.2.840.113556.5.6'} | ForEach-Object {
 $cert=$_;$raw=@($cert.Extensions | Where-Object {$_.Oid.Value -eq '1.2.840.113556.5.6'})[0].RawData
 if($raw.Length -eq 18 -and $raw[0] -eq 4 -and $raw[1] -eq 16){$raw=[byte[]]$raw[2..17]}
 if($raw.Length -eq 16){@{thumbprint=$cert.Thumbprint;accountId=(New-Object Guid (,$raw)).ToString();notBefore=$cert.NotBefore.ToUniversalTime().ToString('o');notAfter=$cert.NotAfter.ToUniversalTime().ToString('o');hasPrivateKey=$cert.HasPrivateKey}}
})} catch {if($_.CategoryInfo.Category -eq 'PermissionDenied'){$certificateAccessDenied=$true;$certificates=@()}else{throw}}
@{elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);enrollments=$enrollments;certificates=$certificates;certificateAccessDenied=$certificateAccessDenied} | ConvertTo-Json -Depth 5 -Compress
`

export function evaluateDevice(tenant: string, intuneAccount: string, data: EnrollmentObservation, now = Date.now()): RecoveryDeviceStatus {
  sourceTenant(tenant); sourceTenant(intuneAccount)
  const state = { ...unknown("win32"), elevated: data.elevated === true }
  if (data.certificateAccessDenied === true) return { ...state, certificate: "access-denied", reason: "Windows denied access to public certificate metadata. Recovery is not available in this version." }
  if (!Array.isArray(data.enrollments) || !Array.isArray(data.certificates)) return state
  const enrolled = data.enrollments.filter(e => e && typeof e.tenantId === "string" && typeof e.thumbprint === "string" && e.tenantId.toLowerCase() === tenant)
  if (!enrolled.length) return { ...state, enrollment: data.enrollments.length ? "different-tenant" : "not-enrolled", certificate: "missing" }
  const matches = data.certificates.filter(c => c && c.hasPrivateKey === true && typeof c.accountId === "string" && c.accountId.toLowerCase() === intuneAccount && Date.parse(c.notBefore) <= now && Date.parse(c.notAfter) > now && typeof c.thumbprint === "string" && enrolled.some(e => e.thumbprint.replaceAll(" ", "").toUpperCase() === c.thumbprint.toUpperCase()))
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
      return new Promise<EnrollmentObservation>((resolve, reject) => {
        const child = execFile(executable, ["-NoProfile", "-NonInteractive", "-Command", "-"], { timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) { reject(error); return }
          try { resolve(JSON.parse(stdout) as EnrollmentObservation) } catch (error) { reject(error) }
        })
        child.stdin?.on("error", reject)
        // Windows PowerShell's stdin command mode needs a blank line to execute a block.
        child.stdin?.end(`& {\n${DEVICE_CHECK_SCRIPT}\n}\n\n`)
      })
    }))()
    return evaluateDevice(tenant, id, data)
  } catch { return { ...unknown(platform), reason: "The device's enrollment could not be confirmed. Check tenant access and Windows enrollment, then retry. Recovery is not available in this version." } }
}
