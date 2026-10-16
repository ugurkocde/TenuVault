import { afterEach, describe, expect, it, vi } from "vitest"
import { whenBackupEnds } from "../src/renderer/lib/backups"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Answers the status route with the given responses in turn, repeating the last one. */
function statuses(...responses: Array<() => Response>) {
  const fetch = vi.fn(async () => (responses.length > 1 ? responses.shift()! : responses[0]!)())
  vi.stubGlobal("fetch", fetch)
  return fetch
}

describe("whenBackupEnds", () => {
  it("calls back once when the job completes, without the progress panel", async () => {
    vi.useFakeTimers()
    const fetch = statuses(() => Response.json({ isComplete: false }), () => Response.json({ isComplete: true }))
    const onEnd = vi.fn()
    whenBackupEnds("job-1", onEnd, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onEnd).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onEnd).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ jobId: "job-1" })
  })

  it("treats a job the app no longer knows as ended", async () => {
    vi.useFakeTimers()
    statuses(() => Response.json({ error: "This backup job is no longer available." }, { status: 404 }))
    const onEnd = vi.fn()
    whenBackupEnds("gone", onEnd, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it("keeps watching through failed status reads and stops when asked", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => { throw new TypeError("offline") })
    vi.stubGlobal("fetch", fetch)
    const onEnd = vi.fn()
    const stop = whenBackupEnds("job-2", onEnd, 1000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetch).toHaveBeenCalledTimes(3)
    stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(onEnd).not.toHaveBeenCalled()
  })
})
