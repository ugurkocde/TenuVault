import { expect, it, vi } from 'vitest'
import { compareUpgrade, getComparison } from '../src/main/features/baseline-upgrades/service'
import { DOMAINS } from '../src/main/features/domains'
import { fakeDeps, fakeOibSources, TENANT_A } from './feature-helpers'

it.each([false, true])('publishes linked upgrade evidence atomically, with a failed comparison: %s', async fail => {
  const deps = fakeDeps()
  const install = deps.records.create(DOMAINS.baselineInstalls, TENANT_A, {
    kind: 'install', status: 'tracked', origin: { type: 'quickstart', runId: 'run' }, platform: 'windows', commit: 'a'.repeat(40), reference: 'Installed release', sourceId: null, policies: [], customizationVersion: 1,
  }, { actor: null, reason: 'Stored install' })
  const commit = 'b'.repeat(40)
  const sources = fakeOibSources([{ platform: 'windows', commit, reference: 'New release', source: '', license: 'GPL-3.0', items: [] }])
  const write = vi.spyOn(deps.store, 'setMany')
  const create = deps.records.create.bind(deps.records)
  const kinds: unknown[] = []
  vi.spyOn(deps.records, 'create').mockImplementation((domain, tenantId, value, meta) => {
    kinds.push(domain === DOMAINS.baselineUpgrades ? 'upgrade' : (value as { kind?: string }).kind)
    if (fail && (value as { kind?: string }).kind === 'comparison') throw new Error('Comparison storage failed')
    return create(domain, tenantId, value, meta)
  })
  const comparison = compareUpgrade(deps, sources, TENANT_A, install.id, commit, null)
  if (fail) {
    await expect(comparison).rejects.toThrow('Comparison storage failed')
    expect(deps.records.list(DOMAINS.baselineUpgrades, TENANT_A)).toHaveLength(0)
    expect(deps.records.list<{ kind: string }>(DOMAINS.baselineInstalls, TENANT_A).some(record => record.kind === 'comparison')).toBe(false)
    expect(write).not.toHaveBeenCalled()
  } else {
    const upgrade = await comparison
    expect(getComparison(deps, TENANT_A, upgrade.comparisonId).upgradeId).toBe(upgrade.id)
    expect(write).toHaveBeenCalledTimes(1)
  }
  expect(kinds.slice(-2)).toEqual(['upgrade', 'comparison'])
})
