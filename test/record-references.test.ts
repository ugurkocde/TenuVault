import { expect, it } from 'vitest'
import { TenantRecords, RECORD_RETENTION, SHARED_SCOPE } from '../src/main/features/records'
import { DOMAINS } from '../src/main/features/domains'
import { getVersion, type BaselineRecord, type VersionRecord, type RebaseRecord } from '../src/main/features/custom-baselines/service'
import { compareUpgrade, getBaselineSource, getComparison, sourcePolicies, storeBaselineSource } from '../src/main/features/baseline-upgrades/service'
import { memoryStore } from './helpers'
import { fakeDeps, fakeOibSources, TENANT_A, TENANT_B } from './feature-helpers'

const meta = { actor: null, reason: 'Retention regression' }
const at = '2026-01-01T00:00:00Z'
function record<T extends object>(id: string, value: T, updatedAt = at) {
  const base = { ...value, id, tenantId: TENANT_A, createdAt: at, updatedAt }
  return { ...base, history: [{ at, actor: null, reason: 'Stored before upgrade', snapshot: base }] }
}
function fixture() {
  const store = memoryStore()
  const records = new TenantRecords(store, () => new Date('2026-10-01'))
  const seed = (domain: string, values: object[], scope = TENANT_A) => store.set(`records.v1.${domain}.${scope}`, JSON.stringify(values))
  const fill = (domain: string, protectedRecords: object[], closed: object) => seed(domain, [...protectedRecords, ...Array.from({ length: RECORD_RETENTION[domain]! - protectedRecords.length }, (_, i) => record(`closed-${i}`, closed, '2026-02-01T00:00:00Z'))])
  return { store, records, seed, fill }
}

it('keeps all three content records of 334 surviving change sets and refuses further content', () => {
  const { records, seed, store } = fixture()
  const sets = Array.from({ length: 334 }, (_, i) => {
    const set = record(`set-${i}`, { kind: 'change', status: 'applied', proposalId: `proposal-${i}`, preChange: { captureId: `capture-${i}` } })
    set.history.unshift({ ...set.history[0]!, snapshot: { ...set.history[0]!.snapshot, proposalId: `previous-${i}` } })
    return set
  })
  seed(DOMAINS.changeSets, sets)
  const content = sets.flatMap((set, i) => ['proposal', 'capture', 'previous'].map(kind => record(`${kind}-${i}`, { kind: kind === 'capture' ? 'capture' : 'proposal', status: 'frozen', changeSetId: kind === 'capture' ? set.id : null, entries: {} })))
  seed(DOMAINS.changeSetContent, content)
  const before = store.get(`records.v1.${DOMAINS.changeSetContent}.${TENANT_A}`)
  expect(records.list(DOMAINS.changeSetContent, TENANT_A)).toHaveLength(1002)
  expect(() => records.create(DOMAINS.changeSetContent, TENANT_A, { kind: 'proposal', status: 'frozen', changeSetId: null }, meta)).toThrow('too many stored records')
  expect(store.get(`records.v1.${DOMAINS.changeSetContent}.${TENANT_A}`)).toBe(before)
  for (const value of content) expect(records.get(DOMAINS.changeSetContent, TENANT_A, value.id)).toEqual(value)
})

it.each(['in-review', 'approved', 'stale', 'applying', 'applied', 'partial', 'uncertain', 'failed'])('refuses the 501st change set without losing %s recovery state', status => {
  const { records, seed } = fixture()
  const original = record('original', { kind: 'change', status, proposalId: 'proposal', preChange: { captureId: 'capture' } })
  seed(DOMAINS.changeSets, [original, record('rollback', { kind: 'rollback', status: 'in-review', rollbackOf: original.id }), ...Array.from({ length: 498 }, (_, i) => record(`active-${i}`, { kind: 'change', status: 'applied' }))])
  expect(() => records.create(DOMAINS.changeSets, TENANT_A, { kind: 'change', status: 'in-review' }, meta)).toThrow('too many stored records')
  expect(records.get(DOMAINS.changeSets, TENANT_A, original.id)).toEqual(original)
  expect(records.get(DOMAINS.changeSets, TENANT_A, 'rollback')).toBeTruthy()
})

it('prunes rejected unreferenced change sets while preserving a completed rollback link', () => {
  const { records, fill } = fixture()
  fill(DOMAINS.changeSets, [record('original', { kind: 'change', status: 'applied' }), record('rollback', { kind: 'rollback', status: 'applied', rollbackOf: 'original' })], { kind: 'change', status: 'rejected' })
  records.create(DOMAINS.changeSets, TENANT_A, { kind: 'change', status: 'in-review' }, meta)
  expect(records.get(DOMAINS.changeSets, TENANT_A, 'original')).toBeTruthy()
  expect(records.get(DOMAINS.changeSets, TENANT_A, 'rollback')).toBeTruthy()
  expect(records.get(DOMAINS.changeSets, TENANT_A, 'closed-0')).toBeNull()
})

