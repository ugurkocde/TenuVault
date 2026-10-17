import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Download, ExternalLink, FileJson, FileSpreadsheet, History, Info, LoaderCircle, X } from 'lucide-react'
import { cn } from '~/lib/utils'
import { useSelectedTenant } from '~/contexts/TenantContext'
import type { Framework } from '../../shared/frameworks/catalog'
import { FRAMEWORK_USAGE_NOTICE, capabilityComparison, comparisonCounts, compareNativeAssessments, type NativeAssessment } from '../../shared/compliance/native'
import { collectionReadGaps } from '../../shared/compliance/counted'
import { allows } from '../../shared/plans'
import type { AssessmentScope, CapabilityResult, CapabilityStatus, CompliancePlatform, TechnicalCheck } from '../../shared/compliance/types'
import { CAPABILITY_STATUS_LABELS, CHECK_RESULT_LABELS, COLLECTION_FAMILY_LABELS, COLLECTION_STATUS_LABELS, CONTROL_STATUS_LABELS, PLATFORM_LABELS, frameworkCoverageLabel } from '../../shared/compliance/presentation'
import { displayCheckValue } from '../../shared/compliance/check-results'
import { ComplianceScoringNotice } from '../components/ComplianceScoringNotice'
import { useConfirm } from "~/components/ConfirmDialog"
import { cancelFrameworkJob, startFrameworkJob, useFrameworkJob } from '../lib/framework-jobs'
import { startBackgroundTask, useBackgroundTasks } from '../lib/background-tasks'
import { useTenantPlan } from '../lib/license'
import { formatScore, freshData, loadDetail } from '../features/scores/api'
import { invalidateScores } from '../features/scores/invalidate'

