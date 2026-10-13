import { expect, it } from "vitest"
import { isBackupJobPollable, resolveBackupJobDisplay, toBackupJobDisplay } from "../src/portal/lib/backup-job-display"

const running = { status: "Running", progress: 5, progressMessage: "Starting backup...", isComplete: false, isSuccessful: false }
const completed = { status: "Completed", progress: 100, progressMessage: "Backup complete", startTime: "2026-10-13T10:00:00Z", endTime: "2026-10-13T10:05:00Z", isComplete: true, isSuccessful: true }

it("keeps the finished snapshot after the tracked job is removed instead of falling back to the running placeholder", () => {
  expect(resolveBackupJobDisplay(null, completed, running)).toEqual(completed)
  expect(resolveBackupJobDisplay(null, null, running)).toEqual(running)
})

it("prefers the live tracked job over a previous snapshot", () => {
  expect(resolveBackupJobDisplay(running, completed, null)).toEqual(running)
})

it("converts a tracked backup job to its display status including the poll error", () => {
  expect(toBackupJobDisplay({ ...completed, output: "done", pollError: "Failed to check job status" })).toEqual({ ...completed, output: "done", exception: undefined, pollError: "Failed to check job status" })
})

it("does not poll a job that completed or recorded a poll error", () => {
  expect(isBackupJobPollable({ isComplete: false })).toBe(true)
  expect(isBackupJobPollable({ isComplete: true })).toBe(false)
  expect(isBackupJobPollable({ isComplete: false, pollError: "Failed to check job status" })).toBe(false)
})
