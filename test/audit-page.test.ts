import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import AuditPage from '../src/portal/app/portal/audit/page'
import { AuditEventType, DESKTOP_AUDIT_EVENT_TYPES } from '../src/portal/lib/audit/types'

const state = vi.hoisted(() => ({ hook: 0 }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useEffect: () => undefined,
  useState: (initial: unknown) => {
    const hook = state.hook++
    if (hook === 10) return [true, vi.fn()]
    if (hook === 11) return [{ summary: { totalEvents: 8, successRate: '75%', criticalEvents: 0, securityAlerts: 0 } }, vi.fn()]
    return [typeof initial === 'function' ? initial() : initial, vi.fn()]
  },
}))
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Link: ({ children, to }: { children: ReactNode; to: string }) => createElement('a', { href: to }, children),
}))
vi.mock('~/contexts/TenantContext', () => ({
  useSelectedTenant: () => ({ selectedTenant: { credentials: { tenantId: 'tenant' } } }),
}))
vi.mock('@desktop/lib/license', () => ({ useTenantPlan: () => 'pro' }))
vi.mock('@desktop/components/PlanGate', () => ({
  canUse: () => true,
  GatedButton: ({ children }: { children: ReactNode }) => createElement('button', null, children),
  LockedPreview: () => null,
}))

beforeEach(() => { state.hook = 0 })

it('shows the operation totals without permanently empty security cards', () => {
  const html = renderToStaticMarkup(createElement(AuditPage))
  expect(html).toContain('Total Events')
  expect(html).toContain('>8</p>')
  expect(html).toContain('Success Rate')
  expect(html).toContain('>75%</p>')
  expect(html).toContain('not a complete Microsoft tenant audit')
  expect(html).not.toContain('Critical Events')
  expect(html).not.toContain('Security Alerts')
})

it('offers recorded desktop event types, including cancelled backups, and severities in the visible filters', () => {
  expect(DESKTOP_AUDIT_EVENT_TYPES).toContain(AuditEventType.BACKUP_CANCELLED)
  const html = renderToStaticMarkup(createElement(AuditPage))
  const options = [...html.matchAll(/<select\b[^>]*>(.*?)<\/select>/gs)]
    .map(select => [...select[1]!.matchAll(/<option value="([^"]*)"/g)].map(option => option[1]))
  expect(options).toEqual([
    ['', 'BACKUP_STARTED', 'BACKUP_COMPLETED', 'BACKUP_FAILED', 'BACKUP_CANCELLED', 'BACKUP_DOWNLOADED', 'RESTORE_COMPLETED', 'RESTORE_FAILED', 'POLICY_CREATED', 'POLICY_REVERTED', 'POLICY_RESTORED', 'POLICY_DRIFT_DETECTED', 'CHANGE_SET_APPLIED', 'CHANGE_SET_ROLLED_BACK', 'CHANGE_SET_APPROVED', 'CHANGE_SET_REJECTED', 'GOVERNANCE_FINDING_REVIEWED', 'GOVERNANCE_CUSTOMIZATION_RECORDED', 'GOVERNANCE_CUSTOMIZATION_RETIRED', 'GOVERNANCE_STANDARD_PUBLISHED', 'GOVERNANCE_STANDARD_ADOPTED'],
    ['', 'INFO', 'WARNING', 'ERROR'],
    ['', 'SUCCESS', 'FAILURE', 'PARTIAL'],
  ])
})
