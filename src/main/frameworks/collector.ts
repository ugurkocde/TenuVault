import type { DetailedExportData } from '../../shared/compliance/input'
import { record, type RecordJson } from '../../shared/frameworks/policies'
import { retryDelay, sleep } from '../graph-retry'
import { FrameworkError } from './service'

/** Only evidence-bearing policy families. This collector has no mutation or secret-recovery path. */
export const EVIDENCE_FAMILIES = [
  { family: 'settingsCatalog', label: 'Settings catalog policies', path: 'deviceManagement/configurationPolicies', children: ['settings', 'assignments'] },
  { family: 'deviceConfigurations', label: 'Device configuration profiles', path: 'deviceManagement/deviceConfigurations', children: ['assignments'] },
  { family: 'administrativeTemplates', label: 'Administrative templates', path: 'deviceManagement/groupPolicyConfigurations', children: ['definitionValues', 'assignments'] },
  { family: 'compliancePolicies', label: 'Compliance policies', path: 'deviceManagement/deviceCompliancePolicies', children: ['assignments', 'scheduledActionsForRule'] },
  { family: 'compliancePolicies', label: 'Settings catalog compliance policies', path: 'deviceManagement/compliancePolicies', children: ['settings', 'assignments', 'scheduledActionsForRule'] },
  { family: 'securityBaselines', label: 'Security baselines', path: 'deviceManagement/intents', children: ['settings', 'assignments'] },
  { family: 'appProtectionPolicies', label: 'iOS app protection policies', path: 'deviceAppManagement/iosManagedAppProtections', children: ['assignments'] },
  { family: 'appProtectionPolicies', label: 'Android app protection policies', path: 'deviceAppManagement/androidManagedAppProtections', children: ['assignments'] },
  { family: 'appProtectionPolicies', label: 'Windows app protection policies', path: 'deviceAppManagement/windowsManagedAppProtections', children: ['assignments'] },
  { family: 'windowsUpdatePolicies', label: 'Feature update profiles', path: 'deviceManagement/windowsFeatureUpdateProfiles', children: ['assignments'] },
  { family: 'windowsUpdatePolicies', label: 'Quality update profiles', path: 'deviceManagement/windowsQualityUpdateProfiles', children: ['assignments'] },
  { family: 'conditionalAccessPolicies', label: 'Conditional Access policies', path: 'identity/conditionalAccess/policies', children: [] },
] as const

/** Where a collection is: the policy type being read and how many of its policies are done. */
export interface CollectionProgress {
  label: string
  familyIndex: number
  familyCount: number
  policiesRead: number
  policyCount: number
}

export interface CollectionOptions {
  onProgress?: (progress: CollectionProgress) => void
  signal?: AbortSignal
}

export interface EvidenceReader {
  get(path: string): Promise<RecordJson>
  list(path: string): Promise<RecordJson[]>
}

export function evidenceUrl(path: string, collection?: string): string {
  const url = new URL(path, 'https://graph.microsoft.com/beta/')
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash ||
    !EVIDENCE_FAMILIES.some(spec => url.pathname === `/beta/${spec.path}` || url.pathname.startsWith(`/beta/${spec.path}/`)) ||
    (collection && url.pathname !== new URL(collection, 'https://graph.microsoft.com/beta/').pathname))
    throw new FrameworkError('Invalid Graph evidence URL or continuation link.', 502)
  return url.href
}