it('keeps a never-updated custom version and rebase before their newer surviving baseline', () => {
  const { records, fill } = fixture()
  fill(DOMAINS.customBaselines, [record('version', { kind: 'version', status: 'frozen', baselineId: 'baseline', version: 1 }), record('rebase', { kind: 'rebase', status: 'applied', baselineId: 'baseline' }), record('baseline', { kind: 'baseline', status: 'active', versions: [{ version: 1, versionId: 'version' }], deployments: [] }, '2026-09-01T00:00:00Z')], { kind: 'version', status: 'frozen', baselineId: 'removed' })
  records.create(DOMAINS.customBaselines, TENANT_A, { kind: 'version', status: 'frozen', baselineId: 'baseline' }, meta)
  const deps = fakeDeps({ records })
  const baseline = records.get<BaselineRecord>(DOMAINS.customBaselines, TENANT_A, 'baseline')!
  expect(getVersion(deps, TENANT_A, baseline, 1).id).toBe('version')
  expect(records.get(DOMAINS.customBaselines, TENANT_A, 'rebase')).toBeTruthy()
})

it('keeps install sources, derived sources and upgrade comparisons while their parents survive', () => {
  const { records, fill, seed } = fixture()
  fill(DOMAINS.baselineInstalls, [record('source', { kind: 'source', status: 'frozen', derivedFrom: 'base' }), record('base', { kind: 'source', status: 'frozen' }), record('comparison', { kind: 'comparison', status: 'frozen' }), record('install', { kind: 'install', status: 'tracked', sourceId: 'source', lastUpgradeId: 'upgrade', policies: [] }, '2026-09-01T00:00:00Z')], { kind: 'source', status: 'frozen' })
  seed(DOMAINS.baselineUpgrades, [record('upgrade', { status: 'applied', installId: 'install', comparisonId: 'comparison', from: { sourceId: 'base' }, to: { sourceId: 'source' }, policies: [], batches: [] })])
  records.create(DOMAINS.baselineInstalls, TENANT_A, { kind: 'source', status: 'frozen' }, meta)
  const deps = fakeDeps({ records })
  expect(getBaselineSource(deps, TENANT_A, 'source').id).toBe('source')
  expect(getBaselineSource(deps, TENANT_A, 'base').id).toBe('base')
  expect(getComparison(deps, TENANT_A, 'comparison').id).toBe('comparison')
})

it.each([false, true])('keeps custom baseline source content at a full cap, with references only in revisions: %s', revisionsOnly => {
  const { records, fill, seed } = fixture()
  const sources = ['snapshot-source', 'version-source', 'summary-source', 'rebase-source'].map(id => record(id, { kind: 'source', status: 'frozen', origin: 'snapshot', policies: [{ key: id, snapshot: { name: id, settings: [] } }] }))
  fill(DOMAINS.baselineInstalls, sources, { kind: 'source', status: 'frozen' })
  seed(DOMAINS.customBaselines, [
    record('baseline', { kind: 'baseline', status: 'active', origin: 'snapshot', provenance: { sourceId: 'snapshot-source' }, versions: [{ base: { sourceId: 'summary-source' } }] }),
    record('version', { kind: 'version', status: 'frozen', baselineId: 'baseline', base: { sourceId: 'version-source' } }),
    record('rebase', { kind: 'rebase', status: 'ready', baselineId: 'baseline', upstream: { sourceId: 'rebase-source' } }),
  ])
  if (revisionsOnly) {
    records.update<BaselineRecord>(DOMAINS.customBaselines, TENANT_A, 'baseline', current => ({ ...current, provenance: { ...current.provenance, sourceId: null }, versions: current.versions.map(version => ({ ...version, base: { ...version.base, sourceId: null } })) }), meta)
    records.update<VersionRecord>(DOMAINS.customBaselines, TENANT_A, 'version', current => ({ ...current, base: { ...current.base, sourceId: null } }), meta)
    records.update<RebaseRecord>(DOMAINS.customBaselines, TENANT_A, 'rebase', current => ({ ...current, upstream: { ...current.upstream, sourceId: null } }), meta)
  }
  expect(records.list(DOMAINS.baselineInstalls, TENANT_A)).toHaveLength(RECORD_RETENTION[DOMAINS.baselineInstalls]!)
  records.create(DOMAINS.baselineInstalls, TENANT_A, { kind: 'source', status: 'frozen' }, meta)
  const deps = fakeDeps({ records })
  for (const source of sources) expect(getBaselineSource(deps, TENANT_A, source.id)).toEqual(source)
  expect(records.get(DOMAINS.baselineInstalls, TENANT_A, 'closed-0')).toBeNull()
})

