import type { BackupReaderState } from "../../shared/ipc"
import { typeForFolder } from "../../shared/intune/registry"

/** Days before expiry from which the Backup Reader card asks for a renewal. */
export const RENEW_DAYS = 30

/** What the Backup Reader card shows for a tenant's state. */
export function readerView(state: BackupReaderState | null, now = Date.now()) {
  const reader = state?.reader ?? null
  const verified = reader?.state === "verified"
  // A renewal waits next to the verified certificate, so both the status and the steps show.
  const waiting = !!reader && (reader.state === "pending" || reader.renewalPending)
  const daysLeft = reader ? Math.ceil((Date.parse(reader.notAfter) - now) / 86_400_000) : null
  const expiry = verified && daysLeft !== null && daysLeft <= RENEW_DAYS && !reader.renewalPending ? (daysLeft > 0 ? "soon" as const : "expired" as const) : null
  // A renewal or another computer's certificate goes onto the same app registration.
  const command = verified
    ? `./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer> -AppId ${reader.clientId}`
    : "./New-TenuVaultBackupReader.ps1 -CertificatePath <exported .cer>"
  const excluded = (reader?.excludedTypes ?? []).map((folder) => typeForFolder(folder)?.label ?? folder)
  return { reader, verified, waiting, daysLeft, expiry, command, excluded, canAct: !!state?.supported && !!state.available }
}