const button = 'inline-flex h-10 items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50'
const small = cn(button, 'h-8 px-3 text-xs')
const primary = cn(button, 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90')
const card = 'rounded-3xl bg-white p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)] lg:p-7'
const disclosure = cn(card, 'group [&[open]_.chevron]:rotate-180')
const summaryRow = 'flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden'

const platforms: CompliancePlatform[] = ['windows', 'macos', 'ios', 'android', 'tenant']
const platformLabels = PLATFORM_LABELS as Record<CompliancePlatform, string>
type ResultKey = keyof typeof CHECK_RESULT_LABELS
const labels = CHECK_RESULT_LABELS
type Tone = 'good' | 'warn' | 'bad' | 'neutral'
const resultTone: Record<ResultKey, Tone> = { matches: 'good', different: 'warn', missing: 'bad', unableToCheck: 'neutral', outsideScope: 'neutral' }
const toneText: Record<Tone, string> = { good: 'text-green-700', warn: 'text-amber-800', bad: 'text-red-700', neutral: 'text-gray-600' }
const tonePill: Record<Tone, string> = { good: 'bg-green-50 text-green-800', warn: 'bg-amber-50 text-amber-800', bad: 'bg-red-50 text-red-800', neutral: 'bg-gray-100 text-gray-700' }
const capabilityTone: Record<CapabilityStatus, Tone> = {
  enforced: 'good', requirementAssigned: 'good', configuredNotAssigned: 'warn', disabledByPolicy: 'warn', noEvidence: 'bad', assignmentUnknown: 'warn',
  conflictingEvidence: 'warn', partialConfiguration: 'warn', collectionIncomplete: 'warn', notApplicable: 'neutral',
}

async function request<T>(body: object): Promise<T> {
  const response = await fetch('/api/frameworks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `Framework request failed (${response.status}).`)
  return value
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function checkKey(check: TechnicalCheck): ResultKey {
  return check.assessmentStatus === 'checked' ? check.result ?? 'unableToCheck' : check.assessmentStatus
}
function elapsed(since: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
const dismissedJobs = new Set<string>()

export default function NativeFrameworkPage({ framework }: { framework: Framework }) {
  const { confirm, confirmDialog } = useConfirm()
  const { selectedTenant } = useSelectedTenant()
  const credentials = selectedTenant?.credentials
  const [scope, setScope] = useState<AssessmentScope>({ platforms, essentialEightMaturityLevel: 1, defStanRiskLevel: 1 })
  const [history, setHistory] = useState<NativeAssessment[]>([])
  const [loaded, setLoaded] = useState(false)
  const [run, setRun] = useState<NativeAssessment | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [persistent, setPersistent] = useState(false)
  const [scoringChanged, setScoringChanged] = useState(false)
  const [currentRunIds, setCurrentRunIds] = useState<string[] | null>(null)
  const [provider, setProvider] = useState<{ edition: string; sourceContentLicense: string; contentMode: string; strategies: string[] } | null>(null)
  const [changes, setChanges] = useState<{ base: NativeAssessment; rows: ReturnType<typeof compareNativeAssessments> } | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | ResultKey>('all')
  const [, setDismissed] = useState(0)
  const job = useFrameworkJob(credentials?.tenantId, framework.id)
  const running = job?.status === 'running'
  const shownRun = useRef<string | undefined>(undefined)
  const body = { tenantId: credentials?.tenantId, appId: credentials?.appId, frameworkId: framework.id }
  // The main process builds every export from the saved run, redacted, without reading the tenant again.
  // Building runs as a background task, so a slow export finishes and downloads even after
  // navigating away; the activity panel shows it meanwhile.
  const exportKey = (format: 'pdf' | 'csv' | 'json', runId: string) => `export:${framework.id}:${runId}:${format}`
  const exportRun = (format: 'pdf' | 'csv' | 'json', runId: string) => {
    const requestBody = { ...body, tenantName: selectedTenant?.name, action: `native-${format}`, runId }
    startBackgroundTask(exportKey(format, runId), { title: `${framework.name} ${format.toUpperCase()} export`, detail: `Building the ${format.toUpperCase()} export`, href: `/portal/frameworks/${framework.id}`, tenantId: credentials?.tenantId }, async () => {
      const response = await fetch('/api/frameworks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) })
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? 'Export failed.')
      download(await response.blob(), `${framework.id}-${runId}.${format}`)
      return `${framework.name} ${format.toUpperCase()} export downloaded.`
    })
  }
  const backgroundTasks = useBackgroundTasks()
  const exportingFormat = (format: 'pdf' | 'csv' | 'json', runId: string) =>
    backgroundTasks.some(task => task.id === exportKey(format, runId) && task.status === 'running')

  useEffect(() => {
    let active = true
    void request<{ rights: NonNullable<typeof provider> }>({ action: 'native-info', frameworkId: framework.id }).then(value => { if (active) setProvider(value.rights) }).catch(() => {})
    return () => { active = false }
  }, [framework.id])

  async function loadHistory(select?: string) {
    const value = await request<{ history: NativeAssessment[]; persistent: boolean; notice?: string; scoringChanged?: boolean; currentRunIds?: string[] }>({ ...body, action: 'native-history' })
    setScoringChanged(value.scoringChanged === true)
    setCurrentRunIds(Array.isArray(value.currentRunIds) ? value.currentRunIds : null)
    setHistory(value.history); setPersistent(value.persistent); setLoaded(true)
    if (value.notice) setError(value.notice)
    setRun(current => value.history.find(item => item.runId === (select ?? current?.runId)) ?? value.history[0] ?? null)
    if (!select && value.history[0]) applyScopeOf(value.history[0])
  }
  // The scope controls follow the comparison on screen, so Compare again repeats it.
  function applyScopeOf(item: NativeAssessment) {
    const saved = item.assessment.scope
    if (saved.platforms?.length) setScope({ platforms: [...saved.platforms], essentialEightMaturityLevel: saved.essentialEightMaturityLevel ?? 1, defStanRiskLevel: saved.defStanRiskLevel ?? 1 })
  }
  useEffect(() => {
    if (!credentials?.tenantId) return
    shownRun.current = job?.runId
    void loadHistory().catch(e => setError(e instanceof Error ? e.message : 'History unavailable.'))
  }, [credentials?.tenantId, framework.id])

  // A comparison that finishes while this page is open (or while the admin was elsewhere) shows its result.
  useEffect(() => {
    if (job?.status !== 'completed' || !job.runId || shownRun.current === job.runId) return
    shownRun.current = job.runId
    setChanges(null)
    void loadHistory(job.runId).catch(e => setError(e instanceof Error ? e.message : 'History unavailable.'))
  }, [job?.status, job?.runId])

  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  async function perform(label: string, work: () => Promise<void>) {
    setBusy(label); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : 'The request failed.') } finally { setBusy('') }
  }
  const start = () => void perform('Starting comparison', async () => {
    if (!credentials) return
    const started = await startFrameworkJob({ tenantId: credentials.tenantId, appId: credentials.appId, frameworkId: framework.id, scope })
    dismissedJobs.add(job?.jobId ?? '')
    shownRun.current = started.runId
  })
  const togglePlatform = (platform: CompliancePlatform) => setScope(s => ({ ...s, platforms: s.platforms?.includes(platform) ? s.platforms.filter(x => x !== platform) : [...(s.platforms ?? []), platform] }))

  const result = run?.assessment.frameworks[0]
  const counts = run ? comparisonCounts(run) : null
  // The baseline score of the comparison on screen, read from /api/scores like the Governance card, on plans that include scores.
  const client = useQueryClient()
  const plan = useTenantPlan(credentials?.tenantId)
  const scoring = plan !== null && allows(plan, 'baselineScores')
  const score = useQuery({ queryKey: ['scores-detail', credentials?.tenantId, framework.id, run?.runId], queryFn: () => loadDetail(selectedTenant!, framework.id, run!.runId), enabled: scoring && !!run && !!selectedTenant, retry: false })
  const scoreData = freshData(score)
  const readGaps = run ? collectionReadGaps(run.assessment.collectionCoverage) : []
  const olderRules = (item: NativeAssessment) => currentRunIds !== null && !currentRunIds.includes(item.runId)
  const term = query.trim().toLowerCase()
  const matches = run?.assessment.capabilities.filter(cap =>
    (!term || `${cap.capability.name} ${cap.capability.id} ${cap.checks.map(c => `${c.settingId} ${c.policyName ?? ''}`).join(' ')}`.toLowerCase().includes(term)) &&
    (status === 'all' || capabilityComparison(cap) === status)) ?? []
  const failedJob = job && (job.status === 'failed' || job.status === 'cancelled') && !dismissedJobs.has(job.jobId) ? job : null
  const disabledReason = !credentials ? 'Select a signed-in tenant in the sidebar to compare its settings.' : !scope.platforms?.length ? 'Select at least one platform.' : ''

  return <div className="mx-auto max-w-6xl space-y-5 p-6 lg:p-8">
    {confirmDialog}
    <nav aria-label="Breadcrumb" className="text-sm text-gray-500"><Link className="text-blue-700 hover:underline" to="/portal/frameworks">Frameworks</Link><span className="mx-2" aria-hidden="true">/</span><span aria-current="page">{framework.name}</span></nav>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        <p className="text-xs font-medium text-gray-500">{framework.publisher} · Independent mapping · Community</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-gray-950">{framework.name}</h1>
        <p className="mt-2 text-gray-600">{framework.description}</p>
      </div>
      <a href={framework.source} target="_blank" rel="noreferrer" className={button}>Publisher reference <ExternalLink className="size-4" aria-hidden="true" /></a>
    </header>

    <details className={cn(disclosure, 'bg-blue-50/60 py-4 lg:py-4')}>
      <summary className={summaryRow}>
        <span className="flex items-center gap-3 text-sm"><Info className="size-4 shrink-0 text-blue-700" aria-hidden="true" /><span><strong className="font-medium text-gray-900">About this comparison</strong><span className="text-gray-600"> · What is compared, content sources and limits. No tenant settings are changed.</span></span></span>
        <ChevronDown className="chevron size-4 shrink-0 text-gray-500 transition-transform" aria-hidden="true" />
      </summary>
      <div className="mt-4 space-y-2 border-t border-blue-100 pt-4 text-sm leading-6 text-gray-700">
        <p>{FRAMEWORK_USAGE_NOTICE}</p>
        {framework.licenseNotice && <p>{framework.licenseNotice}</p>}
        {provider && <p>Edition: {provider.edition}. Content: {provider.contentMode === 'independent-reference' ? 'original descriptions and factual references' : 'attributed open material'}. {provider.sourceContentLicense}.</p>}
        {!!provider?.strategies.length && <p>Strategies: {provider.strategies.join(', ')}. Only strategies with supported policy detectors produce configuration checks. Operational patching, account processes and backup recovery require evidence outside this comparison.</p>}
        <p>Selected Intune configuration and optional Conditional Access policies only. Expected values, control selection and supported platforms are shown with the results. A failed or unavailable read stays visible as a collection gap.</p>
      </div>
    </details>

    <ComplianceScoringNotice key={credentials?.tenantId} changed={scoringChanged} />

    {error && <p role="alert" className="flex items-start justify-between gap-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800"><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={() => setError('')}><X className="size-4" aria-hidden="true" /></button></p>}

    <section className={card} aria-labelledby="native-scope">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="native-scope" className="text-xl font-medium tracking-tight">Compare your tenant</h2>
          <p className="mt-1 text-sm text-gray-600">{selectedTenant ? <>Read-only comparison of <strong className="font-medium text-gray-800">{selectedTenant.name}</strong>. Results are saved on this device.</> : 'Choose a connected tenant in the sidebar.'}</p>
        </div>
        {running
          ? <button type="button" className={button} disabled={!!busy} onClick={() => void perform('Cancelling', () => cancelFrameworkJob(job, credentials?.appId))}>Cancel comparison</button>
          : <button type="button" className={primary} disabled={!!busy || !!disabledReason} title={disabledReason || undefined} onClick={start}>{busy === 'Starting comparison' && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}{run ? 'Compare again' : 'Compare settings'}</button>}
      </div>
      <fieldset disabled={running || !!busy} className="mt-5">
        <legend className="mb-2 text-sm font-medium text-gray-800">Platforms in scope</legend>
        <div className="flex flex-wrap gap-2">{platforms.map(p => {
          const on = scope.platforms?.includes(p) ?? false
          return <button type="button" key={p} aria-pressed={on} onClick={() => togglePlatform(p)} className={cn('inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-sm transition-colors disabled:opacity-50', on ? 'border-gray-800 bg-white font-medium text-gray-900' : 'border-gray-200 text-gray-500 hover:bg-gray-50')}>{on && <Check className="size-3.5" aria-hidden="true" />}{platformLabels[p]}</button>
        })}</div>
      </fieldset>
      {(framework.nativeId === 'essential-eight' || framework.nativeId === 'def-stan-05-138-i4') && <div className="mt-4 flex flex-wrap gap-5 text-sm">
        {framework.nativeId === 'essential-eight' && <label className="flex items-center gap-3 font-medium text-gray-800">Target maturity level<select className="h-9 rounded-full border border-gray-200 bg-white px-3 font-normal" disabled={running || !!busy} value={scope.essentialEightMaturityLevel} onChange={e => setScope(s => ({ ...s, essentialEightMaturityLevel: Number(e.target.value) as 1 | 2 | 3 }))}>{[1, 2, 3].map(level => <option key={level} value={level}>Maturity level {level}</option>)}</select></label>}
        {framework.nativeId === 'def-stan-05-138-i4' && <label className="flex items-center gap-3 font-medium text-gray-800">Target cyber risk level<select className="h-9 rounded-full border border-gray-200 bg-white px-3 font-normal" disabled={running || !!busy} value={scope.defStanRiskLevel} onChange={e => setScope(s => ({ ...s, defStanRiskLevel: Number(e.target.value) as 0 | 1 | 2 | 3 }))}>{[0, 1, 2, 3].map(level => <option key={level} value={level}>Risk level {level}</option>)}</select></label>}
      </div>}
      {credentials && disabledReason && !running && <p className="mt-4 text-sm text-gray-500">{disabledReason}</p>}
      {running && <div role="status" aria-live="polite" className="mt-5 rounded-2xl bg-gray-50 p-4">
        <div className="flex items-center justify-between gap-3 text-sm"><span className="flex min-w-0 items-center gap-2 font-medium text-gray-800"><LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" /><span className="truncate">{job.detail}</span></span><span className="shrink-0 tabular-nums text-gray-500">{job.percent}% · {elapsed(job.startedAt, now)}</span></div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-label="Comparison progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent}><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${job.percent}%` }} /></div>
        <p className="mt-3 text-xs text-gray-500">You can keep using TenuVault. The comparison continues in the background and you are notified when it is done.</p>
      </div>}
      {failedJob && !running && <div role="alert" className={cn('mt-5 flex items-start justify-between gap-3 rounded-2xl px-4 py-3 text-sm', failedJob.status === 'failed' ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-gray-700')}>
        <span>{failedJob.status === 'failed' ? `The last comparison failed. ${failedJob.error ?? ''}` : 'The last comparison was cancelled.'}</span>
        <button type="button" aria-label="Dismiss" onClick={() => { dismissedJobs.add(failedJob.jobId); setDismissed(n => n + 1) }}><X className="size-4" aria-hidden="true" /></button>
      </div>}
    </section>

    {credentials && !loaded && !error && <p role="status" className="flex items-center gap-2 px-2 text-sm text-gray-500"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Loading saved comparisons</p>}
    {credentials && loaded && !run && !running && <section className={cn(card, 'py-10 text-center')}>
      <p className="font-medium text-gray-900">No comparison yet</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">Choose the platforms in scope and select Compare settings. TenuVault reads your Intune policies and shows, setting by setting, where they match this framework mapping.</p>
    </section>}

    {run && result && counts && <>
      <section className={card} aria-labelledby="native-summary">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 id="native-summary" className="text-xl font-medium tracking-tight">Results</h2>
            <p className="mt-1 text-sm text-gray-600">{new Date(run.assessment.generatedAt).toLocaleString()} · {result.framework.version} · Mapping {run.assessment.provenance.rulesetVersion} · {(run.assessment.scope.platforms ?? platforms).map(p => platformLabels[p]).join(', ')}{framework.nativeId === 'essential-eight' && ` · Maturity level ${run.assessment.scope.essentialEightMaturityLevel ?? 1}`}{framework.nativeId === 'def-stan-05-138-i4' && ` · Risk level ${run.assessment.scope.defStanRiskLevel ?? 1}`}{history[0]?.runId !== run.runId && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">Saved comparison</span>}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {([['pdf', 'PDF report', Download], ['csv', 'CSV', FileSpreadsheet], ['json', 'JSON', FileJson]] as const).map(([format, label, Icon]) =>
              <button type="button" key={format} className={button} disabled={exportingFormat(format, run.runId)} onClick={() => exportRun(format, run.runId)}>
                {exportingFormat(format, run.runId) ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Icon className="size-4" aria-hidden="true" />}{label}
              </button>)}
          </div>
        </div>
        <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-3" role="group" aria-label="Filter evidence by result">
          {(Object.keys(labels) as ResultKey[]).map(key => <button type="button" key={key} aria-pressed={status === key} disabled={!counts[key] && status !== key} onClick={() => setStatus(status === key ? 'all' : key)}
            className={cn('rounded-2xl border p-4 text-left transition-colors disabled:cursor-default', status === key ? 'border-gray-800 bg-white' : 'border-transparent bg-gray-50 hover:border-gray-200 disabled:border-transparent')}>
            <span className={cn('block text-2xl font-semibold tabular-nums', counts[key] ? toneText[resultTone[key]] : 'text-gray-400')}>{counts[key]}</span>
            <span className="mt-1 block text-sm text-gray-600">{labels[key]}</span>
          </button>)}
        </div>
        {scoring && <p className="mt-5 flex flex-wrap items-center gap-2 text-sm text-gray-800">
          <span>Baseline score: <strong className="font-medium tabular-nums">{scoreData ? formatScore(scoreData.detail.score) : score.error ? (score.error instanceof Error ? score.error.message : 'Not available.') : 'Loading'}</strong></span>
          {!scoreData && score.error && <button type="button" className="text-blue-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50" disabled={score.isFetching} onClick={() => void score.refetch()}>Retry</button>}
          {readGaps.length > 0 && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">Partial collection</span>}
          <Link className="text-blue-700 hover:underline" to="/portal/governance/scores">How the score is counted</Link>
        </p>}
        <p className="mt-5 text-sm leading-6 text-gray-600">{frameworkCoverageLabel(result) ?? `${result.controls.length} selected technical references. This is a subset of the framework.`} {result.framework.note}</p>
        <p className="mt-2 text-xs text-gray-500">Counts cover capabilities once, using the best assigned policy evidence. Unassigned policies cannot count as matches. Individual observations remain available below. Configuration and assignment evidence do not establish actual device enforcement.</p>
      </section>


      <section className={card} aria-labelledby="native-checks">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="native-checks" className="text-xl font-medium tracking-tight">Setting-by-setting evidence</h2>
          <span className="text-sm text-gray-500">{matches.length} of {run.assessment.capabilities.length} capabilities</span>
        </div>
        <div className="my-4 flex flex-wrap gap-3">
          <input aria-label="Search native settings and policies" placeholder="Search setting, policy, or capability" value={query} onChange={e => setQuery(e.target.value)} className="h-10 min-w-56 flex-1 rounded-full border border-gray-200 bg-white px-4 text-sm" />
          <select aria-label="Filter comparison status" value={status} onChange={e => setStatus(e.target.value as typeof status)} className="h-10 rounded-full border border-gray-200 bg-white px-3 text-sm"><option value="all">All results</option>{(Object.keys(labels) as ResultKey[]).map(key => <option key={key} value={key}>{labels[key]}</option>)}</select>
        </div>
        <div className="divide-y divide-gray-100">{matches.map(cap => <CapabilityEvidence key={`${cap.capability.id}:${status}:${!!term}`} result={cap} open={status !== 'all' || !!term} />)}</div>
        {(status === 'unableToCheck' || status === 'outsideScope') && result.controls.filter(c => c.unavailableCheck && (c.unavailableCheck.assessmentStatus === 'outsideScope') === (status === 'outsideScope')).map(c => <div key={c.control.id} className="mt-3 rounded-2xl bg-gray-50 p-4 text-sm"><p className="font-medium text-gray-900">{c.control.id} · {c.control.title}</p><p className="mt-1 text-gray-600">{c.unavailableCheck?.reason ?? 'No supported detector.'}</p></div>)}
        {!matches.length && !(status === 'unableToCheck' || status === 'outsideScope') && <p role="status" className="p-4 text-sm text-gray-500">No checks match this filter.</p>}
      </section>

      <Disclosure title="Collection coverage and limitations" hint={readGaps.length ? `Partial collection: ${readGaps.length} policy ${readGaps.length === 1 ? 'type' : 'types'} with read gaps` : 'All policy types this comparison uses were read'}>
        {run.assessment.collectionCoverage.map(f => <div key={f.family} className="border-t pt-3 text-sm"><strong className="font-medium">{COLLECTION_FAMILY_LABELS[f.family] ?? f.family}: {COLLECTION_STATUS_LABELS[f.status] ?? f.status}</strong><p className="text-gray-600">{f.collectedPolicies} policies collected · {f.recognizedPolicies} recognized · {f.unsupportedPolicies} without recognized evidence</p>{f.status === 'notCollected' && !f.errors.length && <p className="mt-1 text-gray-600">Not read for this comparison: no check uses it, or its platform is outside the scope. This is not a read gap.</p>}{f.errors.map((e, i) => <p className="mt-1 text-amber-800" key={i}>{e}</p>)}</div>)}
      </Disclosure>
      <Disclosure title="Framework references" hint={`${result.controls.length} references`}>
        {result.controls.map(c => <div key={c.control.id} className="border-t pt-3 text-sm"><strong className="font-medium">{c.control.id} · {c.control.title}</strong><p className="mt-1">{CONTROL_STATUS_LABELS[c.status]}</p><p className="mt-1 text-gray-600">{c.control.summary}</p>{c.unavailableCheck && <p className="mt-1 text-amber-800">{c.unavailableCheck.reason}</p>}{c.unassessedAspects.map((a, i) => <p key={i} className="mt-1 text-gray-600">{a}</p>)}</div>)}
      </Disclosure>
      <Disclosure title="Snapshot and ruleset provenance" hint="Hashes and source commit">
        <dl className="grid gap-x-4 gap-y-1 break-all text-xs sm:grid-cols-[200px_1fr]"><dt className="text-gray-500">Snapshot SHA-256</dt><dd className="font-mono">{run.snapshotSha256}</dd><dt className="text-gray-500">Ruleset SHA-256</dt><dd className="font-mono">{run.rulesetSha256}</dd><dt className="text-gray-500">IntuneDocumentation source commit</dt><dd className="font-mono">{run.sourceCommit}</dd></dl>
        <p className="mt-3 text-sm text-gray-600">Hashes identify the input and ruleset, and do not certify their accuracy. Adapted from IntuneDocumentation under Elastic License 2.0. Publisher attribution and the full license are included in the installed framework-NOTICES.txt.</p>
      </Disclosure>
    </>}

    {!!history.length && <section className={card} aria-labelledby="native-history">
      <div className="flex items-center gap-3"><History className="size-5 text-gray-500" aria-hidden="true" /><h2 id="native-history" className="text-xl font-medium tracking-tight">Comparison history</h2></div>
      <p className="mt-1 text-sm text-gray-600">{persistent ? 'Stored in protected local storage on this device.' : 'Session history only. Protected storage is unavailable.'} Up to 20 comparisons are kept per tenant and framework. Select one to view it, or compare it with the one you are viewing to see what changed.</p>
      <ul className="mt-4 divide-y divide-gray-100">{history.map(item => {
        const viewing = run?.runId === item.runId
        const itemCounts = comparisonCounts(item)
        const when = new Date(item.assessment.generatedAt).toLocaleString()
        return <li key={item.runId} aria-current={viewing || undefined} className="flex flex-wrap items-center gap-3 py-3 text-sm">
          <span className="min-w-0 flex-1"><span className="font-medium text-gray-900">{when}</span>{viewing && <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs text-foreground">Viewing</span>}{olderRules(item) && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800" title="An app update changed the scoring rules or mapping. Compare again to score.">Scored under older rules</span>}<span className="block text-xs text-gray-500">{itemCounts.matches} matches · {itemCounts.different} different · {itemCounts.missing} missing · {(item.assessment.scope.platforms ?? []).map(p => platformLabels[p]).join(', ')}</span></span>
          {!viewing && <button type="button" className={small} disabled={!!busy || running} aria-label={`View comparison from ${when}`} onClick={() => { setRun(item); applyScopeOf(item); setChanges(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>View</button>}
          {run && !viewing && <button type="button" className={small} disabled={!!busy} aria-label={`Show changes since ${when}`} onClick={() => { setError(''); try { setChanges({ base: item, rows: compareNativeAssessments(item, run) }); requestAnimationFrame(() => document.getElementById('native-changes')?.scrollIntoView({ behavior: 'smooth', block: 'start' })) } catch (e) { setChanges(null); setError(e instanceof Error ? e.message : 'Cannot compare these runs.'); window.scrollTo({ top: 0, behavior: 'smooth' }) } }}>Show changes since</button>}
          <button type="button" className={cn(small, 'text-red-700')} disabled={!!busy} aria-label={`Delete comparison from ${when}`} onClick={async () => { if (await confirm({ title: "Delete comparison?", description: `Delete the comparison from ${when}? This cannot be undone.`, confirmLabel: "Delete", destructive: true })) void perform('Deleting comparison', async () => { await request({ ...body, action: 'native-delete', runId: item.runId }); invalidateScores(client); const rest = history.filter(x => x.runId !== item.runId); setHistory(rest); if (run?.runId === item.runId) setRun(rest[0] ?? null); if (changes?.base.runId === item.runId || run?.runId === item.runId) setChanges(null) }) }}>Delete</button>
        </li>
      })}</ul>
    </section>}
    {run && changes && <section className={card} aria-labelledby="native-changes">
        <div className="flex items-start justify-between gap-3"><div><h2 id="native-changes" className="text-xl font-medium tracking-tight">{changes.rows.length} changed setting {changes.rows.length === 1 ? 'observation' : 'observations'}</h2><p className="mt-1 text-sm text-gray-600">From {new Date(changes.base.assessment.generatedAt).toLocaleString()} to {new Date(run.assessment.generatedAt).toLocaleString()}. Same tenant, scope and ruleset. Changes can reflect collection availability or assignment evidence as well as configuration values.</p></div><button type="button" className={small} onClick={() => setChanges(null)}>Close</button></div>
        {changes.rows.map(c => <ChangeRow key={c.setting} change={c} run={run} />)}
      </section>}
  </div>
}

/** One changed observation: which capability, setting and policy, and its result before and after. */
function ChangeRow({ change, run }: { change: ReturnType<typeof compareNativeAssessments>[number]; run: NativeAssessment }) {
  const [capabilityId = '', ...rest] = change.setting.split(':')
  const policyId = rest.pop() ?? ''
  const settingId = rest.join(':')
  const capability = run.assessment.capabilities.find(c => c.capability.id === capabilityId)
  const policyName = capability?.checks.find(c => c.policyId === policyId)?.policyName
  const describe = (value: string) => {
    if (value === 'Not observed') return [value]
    try {
      return (JSON.parse(value) as string[]).map(item => {
        const o = JSON.parse(item) as { status: string; result?: ResultKey; observed?: string | null }
        const key = (o.status === 'checked' ? o.result ?? 'unableToCheck' : o.status) as ResultKey
        return `${labels[key] ?? key}${o.observed == null ? '' : `: ${displayCheckValue(o.observed)}`}`
      })
    } catch { return [value] }
  }
  return <details className="mt-3 border-t pt-3 text-sm">
    <summary className="cursor-pointer"><span className="font-medium text-gray-900">{capability?.capability.name ?? capabilityId}</span>{policyName && <span className="text-gray-500"> · {policyName}</span>}<span className="mt-1 block break-all font-mono text-xs text-gray-500">{settingId}</span></summary>
    <dl className="mt-3 grid gap-2 rounded-xl bg-gray-50 p-3 text-sm sm:grid-cols-[90px_1fr]"><dt className="text-gray-500">Before</dt><dd className="break-all">{describe(change.previous).join('; ')}</dd><dt className="text-gray-500">After</dt><dd className="break-all">{describe(change.current).join('; ')}</dd></dl>
  </details>
}

function Disclosure({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return <details className={disclosure}>
    <summary className={summaryRow}><span className="text-lg font-medium tracking-tight">{title}<span className="ml-3 text-sm font-normal text-gray-500">{hint}</span></span><ChevronDown className="chevron size-4 shrink-0 text-gray-500 transition-transform" aria-hidden="true" /></summary>
    <div className="mt-4 space-y-3">{children}</div>
  </details>
}

function CapabilityEvidence({ result, open }: { result: CapabilityResult; open: boolean }) {
  const checks = result.checks
  const tone = capabilityTone[result.status]
  return <details className="group py-3" open={open || undefined}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-2 py-1.5 text-sm hover:bg-gray-50 [&::-webkit-details-marker]:hidden">
      <span className="min-w-0 font-medium text-gray-900">{result.capability.name}</span>
      <span className="flex shrink-0 items-center gap-2"><span className={cn('rounded-full px-2.5 py-0.5 text-xs', tonePill[tone])}>{CAPABILITY_STATUS_LABELS[result.status]}</span><ChevronDown className="size-4 text-gray-500 transition-transform group-open:rotate-180" aria-hidden="true" /></span>
    </summary>
    <div className="px-2">
      <p className="my-3 text-sm text-gray-600">{result.capability.description}</p>
      <div className="space-y-3">{checks.map((check, i) => {
        const key = checkKey(check)
        return <div key={i} className="rounded-2xl bg-gray-50 p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', tonePill[resultTone[key]])}>{labels[key]}</span>{check.policyName && <span className="text-xs text-gray-500">{check.policyName}</span>}</div>
          <p className="mt-2 break-all font-mono text-xs text-gray-700">{check.settingId}</p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-[110px_1fr]"><dt className="text-gray-500">Expected</dt><dd className="break-all">{displayCheckValue(check.expectedValue)}</dd><dt className="text-gray-500">Observed</dt><dd className="break-all">{check.actualValue == null ? 'Not available' : displayCheckValue(check.actualValue)}</dd>{check.policyId && <><dt className="text-gray-500">Source policy</dt><dd className="break-all">{check.policyName} <span className="text-gray-500">({check.policyId})</span></dd></>}</dl>
          {check.reason && <p className="mt-3 text-amber-800">{check.reason}</p>}
          {check.assignment && <details className="mt-3"><summary className="cursor-pointer text-gray-700">Assignment: {check.assignment.state}</summary><p className="mt-2 break-all">Targets: {check.assignment.targets.join('; ') || 'None'}<br />Exclusions: {check.assignment.exclusions.join('; ') || 'None'}<br />Filters: {JSON.stringify(check.assignment.filters)}</p><p className="mt-2 text-gray-600">Group membership, filter evaluation and effective coverage are unverified.</p></details>}
        </div>
      })}</div>
      {result.limitations.map((l, i) => <p className="mt-3 text-sm text-gray-600" key={i}>{l}</p>)}
    </div>
  </details>
}
