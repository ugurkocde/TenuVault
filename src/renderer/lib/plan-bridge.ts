import type { PlanIpcError } from "../../shared/plan-errors"
import { CommunityLimitError } from "../../shared/plan-errors"
import type { TenuVaultBridge, TenuVaultPreloadBridge } from "../../shared/ipc"
import { FeatureApiError } from "./feature-api"

/** Rebuild typed errors in the renderer, after both IPC and the context bridge. */
export async function unwrapPlanResult<T>(result: Promise<T | PlanIpcError>): Promise<T> {
  const value = await result
  if (value && typeof value === "object" && "planError" in value) {
    const error = value.planError
    if (error.code === "community_tenant_limit") throw new CommunityLimitError(error.tenantId, error.message)
    throw new FeatureApiError(error.message, 402, error.upgrade)
  }
  return value
}

export function createRendererBridge(raw: TenuVaultPreloadBridge): TenuVaultBridge {
  return {
    ...raw,
    auth: { ...raw.auth, signIn: (...args) => unwrapPlanResult(raw.auth.signIn(...args)) },
    license: { ...raw.license, checkNewTenant: (...args) => unwrapPlanResult(raw.license.checkNewTenant(...args)) },
    schedules: { ...raw.schedules, set: (...args) => unwrapPlanResult(raw.schedules.set(...args)) },
    pdfBranding: { ...raw.pdfBranding, set: (...args) => unwrapPlanResult(raw.pdfBranding.set(...args)) },
    backupReader: {
      ...raw.backupReader,
      prepare: (...args) => unwrapPlanResult(raw.backupReader.prepare(...args)),
      verify: (...args) => unwrapPlanResult(raw.backupReader.verify(...args)),
    },
  }
}