it.each([0, 5])('updates 600 protected change sets above the cap and trims %s closed records without refusing the update', closedCount => {
  const { records, seed, store } = fixture()
  const protectedRecords = Array.from({ length: 600 }, (_, i) => record(`applied-${i}`, { kind: 'change', status: 'applied', proposalId: `proposal-${i}`, preChange: { captureId: `capture-${i}` } }))
  seed(DOMAINS.changeSets, [...protectedRecords, ...Array.from({ length: closedCount }, (_, i) => record(`closed-${i}`, { kind: 'change', status: 'rejected' }))])
  const updated = records.update<{ status: string; summary?: string }>(DOMAINS.changeSets, TENANT_A, 'applied-0', current => ({ ...current, summary: 'Synced after upgrade' }), meta)
  expect(updated?.summary).toBe('Synced after upgrade')
  expect(updated?.history).toHaveLength(2)
  expect(updated?.history[0]).toEqual(protectedRecords[0]!.history[0])
  const kept = records.list(DOMAINS.changeSets, TENANT_A)
  expect(kept).toHaveLength(600)
  expect(kept.slice(1)).toEqual(protectedRecords.slice(1))
  const beforeCreate = store.get(`records.v1.${DOMAINS.changeSets}.${TENANT_A}`)
  expect(() => records.create(DOMAINS.changeSets, TENANT_A, { kind: 'change', status: 'in-review' }, meta)).toThrow('too many stored records')
  expect(store.get(`records.v1.${DOMAINS.changeSets}.${TENANT_A}`)).toBe(beforeCreate)
})

it('treats documented upgrade values as setting keys rather than customization record IDs', () => {
  const { records, fill, seed } = fixture()
  fill(DOMAINS.customizations, [record('setting-key', { status: 'retired', settingKey: 'other-setting' }), record('active', { status: 'active', settingKey: 'setting-key' })], { status: 'retired', settingKey: 'unused' })
  seed(DOMAINS.baselineUpgrades, [record('upgrade', { status: 'applied', policies: [{ documented: ['setting-key'] }] })])
  records.create(DOMAINS.customizations, TENANT_A, { status: 'active', settingKey: 'new-setting' }, meta)
  expect(records.get(DOMAINS.customizations, TENANT_A, 'setting-key')).toBeNull()
  expect(records.get(DOMAINS.customizations, TENANT_A, 'active')).toBeTruthy()
})

it.each([false, true])('pins a reused old source and saves upgrade evidence atomically at a full cap, with no removable records: %s', async protectedOnly => {
  const { records, fill, store } = fixture()
  const deps = fakeDeps({ records })
  const commit = 'b'.repeat(40)
  const pack = { platform: 'windows' as const, commit, reference: 'Reused upstream', source: '', license: 'GPL-3.0', items: [] }
  const upstream = storeBaselineSource(deps, TENANT_A, { origin: 'oib', platform: pack.platform, commit, reference: pack.reference, frameworkId: null, policies: sourcePolicies(pack.items) }, null)
  fill(DOMAINS.baselineInstalls, [
    { ...upstream, updatedAt: at },
    record('install', { kind: 'install', status: 'tracked', origin: { type: 'quickstart', runId: 'run' }, platform: 'windows', commit: 'a'.repeat(40), reference: 'Installed release', sourceId: null, policies: [], customizationVersion: 1 }),
    ...Array.from({ length: protectedOnly ? RECORD_RETENTION[DOMAINS.baselineInstalls]! - 2 : 0 }, (_, i) => record(`other-install-${i}`, { kind: 'install', status: 'tracked', sourceId: upstream.id, policies: [] })),
  ], { kind: 'source', status: 'frozen' })
  if (protectedOnly) {
    const before = new Map(store.values)
    await expect(compareUpgrade(deps, fakeOibSources([pack]), TENANT_A, 'install', commit, null)).rejects.toThrow('too many stored records')
    expect(store.values).toEqual(before)
    expect(records.list(DOMAINS.baselineUpgrades, TENANT_A)).toHaveLength(0)
    return
  }
  const upgrade = await compareUpgrade(deps, fakeOibSources([pack]), TENANT_A, 'install', commit, null)
  expect(upgrade.to.sourceId).toBe(upstream.id)
  expect(getBaselineSource(deps, TENANT_A, upgrade.to.sourceId).policies).toEqual(upstream.policies)
  expect(getComparison(deps, TENANT_A, upgrade.comparisonId).upgradeId).toBe(upgrade.id)
  expect(records.list(DOMAINS.baselineInstalls, TENANT_A)).toHaveLength(RECORD_RETENTION[DOMAINS.baselineInstalls]!)
  expect(records.get(DOMAINS.baselineInstalls, TENANT_A, 'closed-0')).toBeNull()
})

