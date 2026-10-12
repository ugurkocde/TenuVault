import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { collectNativeEvidence, graphEvidenceReader } from '../src/main/frameworks/collector'
import { createEvidenceManifest } from '../src/shared/compliance/manifest'
import { frameworks } from '../src/shared/frameworks/catalog'
import { generateNativeFrameworkPDF } from '../src/shared/compliance/report-pdf'
import { comparisonCounts, FRAMEWORK_SOURCE_COMMIT, type NativeAssessment } from '../src/shared/compliance/native'

const file = process.env.TENUVAULT_LOKKA_EVIDENCE
describe.skipIf(!file)('Lokka lab Graph evidence replay', () => {
  it('runs the desktop collector, ten mappings and PDF generation against observed Graph responses', async () => {
    const live = JSON.parse(readFileSync(file!, 'utf8'))
    const original = globalThis.fetch
    globalThis.fetch = async input => {
      const url = new URL(String(input)); const path = url.pathname.replace(/^\/beta\//, '') + url.search
      const value = live.cache[path]
      if (!value) throw new Error(`Lokka did not observe ${path}`)
      return Response.json(value.body, { status: value.status })
    }
    let data
    try { data = await collectNativeEvidence(graphEvidenceReader('local-replay-no-token')) } finally { globalThis.fetch = original }
    expect(data.fetchErrors).toEqual([])
    const manifest = await createEvidenceManifest(data)
    expect(manifest.assessment.frameworks).toHaveLength(10)
    const summary = []
    const output = process.env.TENUVAULT_FRAMEWORK_PDF_DIR
    if (output) mkdirSync(output, { recursive: true })
    for (const framework of frameworks.filter(f => f.nativeId)) {
      const selectedManifest = await createEvidenceManifest(data, {}, framework.nativeId)
      const selected = manifest.assessment.frameworks.find(f => f.framework.id === framework.nativeId)!
      const ids = new Set(selected.controls.flatMap(c => [...c.capabilityIds, ...c.excludedCapabilityIds]))
      const run: NativeAssessment = { schemaVersion: 1, runId: 'lab-verification', tenantId: 'ffc10f05-e837-4803-81b1-7c4dee678c2a', frameworkId: framework.id, sourceCommit: FRAMEWORK_SOURCE_COMMIT, snapshotSha256: manifest.snapshotSha256, rulesetSha256: selectedManifest.rulesetSha256, licenseNotice: framework.licenseNotice ?? '', assessment: { ...manifest.assessment, frameworks: [selected], capabilities: manifest.assessment.capabilities.filter(c => ids.has(c.capability.id)) } }
      const pdf = generateNativeFrameworkPDF(run)
      expect(Buffer.from(pdf).subarray(0, 8).toString()).toContain('%PDF-1.')
      expect(pdf.length).toBeGreaterThan(5000)
      summary.push({ framework: framework.id, references: selected.controls.length, ...comparisonCounts(run), pdfBytes: pdf.length })
      if (output) { writeFileSync(`${output}/${framework.id}.pdf`, pdf); writeFileSync(`${output}/${framework.id}.json`, JSON.stringify(run)) }
    }
    if (output) writeFileSync(`${output}/verification.json`, JSON.stringify({ observedAt: live.observedAt, httpCalls: live.httpCalls, graphReads: live.graphReads, collectedPolicies: manifest.assessment.collectionCoverage.map(c => ({ family: c.family, count: c.collectedPolicies, status: c.status })), frameworks: summary }, null, 2))
    expect(summary.every(s => s.matches + s.different + s.unableToCheck + s.missing + s.outsideScope > 0)).toBe(true)
  })
})