export function graphEvidenceReader(token: string, signal?: AbortSignal): EvidenceReader {
  async function get(path: string): Promise<RecordJson> {
    const url = evidenceUrl(path)
    for (let attempt = 0; attempt < 4; attempt++) {
      const timeout = AbortSignal.timeout(60_000)
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      if ([429, 503].includes(response.status) && attempt < 3) {
        let delay: number
        try {
          delay = retryDelay(response, attempt)
        } catch {
          throw new FrameworkError(`Graph throttled the evidence read (${response.status}). Retry later.`, 502)
        }
        await sleep(delay, signal)
        continue
      }
      if (!response.ok) throw new FrameworkError(`Evidence read failed (${response.status}) at ${new URL(url).pathname}.`, response.status)
      const body: unknown = await response.json()
      if (!record(body)) throw new FrameworkError('Graph returned invalid evidence.', 502)
      return body
    }
    throw new FrameworkError('Evidence read failed after retries.', 502)
  }
  return { get, async list(path) {
    const initial = evidenceUrl(path)
    let next = initial
    const visited = new Set<string>()
    const rows: RecordJson[] = []
    while (next) {
      next = evidenceUrl(next, initial)
      if (visited.has(next) || visited.size >= 100 || rows.length >= 10_000) throw new FrameworkError('Evidence pagination is repeated or exceeds the read limit.', 502)
      visited.add(next)
      const page = await get(next)
      if (!Array.isArray(page.value) || !page.value.every(record)) throw new FrameworkError('Graph returned an incomplete evidence collection.', 502)
      rows.push(...page.value)
      if (rows.length > 10_000) throw new FrameworkError('Evidence collection exceeds the read limit.', 502)
      if (page['@odata.nextLink'] != null && typeof page['@odata.nextLink'] !== 'string') throw new FrameworkError('Invalid evidence continuation link.', 502)
      next = page['@odata.nextLink'] as string || ''
    }
    return rows
  } }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Evidence could not be read.' }

/** Masked or encrypted OMA-URI data is never considered a comparison value. */
export function removeSecretEvidence(policy: RecordJson): RecordJson {
  const copy = structuredClone(policy)
  if (Array.isArray(copy.omaSettings)) copy.omaSettings = copy.omaSettings.map(value => {
    if (!record(value)) return value
    if (value.isEncrypted === true || value.value === '****' || value.secretReferenceValueId) {
      const safe = { ...value }
      delete safe.value
      delete safe.secretReferenceValueId
      return safe
    }
    return value
  })
  return copy
}

export async function collectNativeEvidence(reader: EvidenceReader, includeAccessPolicies = true, { onProgress, signal }: CollectionOptions = {}): Promise<DetailedExportData> {
  const data: DetailedExportData = {
    collectionStartedAt: new Date().toISOString(), settingsCatalog: [], deviceConfigurations: [],
    administrativeTemplates: [], compliancePolicies: [], securityBaselines: [], appProtectionPolicies: [],
    windowsUpdatePolicies: [], conditionalAccessPolicies: [], scripts: { windows: [], macOS: [] },
    collectionSkippedFamilies: ['scripts', 'appConfigurations', 'enrollmentConfigurations'], fetchErrors: [],
  }
  const specs = EVIDENCE_FAMILIES.filter(spec => spec.family !== 'conditionalAccessPolicies' || includeAccessPolicies)
  if (!includeAccessPolicies) data.collectionSkippedFamilies!.push('conditionalAccessPolicies')
  for (const [familyIndex, spec] of specs.entries()) {
    signal?.throwIfAborted()
    const report = (policiesRead: number, policyCount: number) => onProgress?.({ label: spec.label, familyIndex, familyCount: specs.length, policiesRead, policyCount })
    report(0, 0)
    const fail = (id: string, name: string, endpoint: string, error: unknown) => data.fetchErrors!.push({
      policyId: id, policyName: name, policyType: spec.family, familyKey: spec.family, endpoint,
      error: errorMessage(error), statusCode: error instanceof FrameworkError ? error.status : undefined, partial: true,
    })
    let list: RecordJson[]
    try { list = await reader.list(`${spec.path}?$select=id`) }
    catch (error) { signal?.throwIfAborted(); fail('', spec.family, spec.path, error); continue }
    report(0, list.length)
    for (let i = 0; i < list.length; i += 4) {
      signal?.throwIfAborted()
      const rows = await Promise.all(list.slice(i, i + 4).map(async item => {
        if (typeof item.id !== 'string' || !/^[a-z0-9_-]{1,200}$/i.test(item.id)) { fail('', 'Unknown policy', spec.path, new Error('Invalid policy ID.')); return null }
        const path = `${spec.path}/${encodeURIComponent(item.id)}`
        // Classic compliance actions are only routable through the policy entity expand.
        const classicCompliance = spec.path === 'deviceManagement/deviceCompliancePolicies'
        const detailEndpoint = classicCompliance ? `${path}?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations)` : path
        let detail: RecordJson
        let actionsExpandError: { error: unknown } | undefined
        try { detail = await reader.get(detailEndpoint) }
        catch (error) {
          if (!classicCompliance) { fail(item.id, item.id, detailEndpoint, error); return null }
          // Preserve policy settings and assignments when only the actions expand fails.
          actionsExpandError = { error }
          try { detail = await reader.get(path); delete detail.scheduledActionsForRule }
          catch (error) { fail(item.id, item.id, path, error); return null }
        }
        const name = String(detail.name ?? detail.displayName ?? item.id)
        detail.collectionStatus = {}
        for (const child of spec.children) {
          const expandedActions = classicCompliance && child === 'scheduledActionsForRule'
          const endpoint = expandedActions ? detailEndpoint : `${path}/${child}${child === 'definitionValues' ? '?$expand=definition' : child === 'scheduledActionsForRule' ? '?$expand=scheduledActionConfigurations' : ''}`
          try {
            if (expandedActions && actionsExpandError) throw actionsExpandError.error
            const values = expandedActions ? detail[child] : await reader.list(endpoint)
            if (!Array.isArray(values) || !values.every(record)) throw new Error('Graph returned an incomplete evidence collection.')
            if (child === 'definitionValues') for (const value of values) {
              if (typeof value.id !== 'string' || !/^[a-z0-9_-]{1,200}$/i.test(value.id)) throw new Error('Invalid definition value ID.')
              value.presentationValues = await reader.list(`${path}/definitionValues/${value.id}/presentationValues?$expand=presentation`)
            }
            if (child === 'settings' && typeof detail.settingCount === 'number' && detail.settingCount !== values.length) throw new Error('Policy changed during collection. Compare again.')
            detail[child] = values
            ;(detail.collectionStatus as RecordJson)[child] = 'complete'
          } catch (error) {
            ;(detail.collectionStatus as RecordJson)[child] = 'incomplete'
            fail(item.id, name, endpoint, error)
          }
        }
        if (spec.family === 'conditionalAccessPolicies') detail['@odata.type'] = '#microsoft.graph.conditionalAccessPolicy'
        return removeSecretEvidence(detail)
      }))
      data[spec.family]!.push(...rows.filter(row => row !== null))
      report(Math.min(i + 4, list.length), list.length)
    }
  }
  data.collectedAt = new Date().toISOString()
  return data
}
