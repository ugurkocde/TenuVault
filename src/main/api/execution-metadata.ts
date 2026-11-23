import { AsyncLocalStorage } from "node:async_hooks"
import type { SignedInAccount } from "../../shared/ipc"
import type { RestoreConnection } from "../restore/service"
import type { AuditBinding } from "./audit-sink"

export interface ExecutionMetadata {
  directoryActor?: Pick<SignedInAccount, "username" | "name">
  /** The audit binding of the admin who started an archive download, captured before the save runs. */
  downloadAudit?: AuditBinding
}
/** Main-process context only. Request bodies, headers and response JSON cannot set it. */
export const executionMetadata = new AsyncLocalStorage<ExecutionMetadata>()
export function captureDirectoryExecutionActor(connection: RestoreConnection) {
  const metadata = executionMetadata.getStore()
  if (metadata) metadata.directoryActor = { username: connection.auditActor?.username ?? connection.userId, name: connection.auditActor?.name }
}
