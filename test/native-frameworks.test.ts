import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectNativeEvidence, evidenceUrl, graphEvidenceReader, removeSecretEvidence } from '../src/main/frameworks/collector'
import { handleNativeFramework, setNativeFrameworkAuthorization, setNativeFrameworkNotifier, setNativeFrameworkStore, validateAssessmentScope, type NativeJobSummary } from '../src/main/frameworks/native'
import { assessCompliance, complianceFrameworks }  from '../src/shared/compliance/engine'
import { COMPLIANCE_CAPABILITIES } from '../src/shared/compliance/capabilities'
import { COMPLIANCE_DETECTOR_VERSION } from '../src/shared/compliance/detector-version'
import { frameworks } from '../src/shared/frameworks/catalog'
import { requiredFeatures } from '../src/main/api/plan-gates'
import { createEvidenceManifest, frameworkRulesetSha256 } from '../src/shared/compliance/manifest'
import { ISO_27001, SOC_2, BSI_IT_GRUNDSCHUTZ, DEF_STAN_05_138 } from '../src/shared/compliance'
import { readFileSync, cpSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkFrameworkRights } from '../scripts/check-framework-rights'
import { handleFramework } from '../src/main/frameworks/service'
import { compareNativeAssessments, nativeChecksCSV, type NativeAssessment } from '../src/shared/compliance/native'

