import { describe, expect, it, vi } from "vitest"
import { backupBeforeWrite } from "../src/main/backup/before-write"
import { COMPLETE_BACKUP_METADATA } from "./feature-change-sets-fakes"

function setup(workflow: "oib" | "change-set") {
  let now = 0
  const post = vi.fn(async (path: string, _body: Record<string, unknown>) => ({ ok: true, status: 200, json: path === "/api/backup/start" ? { jobId: "fixture-job" } : path === "/api/backup/status" ? { isComplete: true, isSuccessful: true, backupFolder: "backup-2026-09-30-120000" } : { content: { metadata: COMPLETE_BACKUP_METADATA } } } as { ok: boolean; status: number; json: Record<string, unknown> }))
  const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds })
  const report = vi.fn()
  return { post, sleep, report, options: { workflow, post, startBody: {}, folders: ["ConfigurationPolicies"], now: () => now, polling: { intervalMs: 2000, timeoutMs: 3000, sleep }, error: (message: string, status: number) => Object.assign(new Error(message), { status }), report } }
}

describe.each(["oib", "change-set"] as const)("%s backup checks", (workflow) => {
  it("keeps polling, bounds progress and checks completeness before returning the exact folder", async () => {
    const context = setup(workflow)
    context.post.mockResolvedValueOnce({ ok: true, status: 200, json: { jobId: "fixture-job" } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: { isComplete: false, progress: 140, progressMessage: "Fixture progress" } })
    await expect(backupBeforeWrite(context.options)).resolves.toBe("backup-2026-09-30-120000")
    expect(context.sleep).toHaveBeenCalledWith(2000)
    expect(context.report).toHaveBeenCalledWith({ stage: "Backing up 1 policy type: Fixture progress", percent: 100, backupJobId: "fixture-job" })
    expect(context.post).toHaveBeenLastCalledWith("/api/list-backup-contents", { backupId: "backup-2026-09-30-120000" })
  })

  it("preserves the plan refusal status when a backup cannot start", async () => {
    const context = setup(workflow)
    context.post.mockResolvedValueOnce({ ok: false, status: 402, json: { error: "Fixture license required" } })
    await expect(backupBeforeWrite(context.options)).rejects.toMatchObject({ status: 402, message: expect.stringContaining("Fixture license required") })
    expect(context.post).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ok: false, status: 503, json: {} },
    { ok: true, status: 200, json: { isComplete: true, isSuccessful: false, exception: "Fixture failure" } },
    { ok: true, status: 200, json: { isComplete: true, isSuccessful: true, backupFolder: "" } },
  ])("refuses a failed status or missing backup folder: %j", async (status) => {
    const context = setup(workflow)
    context.post.mockResolvedValueOnce({ ok: true, status: 200, json: { jobId: "fixture-job" } }).mockResolvedValueOnce(status)
    await expect(backupBeforeWrite(context.options)).rejects.toMatchObject({ status: 502 })
    expect(context.post).toHaveBeenCalledTimes(2)
  })

  it("refuses unreadable contents even if the error response contains successful metadata", async () => {
    const context = setup(workflow)
    const post = context.post.getMockImplementation()!
    context.post.mockImplementation((path, body) => path === "/api/list-backup-contents" ? Promise.resolve({ ok: false, status: 503, json: { content: { metadata: COMPLETE_BACKUP_METADATA } } }) : post(path, body))
    await expect(backupBeforeWrite(context.options)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("could not be read") })
  })

  it("stops polling after the existing timeout", async () => {
    const context = setup(workflow)
    const post = context.post.getMockImplementation()!
    context.post.mockImplementation((path, body) => path === "/api/backup/status" ? Promise.resolve({ ok: true, status: 200, json: { isComplete: false } }) : post(path, body))
    await expect(backupBeforeWrite(context.options)).rejects.toMatchObject({ status: 504, message: expect.stringContaining("did not finish within an hour") })
    expect(context.sleep).toHaveBeenCalledTimes(2)
    expect(context.post.mock.calls.some(([path]) => path === "/api/list-backup-contents")).toBe(false)
  })
})
