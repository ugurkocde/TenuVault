import { PlanRequired, type Feature } from "./plans"

/** The existing Community tenant allowance was reached. */
export class CommunityLimitError extends Error {
  readonly code = "community_tenant_limit"

  constructor(readonly tenantId: string, message: string, readonly existingTenant = false) {
    super(message)
    this.name = "CommunityLimitError"
  }
}

/** Coverage ended locally and the admin must choose the Community tenant. */
export class CommunityChoicePendingError extends Error {
  readonly code = "community_choice_pending"
  constructor() {
    super("Open TenuVault and choose which tenant continues on Community to resume its backups.")
    this.name = "CommunityChoicePendingError"
  }
}

export interface PlanIpcError {
  planError:
    | { code: "community_tenant_limit"; message: string; tenantId: string; existingTenant?: boolean }
    | { code: "community_choice_pending"; message: string }
    | { code: "plan_required"; message: string; upgrade: Feature }
}

/** Electron does not preserve custom fields on thrown errors. Send plan errors as data. */
export async function withPlanError<T>(action: () => T | Promise<T>): Promise<T | PlanIpcError> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof CommunityChoicePendingError) return { planError: { code: error.code, message: error.message } }
    if (error instanceof CommunityLimitError) {
      return { planError: { code: error.code, message: error.message, tenantId: error.tenantId, existingTenant: error.existingTenant } }
    }
    if (error instanceof PlanRequired) {
      return { planError: { code: "plan_required", message: error.message, upgrade: error.feature } }
    }
    throw error
  }
}
