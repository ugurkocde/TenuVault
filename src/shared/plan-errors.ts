import { PlanRequired, type Feature } from "./plans"

/** The existing Community tenant allowance was reached. */
export class CommunityLimitError extends Error {
  readonly code = "community_tenant_limit"

  constructor(readonly tenantId: string, message: string) {
    super(message)
    this.name = "CommunityLimitError"
  }
}

export interface PlanIpcError {
  planError:
    | { code: "community_tenant_limit"; message: string; tenantId: string }
    | { code: "plan_required"; message: string; upgrade: Feature }
}

/** Electron does not preserve custom fields on thrown errors. Send plan errors as data. */
export async function withPlanError<T>(action: () => T | Promise<T>): Promise<T | PlanIpcError> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof CommunityLimitError) {
      return { planError: { code: error.code, message: error.message, tenantId: error.tenantId } }
    }
    if (error instanceof PlanRequired) {
      return { planError: { code: "plan_required", message: error.message, upgrade: error.feature } }
    }
    throw error
  }
}
