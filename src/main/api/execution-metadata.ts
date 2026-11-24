import { AsyncLocalStorage } from "node:async_hooks"
import type { SignedInAccount } from "../../shared/ipc"
import type { RestoreConnection } from "../restore/service"
import type { AuditBinding } from "./audit-sink"

export interface ExecutionMetadata {
  /** Tenant client IDs captured when the operation is admitted. */
  connections?: ReadonlyMap<string, string | undefined>
  /** Add validated participants loaded from a stored operation. */
  bindParticipants?: (tenantIds: readonly string[]) => void
  /** The temporary Graph acquisition used only while provisioning an own registration. */
  registrationSetup?: { tenantId: string; clientId: string; tokenDigest: string }
  /** Set only around the final write after a fresh deleted-object type check. */
  directoryRecycle?: { path: string; type: "user" | "group" }
  /** The source and destinations admitted for a cross-tenant backup copy. */
  copyTenants?: { source: string; destinations: string[] }
  directoryActor?: Pick<SignedInAccount, "username" | "name">
  /** The audit binding of the admin who started an archive download, captured before its route runs. */
  downloadAudit?: AuditBinding
  /** The account whose delegated token the request used first: the admin who really acted. */
  tokenActor?: Pick<SignedInAccount, "username" | "name">
}

/** Records the account a delegated token was issued for, once per request. */
export function captureTokenActor(actor: Pick<SignedInAccount, "username" | "name">): void {
  const metadata = executionMetadata.getStore()
  if (metadata && !metadata.tokenActor) metadata.tokenActor = actor
}
/** Main-process context only. Request bodies, headers and response JSON cannot set it. */
export const executionMetadata = new AsyncLocalStorage<ExecutionMetadata>()
export function captureDirectoryExecutionActor(connection: RestoreConnection) {
  const metadata = executionMetadata.getStore()
  if (metadata) metadata.directoryActor = { username: connection.auditActor?.username ?? connection.userId, name: connection.auditActor?.name }
}
