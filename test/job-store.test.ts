import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createJobPoller } from "../src/renderer/lib/job-store"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it("polls a tracked key immediately and then on the interval", async () => {
  const poll = vi.fn(async () => {})
  const poller = createJobPoller({ intervalMs: 1000, poll })
  poller.track("a")
  expect(poll).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(poll).toHaveBeenCalledTimes(3)
  poller.stopAll()
})

it("never polls the same key twice when tracked again or ticked in flight", async () => {
  let release = () => {}
  const poll = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
  const poller = createJobPoller({ intervalMs: 1000, poll })
  poller.track("a")
  poller.track("a")
  poller.pollNow("a")
  await vi.advanceTimersByTimeAsync(3000)
  expect(poll).toHaveBeenCalledTimes(1)
  release()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(poll).toHaveBeenCalledTimes(2)
  poller.stopAll()
})

it("stops polling and discards in-flight responses after untrack", async () => {
  const seen: boolean[] = []
  let release = () => {}
  const poll = vi.fn(async (_key: string, isCurrent: () => boolean) => {
    await new Promise<void>((resolve) => { release = resolve })
    seen.push(isCurrent())
  })
  const poller = createJobPoller({ intervalMs: 1000, poll })
  poller.track("a")
  poller.untrack("a")
  release()
  await vi.advanceTimersByTimeAsync(3000)
  expect(seen).toEqual([false])
  expect(poll).toHaveBeenCalledTimes(1)
})

it("routes errors to onError and keeps polling", async () => {
  const errors: unknown[] = []
  const poll = vi.fn(async () => { throw new Error("down") })
  const poller = createJobPoller({ intervalMs: 1000, poll, onError: (_key, error) => errors.push(error) })
  poller.track("a")
  await vi.advanceTimersByTimeAsync(2000)
  expect(errors).toHaveLength(3)
  expect(poll).toHaveBeenCalledTimes(3)
  poller.stopAll()
})

it("stopOnError untracks the key after the first error and stops polling it", async () => {
  const errors: unknown[] = []
  const poll = vi.fn(async () => { throw new Error("down") })
  const poller = createJobPoller({ intervalMs: 1000, poll, stopOnError: true, onError: (_key, error) => errors.push(error) })
  poller.track("a")
  await vi.advanceTimersByTimeAsync(3000)
  expect(poll).toHaveBeenCalledTimes(1)
  expect(errors).toHaveLength(1)
  expect(poller.isTracked("a")).toBe(false)
  expect(poller.size).toBe(0)
  poller.stopAll()
})

it("stopAll clears the timer so nothing polls after unmount", async () => {
  const poll = vi.fn(async () => {})
  const poller = createJobPoller({ intervalMs: 1000, poll })
  poller.track("a")
  poller.track("b")
  expect(poller.size).toBe(2)
  poller.stopAll()
  await vi.advanceTimersByTimeAsync(5000)
  expect(poll).toHaveBeenCalledTimes(2)
})
