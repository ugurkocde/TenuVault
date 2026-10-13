import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"
import type { PromotionRecord } from "../../../main/features/promotion/engine"
import type { Mapping, ReferenceKind, ReferenceResolution } from "../../../main/features/promotion/mapping"
import type { ChangeSet, ChangeSetActions, ChangeSetPreview, RollbackPreview } from "../shared/change-set"

export type { Mapping, ReferenceKind, ReferenceResolution }

export type Promotion = PromotionRecord & { id: string; createdAt: string; updatedAt: string }
export interface PolicyOption { id: string; name: string; folder: string; platforms: string | null; lastModifiedDateTime: string | null }
export const PROMOTION_TYPE_OPTIONS = [
  { folder: "ConfigurationPolicies", label: "Settings Catalog policies" },
  { folder: "CompliancePolicies", label: "Compliance policies" },
  { folder: "DeviceConfigurations", label: "Device configuration profiles" },
  { folder: "EndpointSecurityIntents", label: "Endpoint security policies" },
] as const

const PATH = "/api/promotion"
/** The source is named in targetTenants on every paid call, so its license is checked each time. */
const source = (sourceTenantId: string) => ({ sourceTenantId, targetTenants: [{ tenantId: sourceTenantId }] })

export const listPromotions = (tenant: Tenant) => featureCall<{ promotions: Promotion[] }>(PATH, tenant, "list")
export const getPromotion = (tenant: Tenant, id: string) => featureCall<{ promotion: Promotion; changeSet: ChangeSet | null; rollbackChangeSet: ChangeSet | null }>(PATH, tenant, "get", { id })
export const promotionPolicies = (tenant: Tenant, sourceTenantId: string, folder: string) => featureCall<{ source: PolicyOption[]; destination: PolicyOption[] }>(PATH, tenant, "policies", { ...source(sourceTenantId), folder })
export const targetObjects = (tenant: Tenant, kind: Exclude<ReferenceKind, "group">) => featureCall<{ objects: Array<{ id: string; name: string }>; readable: boolean; reason?: string }>(PATH, tenant, "target-objects", { kind })
export const planPromotion = (tenant: Tenant, input: { sourceTenantId: string; title: string; ticket: string; includeAssignments: boolean; acknowledgeRedacted: boolean; items: Array<{ sourceId: string; destinationId: string | null; folder: string }>; mappings: Mapping[] }) =>
  featureCall<{ promotion: Promotion }>(PATH, tenant, "plan", { ...input, ...source(input.sourceTenantId) })

/** Change-set actions routed through /api/promotion, which re-checks the two-tenant rule. */
export function promotionActions(tenant: Tenant, promotion: Promotion, onSourceChanges: (lines: string[]) => void): ChangeSetActions {
  const base = { id: promotion.id, ...source(promotion.sourceTenantId) }
  return {
    preview: async () => {
      const result = await featureCall<{ changeSet: ChangeSetPreview; sourceChanges: string[] }>(PATH, tenant, "preview", base)
      onSourceChanges(result.sourceChanges)
      return result.changeSet
    },
    approve: (input) => featureCall(PATH, tenant, "approve", { ...base, ...input }),
    reject: (input) => featureCall(PATH, tenant, "reject", { ...base, ...input }),
    apply: (contentHash) => featureCall(PATH, tenant, "apply", { ...base, contentHash, confirm: true }),
    retry: (contentHash) => featureCall(PATH, tenant, "retry", { ...base, contentHash, confirm: true }),
    rollbackPreview: () => featureCall<RollbackPreview>(PATH, tenant, "rollback-preview", base),
    rollbackCreate: () => featureCall<{ changeSet: ChangeSet }>(PATH, tenant, "rollback-create", base),
  }
}

/**
 * Review and apply calls of a promotion's rollback change set. It writes only to the
 * destination, so the source tenant is not named; there is no rollback of a rollback.
 */
export function rollbackActions(tenant: Tenant, promotion: Promotion): ChangeSetActions {
  const base = { id: promotion.id }
  const none = () => Promise.reject(new Error("A rollback is itself undone by a new reviewed promotion, not by a rollback of a rollback."))
  return {
    preview: () => featureCall<ChangeSetPreview>(PATH, tenant, "rollback-review", base),
    approve: (input) => featureCall(PATH, tenant, "rollback-approve", { ...base, ...input }),
    reject: (input) => featureCall(PATH, tenant, "rollback-reject", { ...base, ...input }),
    apply: (contentHash) => featureCall(PATH, tenant, "rollback-apply", { ...base, contentHash, confirm: true }),
    retry: (contentHash) => featureCall(PATH, tenant, "rollback-apply", { ...base, contentHash, confirm: true }),
    rollbackPreview: none,
    rollbackCreate: none,
  }
}

export const KIND_LABEL: Record<ReferenceKind, string> = { group: "Group", filter: "Assignment filter", scopeTag: "Scope tag", reusableSetting: "Reusable setting" }
export const STATE_TONE: Record<ReferenceResolution["state"], "success" | "warning" | "danger" | "neutral"> = { portable: "neutral", mapped: "success", "mapped-unverified": "warning", missing: "danger", rejected: "danger" }
