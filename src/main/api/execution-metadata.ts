import { AsyncLocalStorage } from "node:async_hooks"
import type { SignedInAccount } from "../../shared/ipc"
import type { RestoreConnection } from "../restore/service"

export interface ExecutionMetadata { directoryActor?: Pick<SignedInAccount, "username" | "name"> }
/** Main-process context only. Request bodies, headers and response JSON cannot set it. */
export const executionMetadata = new AsyncLocalStorage<ExecutionMetadata>()
export function captureDirectoryExecutionActor(connection: RestoreConnection) {
  const metadata = executionMetadata.getStore()
  if (metadata) metadata.directoryActor = { username: connection.auditActor?.username ?? connection.userId, name: connection.auditActor?.name }
}
