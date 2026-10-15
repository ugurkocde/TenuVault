import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"
import type { CisRemediationRecord } from "../../../main/features/cis-remediation/engine"
import type { ChangeSet, ChangeSetActions, ChangeSetPreview, RollbackPreview } from "../shared/change-set"

export const PATH = "/api/cis-remediation" as const
export type Deployment = CisRemediationRecord & { id: string; createdAt: string; updatedAt: string; rollbackStatus?: ChangeSet["status"] | null }
export interface DeploymentDetail { deployment: Deployment; changeSet: ChangeSet | null; rollbackChangeSet: ChangeSet | null }

export const listDeployments = (tenant: Tenant) => featureCall<{ deployments: Deployment[] }>(PATH, tenant, "list")
export const getDeployment = (tenant: Tenant, id: string) => featureCall<DeploymentDetail>(PATH, tenant, "get", { id })

export function deploymentActions(tenant: Tenant, deployment: Deployment): ChangeSetActions {
  const base = { id: deployment.id }
  return {
    preview: async () => (await featureCall<{ changeSet: ChangeSetPreview }>(PATH, tenant, "preview", base)).changeSet,
    approve: (input) => featureCall(PATH, tenant, "approve", { ...base, ...input }),
    reject: (input) => featureCall(PATH, tenant, "reject", { ...base, ...input }),
    apply: (contentHash) => featureCall(PATH, tenant, "apply", { ...base, contentHash, confirm: true }),
    retry: (contentHash) => featureCall(PATH, tenant, "retry", { ...base, contentHash, confirm: true }),
    rollbackPreview: () => featureCall<RollbackPreview>(PATH, tenant, "rollback-preview", base),
    rollbackCreate: () => featureCall<{ changeSet: ChangeSet }>(PATH, tenant, "rollback-create", base),
  }
}

export function rollbackActions(tenant: Tenant, deployment: Deployment): ChangeSetActions {
  const base = { id: deployment.id }
  const none = () => Promise.reject(new Error("A rollback is itself undone by a new reviewed change, not by a rollback of a rollback."))
  return {
    preview: () => featureCall<ChangeSetPreview>(PATH, tenant, "rollback-review", base),
    approve: (input) => featureCall(PATH, tenant, "rollback-approve", { ...base, ...input }),
    reject: (input) => featureCall(PATH, tenant, "rollback-reject", { ...base, ...input }),
    apply: (contentHash) => featureCall(PATH, tenant, "rollback-apply", { ...base, contentHash, confirm: true }),
    retry: (contentHash) => featureCall(PATH, tenant, "rollback-apply", { ...base, contentHash, confirm: true }),
    rollbackPreview: none, rollbackCreate: none,
  }
}