afterEach(() => vi.unstubAllGlobals())
describe('native collector and rights boundaries', () => {
  it.each([
    ['deviceCompliancePolicies', 'deviceManagement/deviceCompliancePolicies/compliance?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations)'],
    ['compliancePolicies', 'deviceManagement/compliancePolicies/compliance'],
  ])('collects expanded actions through the exact %s request', async (collection, detailEndpoint) => {
    const base = `deviceManagement/${collection}`
    const actions = [{ scheduledActionConfigurations: [{ actionType: 'block', gracePeriodHours: 24 }] }]
    const get = vi.fn(async (path: string) => {
      expect(path).toBe(detailEndpoint)
      return { id: 'compliance', '@odata.type': '#microsoft.graph.windows10CompliancePolicy', bitLockerEnabled: true,
        ...(collection === 'deviceCompliancePolicies' ? { scheduledActionsForRule: actions } : {}),
      }
    })
    const list = vi.fn(async (path: string) => {
      if (path === `${base}?$select=id`) return [{ id: 'compliance' }]
      if (path === `${base}/compliance/assignments`) return [{ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }]
      if (path === `${base}/compliance/settings`) return []
      if (path === `${base}/compliance/scheduledActionsForRule?$expand=scheduledActionConfigurations` && collection === 'compliancePolicies') return actions
      // Other families have no policies; unexpected requests within this family fail the assertions below.
      return []
    })
    const data = await collectNativeEvidence({ get, list }, false)
    expect(get.mock.calls).toEqual([[detailEndpoint]])
    expect(list.mock.calls.filter(([path]) => path.startsWith(base))).toEqual([
      [`${base}?$select=id`],
      ...(collection === 'compliancePolicies' ? [[`${base}/compliance/settings`]] : []),
      [`${base}/compliance/assignments`],
      ...(collection === 'compliancePolicies' ? [[`${base}/compliance/scheduledActionsForRule?$expand=scheduledActionConfigurations`]] : []),
    ])
    expect(data.fetchErrors).toEqual([])
    expect(data.compliancePolicies).toHaveLength(1)
    expect(data.compliancePolicies[0]).toMatchObject({ scheduledActionsForRule: actions, collectionStatus: { scheduledActionsForRule: 'complete' } })
    expect(assessCompliance(data).capabilities.find(cap => cap.capability.id === 'windows-disk-encryption')?.status).toBe('requirementAssigned')
  })

  it.each(['deviceCompliancePolicies', 'compliancePolicies'])('keeps %s scheduled-action failures unknown', async collection => {
    const base = `deviceManagement/${collection}`
    const endpoint = collection === 'deviceCompliancePolicies'
      ? `${base}/compliance?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations)`
      : `${base}/compliance/scheduledActionsForRule?$expand=scheduledActionConfigurations`
    const data = await collectNativeEvidence({ get: async path => {
      if (path === endpoint) throw new Error('400 expand unavailable')
      return { id: 'compliance', '@odata.type': '#microsoft.graph.windows10CompliancePolicy', bitLockerEnabled: true }
    }, list: async path => {
      if (path === `${base}?$select=id`) return [{ id: 'compliance' }]
      if (path === endpoint) throw new Error('400 expand unavailable')
      if (path.endsWith('/assignments')) return [{ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }]
      return []
    } })
    expect(data.fetchErrors?.[0]?.endpoint).toBe(endpoint)
    expect(data.compliancePolicies[0]?.collectionStatus.scheduledActionsForRule).toBe('incomplete')
    const result = assessCompliance(data).capabilities.find(cap => cap.capability.id === 'windows-disk-encryption')!
    expect(result.status).not.toBe('requirementAssigned')
    expect(result.checks.some(check => check.assessmentStatus === 'unableToCheck')).toBe(true)
  })

  it('marks a missing classic entity expand incomplete', async () => {
    const data = await collectNativeEvidence({ get: async () => ({ id: 'compliance', '@odata.type': '#microsoft.graph.windows10CompliancePolicy', bitLockerEnabled: true }), list: async path => {
      if (path === 'deviceManagement/deviceCompliancePolicies?$select=id') return [{ id: 'compliance' }]
      if (path.endsWith('/assignments')) return [{ target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } }]
      return []
    } })
    expect(data.compliancePolicies[0]?.collectionStatus.scheduledActionsForRule).toBe('incomplete')
    expect(data.fetchErrors?.[0]?.endpoint).toBe('deviceManagement/deviceCompliancePolicies/compliance?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations)')
    expect(assessCompliance(data).capabilities.find(cap => cap.capability.id === 'windows-disk-encryption')?.checks.some(check => check.assessmentStatus === 'unableToCheck')).toBe(true)
  })

  it('hashes only the selected framework and its mapped capabilities, independently of scope', async () => {
    const iso = structuredClone(ISO_27001)
    const before = await frameworkRulesetSha256(iso)
    const capabilities = structuredClone(COMPLIANCE_CAPABILITIES)
    const unused = capabilities.find(cap => !iso.mappings[cap.id]?.length)!
    unused.description = 'Unrelated capability update'
    iso.mappings[unused.id] = []
    expect(await frameworkRulesetSha256(iso, capabilities)).toBe(before)
    capabilities.find(cap => iso.mappings[cap.id]?.length)!.description = 'Mapped capability update'
    expect(await frameworkRulesetSha256(iso, capabilities)).not.toBe(before)
    iso.controls['8.1']!.summary = 'Selected mapping update'
    expect(await frameworkRulesetSha256(iso)).not.toBe(before)
    const collected = await collectNativeEvidence({ get: async () => ({}), list: async () => [] })
    const all = await createEvidenceManifest(collected, {}, ISO_27001.id)
    const windows = await createEvidenceManifest(collected, { platforms: ['windows'] }, ISO_27001.id)
    expect(all.rulesetSha256).toBe(windows.rulesetSha256)
    expect(all.rulesetSha256).not.toBe((await createEvidenceManifest(collected, {}, SOC_2.id)).rulesetSha256)
    const previousVersion = SOC_2.version
    try {
      SOC_2.version = 'Unrelated framework update'
      expect((await createEvidenceManifest(collected, {}, ISO_27001.id)).rulesetSha256).toBe(all.rulesetSha256)
    } finally { SOC_2.version = previousVersion }
  })

  it('changes the same ruleset input exactly once when the detector version moves to 2', async () => {
    expect(COMPLIANCE_DETECTOR_VERSION).toBeGreaterThanOrEqual(2)
    const hashes = await Promise.all([1, 2, 2].map(version => frameworkRulesetSha256(ISO_27001, COMPLIANCE_CAPABILITIES, version)))
    expect(hashes[0]).not.toBe(hashes[1])
    expect(hashes[1]).toBe(hashes[2])
    expect(new Set(hashes).size).toBe(2)
  })

  it('saves tenant-isolated results and exports the stored PDF without another Graph read', async () => {
    const values = new Map<string, string>()
    setNativeFrameworkStore({ get: k => values.get(k) ?? null, set: (k, v) => { values.set(k, v) }, delete: k => { values.delete(k) } })
    setNativeFrameworkAuthorization(async () => {})
    const fetch = vi.fn(async (input: unknown) => String(input).includes('login.microsoftonline.com') ? Response.json({ access_token: 'mock-token' }) : Response.json({ value: [] }))
    vi.stubGlobal('fetch', fetch)
    const body = { tenantId: '11111111-1111-1111-1111-111111111111', appId: '22222222-2222-2222-2222-222222222222', frameworkId: 'iso-27001' }
    const assessed = await (await handleNativeFramework({ ...body, action: 'native-assess' })).json()
    expect(assessed.run.assessment.frameworks).toHaveLength(1)
    const calls = fetch.mock.calls.length
    const response = await handleNativeFramework({ ...body, action: 'native-pdf', runId: assessed.run.runId })
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    expect(fetch.mock.calls).toHaveLength(calls)
    await expect(handleNativeFramework({ ...body, action: 'native-pdf', tenantId: '33333333-3333-3333-3333-333333333333', runId: assessed.run.runId })).rejects.toMatchObject({ status: 404 })
    await handleNativeFramework({ ...body, action: 'native-delete', runId: assessed.run.runId })
    expect((await (await handleNativeFramework({ ...body, action: 'native-history' })).json()).history).toEqual([])
    setNativeFrameworkAuthorization(async () => { throw new Error('Denied') })
    await expect(handleNativeFramework({ ...body, action: 'native-history' })).rejects.toThrow('Denied')
  })
  it('offers all ten source frameworks for Community and blocks both CIS paths', async () => {
    expect(frameworks.filter(f => f.nativeId)).toHaveLength(10)
    for (const framework of frameworks.filter(f => f.nativeId)) for (const action of ['native-assess', 'native-history', 'native-pdf']) expect(requiredFeatures('/api/frameworks', { action, frameworkId: framework.id })).toEqual([])
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    for (const frameworkId of ['cis-benchmarks', 'cis-controls']) await expect(handleNativeFramework({ action: 'native-assess', frameworkId })).rejects.toMatchObject({ status: 403 })
    for (const action of ['assess', 'create']) await expect(handleFramework({ action, frameworkId: 'iso-27001' })).rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('fails packaging for changed or unreviewed framework content', () => {
    const root = mkdtempSync(join(tmpdir(), 'framework-rights-')); mkdirSync(join(root, 'src/shared'), { recursive: true }); mkdirSync(join(root, 'resources'))
    try {
      cpSync('src/shared/compliance', join(root, 'src/shared/compliance'), { recursive: true }); cpSync('resources/framework-NOTICES.txt', join(root, 'resources/framework-NOTICES.txt'))
      expect(() => checkFrameworkRights(root)).not.toThrow()
      for (const name of ['nist-csf.ts', 'essential-eight-requirements.json']) {
        const file = join(root, 'src/shared/compliance/frameworks', name)
        writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'))
      }
      expect(() => checkFrameworkRights(root)).not.toThrow()
      writeFileSync(join(root, 'src/shared/compliance/frameworks/cis.ts'), 'uncleared')
      expect(() => checkFrameworkRights(root)).toThrow('no reviewed rights entry')
      rmSync(join(root, 'src/shared/compliance/frameworks/cis.ts'))
      writeFileSync(join(root, 'src/shared/compliance/frameworks/iso-27001.ts'), 'changed')
      expect(() => checkFrameworkRights(root)).toThrow('Review content rights')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('keeps restricted publisher text out of distributed definitions and packages source notices', () => {
    for (const framework of [ISO_27001, SOC_2, BSI_IT_GRUNDSCHUTZ, DEF_STAN_05_138]) for (const control of Object.values(framework.controls)) {
      expect(control.title).toBe(`Endpoint evidence mapping ${control.id}`)
      expect(control.summary).toContain('Check selection and expected values are our interpretation.')
    }
    expect(readFileSync('resources/framework-NOTICES.txt', 'utf8')).toContain('Elastic License 2.0')
  })
  it('rejects cross-origin and cross-collection continuation links and loops', async () => {
    expect(() => evidenceUrl('https://evil.example/beta/deviceManagement/configurationPolicies')).toThrow('Invalid')
    expect(() => evidenceUrl('deviceManagement/deviceConfigurations', 'deviceManagement/configurationPolicies')).toThrow('Invalid')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/beta/deviceManagement/configurationPolicies' })))
    await expect(graphEvidenceReader('token').list('deviceManagement/configurationPolicies')).rejects.toThrow('repeated')
  })
  it('retains settings when assignment reads fail and reports collection gaps', async () => {
    const data = await collectNativeEvidence({ get: async () => ({ id: 'policy', name: 'Policy', settingCount: 0 }), list: async path => {
      if (path === 'deviceManagement/configurationPolicies?$select=id') return [{ id: 'policy' }]
      if (path.endsWith('/assignments')) throw new Error('403 assignments denied')
      return []
    } }, false)
    expect(data.settingsCatalog[0].settings).toEqual([])
    expect(data.settingsCatalog[0].collectionStatus.assignments).toBe('incomplete')
    expect(assessCompliance(data).capabilities.some(c => c.status === 'collectionIncomplete')).toBe(true)
    expect(data.collectionSkippedFamilies).toContain('conditionalAccessPolicies')
  })
  it('marks masked OMA-URI values unavailable without recovering or exporting secrets', () => {
    const policy = removeSecretEvidence({ id: 'secret', '@odata.type': '#microsoft.graph.windows10CustomConfiguration', omaSettings: [{ omaUri: './Device/Vendor/MSFT/BitLocker/RequireDeviceEncryption', value: '****', isEncrypted: true, secretReferenceValueId: 'secret-ref' }] })
    expect(JSON.stringify(policy)).not.toContain('secret-ref')
    const result = assessCompliance({ settingsCatalog: [], deviceConfigurations: [policy], administrativeTemplates: [], compliancePolicies: [], securityBaselines: [], scripts: { windows: [], macOS: [] }, collectedAt: new Date().toISOString() }).capabilities.find(c => c.capability.id === 'windows-disk-encryption')!
    expect(result.checks.some(c => c.assessmentStatus === 'unableToCheck')).toBe(true)
    expect(result.checks.some(c => c.result === 'matches')).toBe(false)
  })
  it('accepts opaque Graph policy IDs and preserves their settings', async () => {
    const data = await collectNativeEvidence({ get: async () => ({ id: 'T_policy-id' }), list: async path => path === 'deviceAppManagement/windowsManagedAppProtections?$select=id' ? [{ id: 'T_policy-id' }] : [] })
    expect(data.appProtectionPolicies?.[0].id).toBe('T_policy-id')
    expect(data.fetchErrors).toEqual([])
  })
  it('validates scope and fingerprints the snapshot independently of scope', async () => {
    expect(() => validateAssessmentScope({ platforms: [], essentialEightMaturityLevel: 3, defStanRiskLevel: 1 })).toThrow('valid')
    expect(() => validateAssessmentScope({ platforms: ['windows'], essentialEightMaturityLevel: '3', defStanRiskLevel: 1 })).toThrow('valid')
    const data = await collectNativeEvidence({ get: async () => ({}), list: async () => [] })
    const a = await createEvidenceManifest(data)
    const b = await createEvidenceManifest({ ...data, assessmentScope: { platforms: ['windows'] } })
    expect(a.snapshotSha256).toBe(b.snapshotSha256)
    expect(a.rulesetSha256).toBe(b.rulesetSha256)
    expect(a.snapshotSha256).toMatch(/^[a-f0-9]{64}$/)
    const run: NativeAssessment = { schemaVersion: 1, runId: 'one', tenantId: 'tenant', frameworkId: 'iso-27001', sourceCommit: 'source', snapshotSha256: a.snapshotSha256, rulesetSha256: a.rulesetSha256, licenseNotice: '', assessment: a.assessment }
    expect(compareNativeAssessments(run, structuredClone(run))).toEqual([])
    expect(() => compareNativeAssessments(run, { ...run, rulesetSha256: 'changed' })).toThrow('ruleset changed')
    const changed = structuredClone(run); changed.assessment.capabilities[0]!.checks[0]!.actualValue = '=SUM(A1)'
    expect(compareNativeAssessments(run, changed).length).toBe(1)
    expect(nativeChecksCSV(changed)).toContain("'=SUM(A1)")
  })
})

describe('background native comparisons', () => {
  const body = { tenantId: '44444444-4444-4444-4444-444444444444', appId: '22222222-2222-2222-2222-222222222222', frameworkId: 'nist-csf' }
  const jobsOf = async () => (await (await handleNativeFramework({ action: 'native-jobs' })).json()).jobs as NativeJobSummary[]
  const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 200 && !await check(); i++) await new Promise(r => setTimeout(r, 5)) }

  it('runs in the background with progress, saves the result and notifies once', async () => {
    const values = new Map<string, string>()
    setNativeFrameworkStore({ get: k => values.get(k) ?? null, set: (k, v) => { values.set(k, v) }, delete: k => { values.delete(k) } })
    setNativeFrameworkAuthorization(async () => {})
    const finished: NativeJobSummary[] = []
    setNativeFrameworkNotifier(job => finished.push(job))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input).includes('login.microsoftonline.com')) return Response.json({ access_token: 'mock-token' })
      await gate
      return Response.json({ value: [] })
    }))
    const { job } = await (await handleNativeFramework({ ...body, action: 'native-start' })).json()
    expect(job.status).toBe('running')
    // A second start while running returns the same job instead of a duplicate collection.
    expect((await (await handleNativeFramework({ ...body, action: 'native-start' })).json()).job.jobId).toBe(job.jobId)
    await until(async () => (await jobsOf()).find(j => j.jobId === job.jobId)?.step === 'collecting')
    const progress = (await jobsOf()).find(j => j.jobId === job.jobId)!
    expect(progress.detail).toMatch(/^Reading settings catalog policies \(1 of \d+\)/)
    expect(progress.percent).toBeGreaterThan(0)
    release()
    await until(async () => (await jobsOf()).find(j => j.jobId === job.jobId)?.status === 'completed')
    const done = (await jobsOf()).find(j => j.jobId === job.jobId)!
    expect(done.percent).toBe(100)
    const history = (await (await handleNativeFramework({ ...body, action: 'native-history' })).json()).history
    expect(history[0].runId).toBe(done.runId)
    expect(finished.map(j => j.status)).toEqual(['completed'])
  })

  it('cancels a running comparison without saving it', async () => {
    const values = new Map<string, string>()
    setNativeFrameworkStore({ get: k => values.get(k) ?? null, set: (k, v) => { values.set(k, v) }, delete: k => { values.delete(k) } })
    setNativeFrameworkAuthorization(async () => {})
    const finished: NativeJobSummary[] = []
    setNativeFrameworkNotifier(job => finished.push(job))
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('login.microsoftonline.com')) return Response.json({ access_token: 'mock-token' })
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }))
    const { job } = await (await handleNativeFramework({ ...body, frameworkId: 'soc2', action: 'native-start' })).json()
    await until(async () => (await jobsOf()).find(j => j.jobId === job.jobId)?.step === 'collecting')
    await handleNativeFramework({ ...body, frameworkId: 'soc2', action: 'native-cancel', jobId: job.jobId })
    await until(async () => (await jobsOf()).find(j => j.jobId === job.jobId)?.status !== 'running')
    expect((await jobsOf()).find(j => j.jobId === job.jobId)?.status).toBe('cancelled')
    expect((await (await handleNativeFramework({ ...body, frameworkId: 'soc2', action: 'native-history' })).json()).history).toEqual([])
    expect(finished.map(j => j.status)).toEqual(['cancelled'])
  })

  it('keeps older comparisons readable but identifies current scores and the reset notice', async () => {
    const values = new Map<string, string>()
    setNativeFrameworkStore({ get: k => values.get(k) ?? null, set: (k, v) => { values.set(k, v) }, delete: k => { values.delete(k) } })
    setNativeFrameworkAuthorization(async () => {})
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).includes('login.microsoftonline.com') ? Response.json({ access_token: 'mock-token' }) : Response.json({ value: [] })))
    const { run } = await (await handleNativeFramework({ ...body, action: 'native-assess' })).json()
    const old = structuredClone(run)
    old.runId = 'old'
    delete old.assessment.provenance.detectorVersion
    old.rulesetSha256 = 'old-ruleset'
    const changed = { ...run, runId: 'changed', rulesetSha256: 'different-ruleset' }
    values.set(`framework.native.v1.${body.tenantId}.${body.frameworkId}`, JSON.stringify([run, old, changed]))
    const history = await (await handleNativeFramework({ ...body, action: 'native-history' })).json()
    expect(history.history).toHaveLength(3)
    expect(history.currentRunIds).toEqual([run.runId])
    expect(history.scoringChanged).toBe(true)
    expect(run.rulesetSha256).toBe(await frameworkRulesetSha256(complianceFrameworks().find(item => item.id === 'nist-csf-2')!))
    values.set(`framework.native.v1.${body.tenantId}.${body.frameworkId}`, JSON.stringify([run]))
    expect((await (await handleNativeFramework({ ...body, action: 'native-history' })).json()).scoringChanged).toBe(false)
  })

  it('sets unreadable history aside instead of blocking the framework', async () => {
    const values = new Map<string, string>([[`framework.native.v1.${body.tenantId}.iso-27001`, '{broken']])
    setNativeFrameworkStore({ get: k => values.get(k) ?? null, set: (k, v) => { values.set(k, v) }, delete: k => { values.delete(k) } })
    setNativeFrameworkAuthorization(async () => {})
    const first = await (await handleNativeFramework({ ...body, frameworkId: 'iso-27001', action: 'native-history' })).json()
    expect(first.history).toEqual([])
    expect(first.notice).toMatch(/set aside/)
    expect([...values].find(([k]) => k.startsWith(`framework.native.v1.${body.tenantId}.iso-27001.unreadable.`))?.[1]).toBe('{broken')
    expect((await (await handleNativeFramework({ ...body, frameworkId: 'iso-27001', action: 'native-history' })).json()).notice).toBeUndefined()
  })
})

describe('ruleset hash inputs', () => {
  it('ignores source verification metadata and reacts to mapping changes', async () => {
    const base = await frameworkRulesetSha256(ISO_27001)
    const reverified = { ...ISO_27001, source: { url: ISO_27001.source?.url ?? 'https://example.invalid', verifiedAt: '2099-01-01T00:00:00Z' } }
    expect(await frameworkRulesetSha256(reverified)).toBe(base)
    const [firstId, firstControls] = Object.entries(ISO_27001.mappings).find(([, controls]) => controls.length)!
    const remapped = { ...ISO_27001, mappings: { ...ISO_27001.mappings, [firstId]: firstControls.slice(1) } }
    expect(await frameworkRulesetSha256(remapped)).not.toBe(base)
  })
})
