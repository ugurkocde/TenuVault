import { expect, it } from 'vitest'
import { backupHealth, backupSummary, latestComplete, normalizeBackupStatus } from '../src/portal/lib/backup-health'
const now = new Date('2026-09-26T12:00:00Z')
it.each(['running', 'incomplete', 'unknown', 'failed', 'partial', 'success'] as const)('preserves %s', (status) => {
  expect(normalizeBackupStatus({ status })).toBe(status)
})
it('requires an explicit completed status and counts only terminal results in success rate', () => {
  expect(normalizeBackupStatus({ status: 'Completed' })).toBe('success')
  expect(normalizeBackupStatus({ status: 'CompletedWithWarnings' })).toBe('partial')
  expect(normalizeBackupStatus({ status: 'new-server-state' })).toBe('unknown')
  expect(backupSummary(['running', 'incomplete', 'unknown', 'failed', 'partial', 'success'].map((status) => ({ status: normalizeBackupStatus({ status }), timestamp: now })), [], { since: now }))
    .toEqual({ stored: 6, successful: 1, failed: 3, finished: 4, inProgress: 1, successRate: 25 })
})
it('derives every dashboard count from the same backups and failed attempts', () => {
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000)
  const since = hoursAgo(24 * 7)
  const backups = [
    { status: 'success' as const, timestamp: hoursAgo(1) },
    { status: 'failed' as const, timestamp: hoursAgo(2) },
    ...[10, 11, 12, 13, 15].map((days) => ({ status: 'success' as const, timestamp: hoursAgo(24 * days) })),
  ]
  const attempts = [{ timestamp: hoursAgo(3) }, { timestamp: hoursAgo(24 * 8) }]
  const summary = backupSummary(backups, attempts, { since })
  // Seven backups are in storage; one succeeded in the period, and the failed backup and the attempt that saved nothing failed.
  expect(summary).toMatchObject({ stored: 7, successful: 1, failed: 2, finished: 3, inProgress: 0 })
  expect(summary.successRate).toBeCloseTo(33.33, 2)
  expect(summary.finished).toBe(summary.successful + summary.failed)
  // The previous period ends where the selected one starts.
  expect(backupSummary(backups, attempts, { since: hoursAgo(24 * 14), until: since })).toMatchObject({ successful: 4, failed: 1, finished: 5, successRate: 80 })
})
it('has no success rate without a finished backup and takes running from the live jobs', () => {
  expect(backupSummary([], [], { since: now })).toEqual({ stored: 0, successful: 0, failed: 0, finished: 0, inProgress: 0, successRate: null })
  const running = [{ status: 'running' as const, timestamp: now }, { status: 'unknown' as const, timestamp: now }]
  expect(backupSummary(running, [], { since: now })).toMatchObject({ stored: 2, finished: 0, inProgress: 1, successRate: null })
  expect(backupSummary(running, [], { since: now, running: 0 }).inProgress).toBe(0)
  expect(backupSummary([], [{ timestamp: now }], { since: now })).toMatchObject({ stored: 0, failed: 1, finished: 1, successRate: 0 })
})
it('does not let a recent failed backup hide stale protection', () => {
  const backups = [{ status: 'failed' as const, timestamp: now }, { status: 'success' as const, timestamp: new Date(now.getTime() - 72 * 3_600_000) }]
  expect(latestComplete(backups)).toBe(backups[1])
  expect(backupHealth(backups, now)).toBe('critical')
})
it('never labels empty, unknown, unavailable or unfinished protection healthy', () => {
  expect(backupHealth([], now)).toBe('warning')
  for (const status of ['running', 'unknown', 'incomplete', 'failed', 'partial'] as const) expect(backupHealth([{ status, timestamp: now }], now)).not.toBe('healthy')
  expect(backupHealth([{ status: 'success', timestamp: now }], now, true)).toBe('warning')
  expect(backupHealth([{ status: 'success', timestamp: now }], now)).toBe('healthy')
})

it('skips blank status fields and trims meaningful fallback states', () => {
  expect(normalizeBackupStatus({ status: '', properties: { status: ' Completed ' } })).toBe('success')
  expect(normalizeBackupStatus({ status: '  ', properties: { status: '' }, result: 'Succeeded' })).toBe('success')
  expect(normalizeBackupStatus({ status: '  ' })).toBe('unknown')
})
