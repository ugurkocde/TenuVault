import type { Item, Json } from './registry'

// Service-wide definitions are portable. Tenant objects must have a target mapping.
const PORTABLE_IDS = new Set(['templateId', 'settingDefinitionId', 'definitionId', 'presentationId', 'bundleId', 'packageId', 'productId'])

/** One reference to another tenant object inside an outbound payload. */
export interface DependencyReference {
  /** Where in the payload the reference sits, for example "snapshot.items[0].payloadId". */
  path: string
  /** The property that holds the reference, for example "payloadId" or "@odata.id". */
  key: string
  /** The referenced object ID, taken from the value or from a bind URL. */
  id: string
  /** The full bind URL, when the reference is an "@odata.id" or "@odata.bind" value. */
  url?: string
}

/** Every reference to another tenant object in the actual outbound payload. */
export function dependencyReferences(body: Item): DependencyReference[] {
  const references: DependencyReference[] = []
  const check = (value: Json, key: string, path: string): void => {
    if (Array.isArray(value)) { value.forEach((entry, index) => check(entry, key, `${path}[${index}]`)); return }
    if (value && typeof value === 'object') {
      for (const [child, entry] of Object.entries(value)) check(entry, child, `${path}.${child}`)
      return
    }
    if (typeof value !== 'string' || !value || value === '0') return
    if (PORTABLE_IDS.has(key)) return
    if (key === '@odata.id' || key.endsWith('@odata.bind')) {
      // ADMX definitions and their presentations are Microsoft service-wide objects.
      if (value.startsWith('https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions')) return
      const id = value.match(/(?:\/|\(')([^/'()]+)(?:'\))?$/)?.[1]
      references.push({ path, key, id: id ?? '', url: value })
    } else if (/(?:Id|Ids)$/.test(key)) {
      references.push({ path, key, id: value })
    }
  }
  check(body, '', 'snapshot')
  return references
}

/** Validate the actual outbound payload, after read-only data and assignments were removed. */
export function unresolvedDependencies(body: Item, targetIds: ReadonlySet<string>): string[] {
  const unresolved = new Set<string>()
  for (const reference of dependencyReferences(body)) {
    if (!reference.id || !targetIds.has(reference.id)) unresolved.add(reference.path)
  }
  return [...unresolved]
}