it('keeps shared versions referenced by any persisted adoption, pending state, previous state or revision', () => {
  const { seed, store } = fixture()
  seed(DOMAINS.standards, Array.from({ length: 1000 }, (_, i) => record(`version-${i}`, { standardKey: 'standard', version: i, status: 'published', previousVersionId: null })), SHARED_SCOPE)
  const adoption = record('adoption', { status: 'adopted', versionId: 'version-0', adoptedVersionId: 'version-1', pending: { versionId: 'version-2' }, previousAdopted: { versionId: 'version-3' } })
  adoption.history.unshift({ ...adoption.history[0]!, snapshot: { ...adoption.history[0]!.snapshot, versionId: 'version-4' } })
  seed(DOMAINS.adoptions, [adoption], TENANT_B)
  // Reopen the records service to ensure this does not depend on which tenants were visited.
  const fresh = new TenantRecords(store)
  fresh.create(DOMAINS.standards, SHARED_SCOPE, { standardKey: 'standard', version: 1000, status: 'published', previousVersionId: null }, meta)
  for (let i = 0; i <= 4; i++) expect(fresh.get(DOMAINS.standards, SHARED_SCOPE, `version-${i}`)).toBeTruthy()
  expect(fresh.get(DOMAINS.standards, SHARED_SCOPE, 'version-5')).toBeNull()
})

it.each(['in-review', 'approved', 'applying', 'applied', 'partial', 'uncertain'])('keeps promotions in %s', status => {
  const { records, fill } = fixture()
  fill(DOMAINS.promotions, [record('promotion', { status })], { status: 'rejected' })
  records.create(DOMAINS.promotions, TENANT_A, { status: 'in-review' }, meta)
  expect(records.get(DOMAINS.promotions, TENANT_A, 'promotion')).toBeTruthy()
})

it.each(['acknowledged', 'false-positive'])('keeps hygiene %s decisions and their scan evidence', action => {
  const { records, fill } = fixture()
  fill(DOMAINS.hygieneFindings, [record('decision', { kind: 'finding', status: 'resolved', review: { action }, scanId: 'scan' }), record('scan', { kind: 'scan', status: 'complete' })], { kind: 'finding', status: 'resolved', review: null })
  records.create(DOMAINS.hygieneFindings, TENANT_A, { kind: 'scan', status: 'complete' }, meta)
  expect(records.get<{ review: { action: string } }>(DOMAINS.hygieneFindings, TENANT_A, 'decision')?.review.action).toBe(action)
  expect(records.get(DOMAINS.hygieneFindings, TENANT_A, 'scan')).toBeTruthy()
})

it('does not trim over-cap data on upgrade reads and trims only closed unreferenced records on a write', () => {
  const { records, seed, store } = fixture()
  seed(DOMAINS.changeSets, [record('applied', { status: 'applied' }), ...Array.from({ length: 504 }, (_, i) => record(`old-${i}`, { status: 'rejected' }))])
  const before = store.get(`records.v1.${DOMAINS.changeSets}.${TENANT_A}`)
  expect(records.list(DOMAINS.changeSets, TENANT_A)).toHaveLength(505)
  expect(records.get(DOMAINS.changeSets, TENANT_A, 'old-0')).toBeTruthy()
  expect(store.get(`records.v1.${DOMAINS.changeSets}.${TENANT_A}`)).toBe(before)
  records.create(DOMAINS.changeSets, TENANT_A, { status: 'in-review' }, meta)
  expect(records.list(DOMAINS.changeSets, TENANT_A)).toHaveLength(500)
  expect(records.get(DOMAINS.changeSets, TENANT_A, 'applied')).toBeTruthy()
  expect(records.get(DOMAINS.changeSets, TENANT_A, 'old-5')).toBeNull()
})

it('keeps active configuration and open findings, and refuses unknown domains at their existing cap', () => {
  for (const [domain, value] of [[DOMAINS.notificationEndpoints, { status: 'disabled' }], [DOMAINS.healthFindings, { state: 'open' }], [DOMAINS.adoptions, { status: 'adopted' }], ['future-records', { status: 'closed' }]] as const) {
    const { records, seed } = fixture()
    seed(domain, Array.from({ length: RECORD_RETENTION[domain] ?? 2000 }, (_, i) => record(String(i), value)))
    expect(() => records.create(domain, TENANT_A, value, meta)).toThrow('too many stored records')
  }
})


