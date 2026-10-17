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
    .toEqual({ stored: 6, successful: 1, failed: 3, finished: 4, inProgress: 1, successRate: 25, latestStatus: 'running' })
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
it('counts a failed run once, from its folder when storage holds one', () => {
  const since = new Date(now.getTime() - 86_400_000)
  const folders = [
    { status: 'failed' as const, timestamp: now, runId: 'run-manifest' },
    { status: 'running' as const, timestamp: now, runId: 'run-marker-only' },
    { status: 'running' as const, timestamp: now, runId: 'run-live' },
    { status: 'success' as const, timestamp: now, runId: null },
  ]
  const attempts = [{ timestamp: now, runId: 'run-manifest' }, { timestamp: now, runId: 'run-marker-only' }, { timestamp: now, runId: 'run-no-folder' }, { timestamp: now }]
  // Two failed folders (one known failed though it has no manifest yet), plus two attempts without a folder.
  expect(backupSummary(folders, attempts, { since })).toMatchObject({ stored: 4, successful: 1, failed: 4, inProgress: 1, finished: 5 })
  // An attempt whose folder is older than the period still counts once, from that folder.
  expect(backupSummary([{ status: 'failed', timestamp: new Date(0), runId: 'old' }], [{ timestamp: now, runId: 'old' }], { since })).toMatchObject({ failed: 0, finished: 0 })
})
it('reads a folder without a manifest as failed, running or incomplete, with the chip and count in agreement', () => {
  const since = new Date(now.getTime() - 86_400_000)
  // The list says running for one under six hours old and incomplete after that.
  const recent = [{ status: 'running' as const, timestamp: now, runId: 'run-a' }]
  // Live in the engine (any trigger): running, counted once with the live job.
  expect(backupSummary(recent, [], { since, live: ['run-a'] })).toMatchObject({ inProgress: 1, failed: 0, finished: 0, latestStatus: 'running' })
  // Not live here but recent: maybe another device, or the app restarted mid run.
  expect(backupSummary(recent, [], { since, live: [] })).toMatchObject({ inProgress: 1, failed: 0, latestStatus: 'running' })
  // Its run failed: the folder is that failure, counted once.
  expect(backupSummary(recent, [{ timestamp: now, runId: 'run-a' }], { since, live: [] })).toMatchObject({ inProgress: 0, failed: 1, finished: 1, latestStatus: 'failed' })
  expect(backupSummary([{ status: 'incomplete', timestamp: now, runId: 'run-a' }], [], { since, live: [] })).toMatchObject({ inProgress: 0, failed: 1, latestStatus: 'incomplete' })
  // A live job that has no folder yet is running too, and the chip says so.
  expect(backupSummary([{ status: 'success', timestamp: now, runId: 'run-old' }], [], { since, live: ['run-new'] })).toMatchObject({ inProgress: 1, successful: 1, latestStatus: 'running' })
  // A folder whose run cannot be told (status unknown) is neither: its attempt counts the run once.
  expect(backupSummary([{ status: 'unknown', timestamp: now, runId: null }], [{ timestamp: now, runId: 'run-b' }], { since, live: [] })).toMatchObject({ stored: 1, failed: 1, finished: 1, latestStatus: 'unknown' })
})
it('has no success rate without a finished backup and counts each running run once', () => {
  expect(backupSummary([], [], { since: now })).toEqual({ stored: 0, successful: 0, failed: 0, finished: 0, inProgress: 0, successRate: null, latestStatus: null })
  const running = [{ status: 'running' as const, timestamp: now, runId: 'run-a' }, { status: 'running' as const, timestamp: now }, { status: 'unknown' as const, timestamp: now }]
  expect(backupSummary(running, [], { since: now })).toMatchObject({ stored: 3, finished: 0, inProgress: 2, successRate: null })
  expect(backupSummary(running, [], { since: now, live: ['run-a', 'run-a', 'run-b'] }).inProgress).toBe(3)
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
it('stops counting a run as running once its manifest or failure record is saved', () => {
  const since = new Date(now.getTime() - 86_400_000)
  const folders = [{ status: 'success' as const, timestamp: now, runId: 'run-done' }]
  const attempts = [{ timestamp: now, runId: 'run-failed' }]
  // The engine still reports both runs while it cleans up after writing their results.
  expect(backupSummary(folders, attempts, { since, live: ['run-done', 'run-failed'] }))
    .toMatchObject({ successful: 1, failed: 1, inProgress: 0, latestStatus: 'success' })
})
it('keeps a known failed run failed after its folder without a manifest turns incomplete', () => {
  const since = new Date(now.getTime() - 86_400_000)
  const folders = [{ status: 'incomplete' as const, timestamp: now, runId: 'run-failed' }, { status: 'incomplete' as const, timestamp: new Date(now.getTime() - 1000), runId: 'run-live' }]
  expect(backupSummary(folders, [{ timestamp: now, runId: 'run-failed' }], { since, live: ['run-live'] }))
    .toMatchObject({ failed: 1, inProgress: 1, latestStatus: 'running' })
  expect(backupSummary(folders.slice(0, 1), [{ timestamp: now, runId: 'run-failed' }], { since })).toMatchObject({ failed: 1, latestStatus: 'failed' })
})
