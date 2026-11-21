import { sameSnapshot } from "../../../shared/intune/compare"
import type { IntuneType, Item } from "../../../shared/intune/registry"
import { diffConfigurations } from '../../../main/features/change-sets/model'
import { diffDefinitionIds } from '../../../shared/frameworks/cis-display'
import { cachedVerifiedSettingIds } from '../drift/setting-names'
import { graphPropertyNames } from './graph-property-schema'
import { settingId } from './projection'
import type { AuditChange } from './types'

const actionFields: Record<string, readonly string[]> = {
  Apps: ['relationships'],
  CompliancePolicies: ['deviceComplianceScheduledActionForRules'],
  ComplianceSettingsPolicies: ['scheduledActions', 'scheduledActionsForRule', 'settings'],
  ConfigurationPolicies: ['settings'],
  EndpointSecurityIntents: ['settings', 'settingsDelta'],
  GroupPolicyConfigurations: ['definitionValues'],
  NotificationTemplates: ['localizedNotificationMessages'],
}

export function auditChanges(
  type: IntuneType, operation: AuditChange['operation'], body: Item, baseline: Item | undefined, includeCatalogIds = false,
): AuditChange[] {
  const properties = graphPropertyNames(type.folder, body['@odata.type'] ?? baseline?.['@odata.type'])
  const fields = Object.keys(body).filter(field => field !== 'settingDefinitionId'
    && (properties.has(field) || actionFields[type.folder]?.includes(field))
    && (!baseline || !sameSnapshot(body[field], baseline[field])))
  const changes: AuditChange[] = fields.sort().map(field => ({ operation, field }))
  if (includeCatalogIds && fields.includes('settings') && ['ConfigurationPolicies', 'ComplianceSettingsPolicies'].includes(type.folder)) {
    try {
      // Compare only the settings included in this write. Omitted PATCH properties stay unchanged.
      const before = { settings: baseline?.settings ?? [] }
      const diff = diffConfigurations(type, before, { settings: body.settings ?? [] })
      const ids = [...new Set(diff.entries.flatMap(diffDefinitionIds).filter(settingId))].sort().slice(0, 128)
      const verifiedIds = cachedVerifiedSettingIds(ids)
      changes.push(...verifiedIds.map(settingDefinitionId => ({ operation, settingDefinitionId, catalogVerified: true as const })))
    } catch { /* The parent settings field remains available if the diff or lookup fails. */ }
  }
  return changes.length ? changes : [{ operation }]
}
