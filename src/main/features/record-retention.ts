import { DOMAINS } from "./domains"
import { resolveHistory, type Stored } from "./records"
import type { ChangeSetRecord, ChangeSetContent } from "./change-sets/model"
import type { BaselineRecord, VersionRecord, RebaseRecord, DeploymentRecord, ComparisonRecord as CustomComparison } from "./custom-baselines/service"
import type { BaselineInstallRecord, BaselineSourceRecord, ComparisonRecord, UpgradeRecord } from "./baseline-upgrades/service"
import type { AdoptionRecord, CustomizationRecord } from "./standards/service"
import type { StandardVersion } from "./standards/model"
import type { PromotionRecord } from "./promotion/engine"
import type { FindingRecord, ScanRecord } from "./hygiene"
import type { HealthFinding } from "./health-review/rules"
import type { ReviewRecord } from "./health-review/service"

export interface RetentionContext {
  list<T>(domain: string): Stored<T>[]
  /** Cross-tenant parents may not have been loaded this session. */
  all<T>(domain: string): Stored<T>[] | null
}

/** References in retained revisions are recovery evidence too. */
function states<T>(records: Stored<T>[]): Array<T & { id: string }> {
  return records.flatMap(record => [record, ...resolveHistory(record.history).map(revision => revision.snapshot)])
}

