import { buildRestorePlan, restoreBlocker } from './restore-plan'
import { unresolvedDependencies } from './dependencies'
import type { IntuneType, Item } from './registry'
export interface RecoveryReadiness { automatic: boolean; externalArtifacts: string[]; missingMappings: string[]; manualActions: string[] }
export function recoveryReadiness(type: IntuneType, snapshot: Item): RecoveryReadiness {
  const blocker = restoreBlocker(type, snapshot), externalArtifacts: string[] = [], manualActions: string[] = []
  let missingMappings: string[] = []
  if (blocker) {
    manualActions.push(blocker)
    if (/installer|token|certificate|secret|content/i.test(blocker)) externalArtifacts.push('Recover the original installer, signing material or service token from its authorized owner; upload or renew it in Intune before mapping the resulting object.')
    else if (/hardware hash/i.test(blocker)) externalArtifacts.push("Recover the device's hardware hash, from the file used to import it or from its OEM or reseller, and import the device again in Intune.")
  } else {
    try {
      const source = structuredClone(snapshot); delete source.assignments; delete source.roleAssignments; if (source.roleScopeTagIds) source.roleScopeTagIds = ['0']
      const plan = buildRestorePlan(type, source, { includeAssignments: false })
      missingMappings = [...new Set([plan.create, ...plan.steps].flatMap(step => unresolvedDependencies(step.body, new Set()))) ]
    } catch (error) { manualActions.push(error instanceof Error ? error.message : String(error)) }
  }
  if (Array.isArray(snapshot.assignments) && snapshot.assignments.length) manualActions.push('Cross-tenant copies are unassigned. Recreate group targeting, exclusions and filters in the target tenant after review.')
  if (type.folder === 'RoleDefinitions') manualActions.push('Review role membership separately; restoring role assignments can reinstate revoked access.')
  return { automatic: !blocker && !missingMappings.length && !manualActions.length, externalArtifacts, missingMappings, manualActions }
}
export interface DependencyMapping { folder: 'Apps' | 'AppCategories'; sourceId: string; targetId: string }
export function parseDependencyMappings(value: unknown): DependencyMapping[] {
  if (value === undefined) return []
  const guid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
  if (!Array.isArray(value) || value.length > 100) throw new Error('Supply at most 100 dependency mappings')
  const seen = new Set<string>()
  return value.map(item => {
    if (!item || !['Apps', 'AppCategories'].includes(item.folder) || typeof item.sourceId !== 'string' || typeof item.targetId !== 'string' || !guid.test(item.sourceId) || !guid.test(item.targetId) || seen.has(item.sourceId.toLowerCase())) throw new Error('Mappings require a unique source GUID, target GUID and supported folder (Apps or AppCategories)')
    seen.add(item.sourceId.toLowerCase()); return { folder: item.folder, sourceId: item.sourceId, targetId: item.targetId }
  })
}

export function reviewedDependencyMappings(json: string, confirmed: boolean, targetCount: number): DependencyMapping[] {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('Dependency mappings must be valid JSON') }
  const mappings = parseDependencyMappings(value)
  if (mappings.length && (!confirmed || targetCount !== 1)) throw new Error('Confirm the reviewed mappings and select exactly one target tenant')
  return mappings
}
