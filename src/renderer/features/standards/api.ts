import type { Tenant } from "~/contexts/TenantContext"
import { featureCall } from "../../lib/feature-api"
import type { AdoptionPreview, AdoptionRecord, CustomizationRecord } from "../../../main/features/standards/service"
import type { Overlay, StandardVersion, VersionDiffEntry } from "../../../main/features/standards/model"
import type { ChangeSet } from "../shared/change-set"

type Stored<T> = T & { id: string; tenantId: string; createdAt: string; updatedAt: string; history?: Array<{ at: string; actor: string | null; reason: string }> }
export type Customization = Stored<CustomizationRecord>
export type Standard = Stored<StandardVersion>
export type Adoption = Stored<AdoptionRecord>
export type { AdoptionPreview, Overlay, VersionDiffEntry }
export interface AdoptionState {
  id: string
  tenantId: string
  standardKey: string
  title: string
  status: string
  adoptedVersion: number | null
  configuredVersion: number
  latestVersion: number | null
  pendingUpgrade: boolean
  deviations: number | null
  unknownPolicies: number | null
  assessedAt: string | null
  freshness: "fresh" | "stale" | "unknown"
}

const PATH = "/api/standards"

export const listCustomizations = (tenant: Tenant) => featureCall<{ customizations: Customization[] }>(PATH, tenant, "list-customizations")
export const createCustomization = (tenant: Tenant, input: { title: string; settingKey: string; policyName: string; value: string; reason: string; owner: string; expiresAt?: string }) => featureCall<{ customization: Customization }>(PATH, tenant, "create-customization", input)
export const reviseCustomization = (tenant: Tenant, id: string, input: { value?: string; owner?: string; why: string }) => featureCall<{ customization: Customization }>(PATH, tenant, "revise-customization", { id, ...input })
export const retireCustomization = (tenant: Tenant, id: string, why: string) => featureCall<{ customization: Customization }>(PATH, tenant, "retire-customization", { id, why })

export const listStandards = (tenant: Tenant) => featureCall<{ standards: Standard[] }>(PATH, tenant, "list-standards")
export const createStandard = (tenant: Tenant, body: Record<string, unknown>) => featureCall<{ standard: Standard }>(PATH, tenant, "standard-create", body)
export const publishStandardVersion = (tenant: Tenant, body: Record<string, unknown>) => featureCall<{ standard: Standard }>(PATH, tenant, "standard-publish-version", body)
export const diffStandards = (tenant: Tenant, fromId: string, toId: string) => featureCall<{ diff: VersionDiffEntry[] }>(PATH, tenant, "get-standard-diff", { fromId, toId })

export const listAdoptions = (tenant: Tenant) => featureCall<{ adoptions: Array<Adoption & { state: AdoptionState }> }>(PATH, tenant, "list-adoptions")
export const getAdoption = (tenant: Tenant, id: string) => featureCall<{ adoption: Adoption; state: AdoptionState; changeSets: ChangeSet[] }>(PATH, tenant, "get-adoption", { id })
export const adoptStandard = (tenant: Tenant, versionId: string) => featureCall<{ adoption: Adoption }>(PATH, tenant, "standard-adopt", { versionId })
export const configureAdoption = (tenant: Tenant, id: string, change: Record<string, unknown>) => featureCall<{ adoption: Adoption }>(PATH, tenant, "standard-configure", { id, ...change })
export const previewAdoption = (tenant: Tenant, id: string) => featureCall<AdoptionPreview>(PATH, tenant, "standard-preview", { id })
export const planAdoption = (tenant: Tenant, id: string, acknowledgeMigration: boolean) => featureCall<{ adoption: Adoption; changeSet: ChangeSet }>(PATH, tenant, "standard-plan", { id, acknowledgeMigration })
export const assessAdoption = (tenant: Tenant, id: string) => featureCall<{ adoption: Adoption; state: AdoptionState }>(PATH, tenant, "standard-assess", { id })
export const portfolioAdoptions = (tenant: Tenant, targetIds: string[]) => featureCall<{ tenants: Array<{ tenantId: string; name: string | null; adoptions: AdoptionState[] }> }>(PATH, tenant, "portfolio-adoptions", { targetTenants: targetIds.map((tenantId) => ({ tenantId })) })