/** A domain owns both its definition of closed and the references that keep its records. */
export function retainRule(domain: string, context: RetentionContext): (record: Stored<unknown>) => boolean {
  const referenced = new Set<string>()
  const pin = (id: string | null | undefined) => { if (id) referenced.add(id) }
  const changes = context.list<ChangeSetRecord>(DOMAINS.changeSets)
  const changeStates = () => states(changes)
  let closed: (record: any) => boolean = () => false // Unknown domains retain their previous refusal behavior.

  switch (domain) {
    case DOMAINS.changeSets: {
      const rolledBack = new Set(changes.filter(record => record.kind === "rollback" && record.status === "applied").map(record => record.rollbackOf))
      for (const record of changeStates()) pin(record.rollbackOf)
      for (const record of states(context.list<PromotionRecord>(DOMAINS.promotions))) { pin(record.changeSetId); pin(record.rollbackChangeSetId) }
      for (const record of states(context.list<UpgradeRecord>(DOMAINS.baselineUpgrades))) for (const batch of record.batches ?? []) pin(batch.changeSetId)
      for (const record of states(context.list<AdoptionRecord>(DOMAINS.adoptions))) { pin(record.pending?.changeSetId); pin(record.adoptedChangeSetId) }
      for (const record of states(context.list<DeploymentRecord>(DOMAINS.customBaselineDeployments))) pin(record.changeSetId)
      // Keep the completed rollback link while its original survives, even if both are closed.
      for (const record of changes) if (record.rollbackOf && changes.some(original => original.id === record.rollbackOf)) pin(record.id)
      closed = (record: ChangeSetRecord & { id: string }) => record.status === "rejected" || (record.status === "failed" && !record.preChange) ||
        (["applied", "partial", "uncertain"].includes(record.status) && rolledBack.has(record.id))
      break
    }
    case DOMAINS.changeSetContent: {
      for (const record of changeStates()) { pin(record.proposalId); pin(record.preChange?.captureId) }
      const parents = new Set(changes.map(record => record.id))
      closed = (record: ChangeSetContent) => !record.changeSetId || !parents.has(record.changeSetId)
      break
    }
    case DOMAINS.customBaselines: {
      const deployments = context.all<DeploymentRecord>(DOMAINS.customBaselineDeployments)
      if (!deployments) return () => true
      const deployedVersions = states(deployments)
      const baselines = context.list<BaselineRecord | VersionRecord | RebaseRecord>(domain)
      const parents = new Set(baselines.filter(record => record.kind === "baseline").map(record => record.id))
      for (const record of states(baselines)) if (record.kind === "baseline") for (const version of record.versions ?? []) pin(version.versionId)
      // Versions and rebases remain available for every surviving baseline, even before the
      // version summary is appended, and even if their own timestamps never change.
      closed = (record: Stored<BaselineRecord | VersionRecord | RebaseRecord>) => record.kind !== "baseline" && !parents.has(record.baselineId) &&
        !deployedVersions.some(deployment => deployment.baselineId === record.baselineId && deployment.baselineTenantId === record.tenantId && (record.kind === "rebase" || deployment.version === record.version)) &&
        (record.kind === "version" || ["applied", "discarded"].includes(record.status))
      break
    }
    case DOMAINS.baselineInstalls: {
      const installs = context.list<BaselineInstallRecord | BaselineSourceRecord | ComparisonRecord>(domain)
      for (const record of states(installs)) {
        if (record.kind === "install") { pin(record.sourceId); for (const policy of record.policies ?? []) pin(policy.sourceId) }
        if (record.kind === "source") pin(record.derivedFrom)
      }
      for (const record of states(context.list<UpgradeRecord>(DOMAINS.baselineUpgrades))) {
        pin(record.installId); pin(record.from?.sourceId); pin(record.to?.sourceId); pin(record.comparisonId)
        for (const policy of record.policies ?? []) pin(policy.previous?.sourceId)
      }
      for (const record of states(context.list<BaselineRecord | VersionRecord | RebaseRecord>(DOMAINS.customBaselines))) {
        if (record.kind === "baseline") { pin(record.provenance?.sourceId); for (const version of record.versions ?? []) pin(version.base?.sourceId) }
        if (record.kind === "version") pin(record.base?.sourceId)
        if (record.kind === "rebase") pin(record.upstream?.sourceId)
      }
      closed = (record: BaselineInstallRecord | BaselineSourceRecord | ComparisonRecord) => record.kind === "source" || record.kind === "comparison"
      break
    }
    case DOMAINS.baselineUpgrades:
      for (const record of states(context.list<BaselineInstallRecord>(DOMAINS.baselineInstalls))) pin(record.lastUpgradeId)
      for (const record of changeStates()) if (record.origin?.workflow === "baseline-upgrade") pin(record.origin.recordId)
      closed = (record: UpgradeRecord) => record.status === "rolled-back" || (record.status === "stale" && record.finalized)
      break
    case DOMAINS.standards: {
      const adoptions = context.all<AdoptionRecord>(DOMAINS.adoptions)
      if (!adoptions) return () => true // A store without a scope inventory cannot prove a shared version is unreferenced.
      for (const record of states(adoptions)) { pin(record.versionId); pin(record.adoptedVersionId); pin(record.pending?.versionId); pin(record.previousAdopted?.versionId) }
      const versions = context.list<StandardVersion>(domain)
      const latest = new Map<string, Stored<StandardVersion>>()
      for (const record of versions) {
        if (!latest.has(record.standardKey) || latest.get(record.standardKey)!.version < record.version) latest.set(record.standardKey, record)
        pin(record.previousVersionId)
      }
      for (const record of latest.values()) pin(record.id)
      closed = () => true // Only superseded, unreferenced immutable versions can go.
      break
    }
    case DOMAINS.adoptions:
      break // An adoption remains tenant configuration, including drafts and failed attempts.
    case DOMAINS.promotions:
      for (const record of changeStates()) if (record.origin?.workflow === "promotion") pin(record.origin.recordId)
      closed = (record: PromotionRecord) => record.status === "rejected" || (record.status === "failed" && !record.changeSetId)
      break
    case DOMAINS.hygieneFindings:
      for (const record of states(context.list<FindingRecord | ScanRecord>(domain))) if (record.kind === "finding") pin(record.scanId)
      closed = (record: FindingRecord | ScanRecord) => record.kind === "scan" || (record.status === "resolved" && !record.review)
      break
    case DOMAINS.healthReviews:
      closed = (record: ReviewRecord) => record.kind === "run" && !!record.finishedAt
      break
    case DOMAINS.healthFindings:
      closed = (record: HealthFinding) => record.state === "resolved"
      break
    case DOMAINS.notificationEndpoints:
      break // Disabling an endpoint does not discard its saved configuration.
    case DOMAINS.customizations:
      // Upgrade policies store documented setting keys, not customization record IDs.
      // Active customizations remain configuration; retired ones have no record references.
      closed = (record: CustomizationRecord) => record.status === "retired"
      break
    case DOMAINS.scoreSnapshots:
      closed = () => true
      break
    case DOMAINS.customBaselineDeployments: {
      const baselines = context.all<BaselineRecord>(DOMAINS.customBaselines)
      if (!baselines) return () => true
      for (const record of states(baselines)) for (const deployment of record.deployments ?? []) pin(deployment.deploymentId)
      for (const record of changeStates()) if (record.origin?.workflow === "custom-baseline") pin(record.origin.recordId)
      closed = (record: DeploymentRecord) => record.status === "rolled-back" || record.status === "rejected" || (record.status === "failed" && !record.changeSetId)
      break
    }
    case DOMAINS.customBaselineComparisons: {
      const parents = new Set(context.list<BaselineRecord>(DOMAINS.customBaselines).filter(record => record.kind === "baseline").map(record => record.id))
      closed = (record: CustomComparison) => !parents.has(record.baselineId)
      break
    }
  }
  return record => referenced.has(record.id) || !closed(record)
}