it('keeps custom baseline comparisons and deployments while their baseline survives', () => {
  const { records, fill, seed } = fixture()
  seed(DOMAINS.customBaselines, [record('baseline', { kind: 'baseline', status: 'active', versions: [], deployments: [{ deploymentId: 'deployment' }] })])
  fill(DOMAINS.customBaselineComparisons, [record('comparison', { kind: 'tenant', baselineId: 'baseline' })], { kind: 'tenant', baselineId: 'removed' })
  records.create(DOMAINS.customBaselineComparisons, TENANT_A, { kind: 'tenant', baselineId: 'baseline' }, meta)
  expect(records.get(DOMAINS.customBaselineComparisons, TENANT_A, 'comparison')).toBeTruthy()
  fill(DOMAINS.customBaselineDeployments, [record('deployment', { status: 'rolled-back', baselineId: 'baseline' })], { status: 'rejected' })
  records.create(DOMAINS.customBaselineDeployments, TENANT_A, { status: 'change-set', baselineId: 'baseline' }, meta)
  expect(records.get(DOMAINS.customBaselineDeployments, TENANT_A, 'deployment')).toBeTruthy()
})

it('removes orphaned closed content while retaining content attached to a pending parent', () => {
  const { records, seed, fill } = fixture()
  seed(DOMAINS.changeSets, [record('pending', { status: 'applying', proposalId: 'proposal', preChange: null })])
  fill(DOMAINS.changeSetContent, [record('capture', { kind: 'capture', changeSetId: 'pending', status: 'frozen' }), record('proposal', { kind: 'proposal', changeSetId: null, status: 'frozen' })], { kind: 'proposal', changeSetId: null, status: 'frozen' })
  records.create(DOMAINS.changeSetContent, TENANT_A, { kind: 'proposal', changeSetId: null, status: 'frozen' }, meta)
  expect(records.get(DOMAINS.changeSetContent, TENANT_A, 'capture')).toBeTruthy()
  expect(records.get(DOMAINS.changeSetContent, TENANT_A, 'proposal')).toBeTruthy()
  expect(records.get(DOMAINS.changeSetContent, TENANT_A, 'closed-0')).toBeNull()
})

it('refuses shared version pruning when the store cannot enumerate persisted adoption scopes', () => {
  const { store, seed } = fixture()
  seed(DOMAINS.standards, Array.from({ length: 1000 }, (_, i) => record(String(i), { standardKey: 'standard', version: i, status: 'published' })), SHARED_SCOPE)
  const { keys: _keys, ...withoutKeys } = store
  const records = new TenantRecords(withoutKeys)
  expect(() => records.create(DOMAINS.standards, SHARED_SCOPE, { standardKey: 'standard', version: 1000, status: 'published' }, meta)).toThrow('too many stored records')
  expect(records.list(DOMAINS.standards, SHARED_SCOPE)).toHaveLength(1000)
})


it('keeps a version and its deployment referenced across tenant scopes', () => {
  const { records, seed, fill } = fixture()
  seed(DOMAINS.customBaselineDeployments, [record('deployment', { status: 'applied', baselineId: 'baseline', baselineTenantId: TENANT_A, version: 1 })], TENANT_B)
  fill(DOMAINS.customBaselines, [record('version', { kind: 'version', status: 'frozen', baselineId: 'baseline', version: 1 })], { kind: 'version', status: 'frozen', baselineId: 'removed' })
  records.create(DOMAINS.customBaselines, TENANT_A, { kind: 'version', status: 'frozen', baselineId: 'new' }, meta)
  expect(records.get(DOMAINS.customBaselines, TENANT_A, 'version')).toBeTruthy()
  seed(DOMAINS.customBaselines, [record('baseline', { kind: 'baseline', status: 'active', deployments: [{ deploymentId: 'deployment', targetTenantId: TENANT_B }] })])
  const deployments = Array.from({ length: 499 }, (_, i) => record(`closed-${i}`, { status: 'rejected' }))
  seed(DOMAINS.customBaselineDeployments, [record('deployment', { status: 'rolled-back' }), ...deployments], TENANT_B)
  records.create(DOMAINS.customBaselineDeployments, TENANT_B, { status: 'change-set' }, meta)
  expect(records.get(DOMAINS.customBaselineDeployments, TENANT_B, 'deployment')).toBeTruthy()
})
