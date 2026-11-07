import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { FEEDBACK_SCREENSHOT_MAX_BYTES, type FeedbackContext } from "../src/shared/feedback"
import { FEEDBACK_SNAPSHOT_EXPIRED, sendFeedbackDraft } from "../src/main/feedback/send"
import { captureFeedbackSnapshot, encodeScreenshot, FeedbackSnapshots, SCREENSHOT_MAX_WIDTH, watchFeedbackRenderer, type CapturedImage, type FeedbackRenderer } from "../src/main/feedback/capture"

/** A fake NativeImage whose JPEG size grows with width and quality, recording every encode. */
function fakeImage(width: number, bytesPerPixelAt100: number, log: Array<{ width: number; quality: number }> = []): CapturedImage {
  const height = Math.round(width * 0.625)
  return {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: ({ width: target }) => fakeImage(target, bytesPerPixelAt100, log),
    toJPEG: (quality) => {
      log.push({ width, quality })
      return new Uint8Array(Math.round(width * height * bytesPerPixelAt100 * (quality / 100)))
    },
  }
}

describe("encodeScreenshot", () => {
  it("downscales to at most 1600 px wide at quality 80 when that fits", () => {
    const log: Array<{ width: number; quality: number }> = []
    const bytes = encodeScreenshot(fakeImage(2880, 0.1, log))
    expect(bytes).not.toBeNull()
    expect(log).toEqual([{ width: SCREENSHOT_MAX_WIDTH, quality: 80 }])
  })

  it("keeps a narrow window at its own width", () => {
    const log: Array<{ width: number; quality: number }> = []
    encodeScreenshot(fakeImage(1024, 0.1, log))
    expect(log[0]).toEqual({ width: 1024, quality: 80 })
  })

  it("steps the quality and then the width down until it fits 1.5 MB", () => {
    const log: Array<{ width: number; quality: number }> = []
    const bytes = encodeScreenshot(fakeImage(2880, 3, log))
    expect(bytes).not.toBeNull()
    expect(bytes!.byteLength).toBeLessThanOrEqual(FEEDBACK_SCREENSHOT_MAX_BYTES)
    expect(log.slice(0, 5).map((entry) => entry.quality)).toEqual([80, 70, 60, 50, 40])
    expect(log.at(-1)!.width).toBeLessThan(SCREENSHOT_MAX_WIDTH)
  })

  it("gives up on an empty image or one that never fits", () => {
    expect(encodeScreenshot(fakeImage(0, 0.1))).toBeNull()
    expect(encodeScreenshot(fakeImage(1600, 100))).toBeNull()
  })
})

describe("FeedbackSnapshots", () => {
  const context: FeedbackContext = { appVersion: "0.4.1", os: "darwin", osVersion: "26.2", plan: "pro" }
  const ids = () => { let n = 0; return () => `opening-${++n}` }

  it("holds the screenshot, context and page of the current opening and returns only a small preview", () => {
    const held = new FeedbackSnapshots(ids())
    const id = held.begin()
    const snapshot = held.complete(id, context, "Tenants", fakeImage(2000, 0.1))!
    expect(Object.keys(snapshot).sort()).toEqual(["context", "id", "page", "preview"])
    expect(snapshot.id).toBe(id)
    expect(snapshot.preview!.startsWith("data:image/jpeg;base64,")).toBe(true)
    expect(held.current(id)).toMatchObject({ id, context, page: "Tenants" })
    expect(held.current(id)!.screenshot!.byteLength).toBeGreaterThan(0)
    held.discard(id)
    expect(held.current(id)).toBeNull()
  })

  it("makes a new random opening ID by default", () => {
    const held = new FeedbackSnapshots()
    expect(held.begin()).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("keeps the context when capture failed, without a screenshot", () => {
    const held = new FeedbackSnapshots(ids())
    const id = held.begin()
    expect(held.complete(id, context, undefined, null)).toEqual({ id, preview: null, context })
    expect(held.current(id)).toEqual({ id, context, screenshot: null })
    const throwing: CapturedImage = { ...fakeImage(1200, 0.1), resize: () => throwing, toJPEG: () => { throw new Error("encoder failed") } }
    const next = held.begin()
    expect(held.complete(next, context, undefined, throwing)!.preview).toBeNull()
    expect(held.current(next)!.screenshot).toBeNull()
  })

  it("refuses a stale or unknown opening ID", () => {
    const held = new FeedbackSnapshots(ids())
    const first = held.begin()
    held.complete(first, context, "Tenants", null)
    const second = held.begin()
    held.complete(second, context, "Settings", null)
    expect(held.current(first)).toBeNull()
    expect(held.current(undefined)).toBeNull()
    expect(held.current(42)).toBeNull()
    expect(held.current(second)).toMatchObject({ page: "Settings" })
    // Discarding the older opening leaves the newer one alone.
    held.discard(first)
    expect(held.current(second)).not.toBeNull()
  })
})

/** A promise to resolve by hand, to finish captures in a chosen order. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe("captureFeedbackSnapshot", () => {
  const context = (plan: FeedbackContext["plan"]): FeedbackContext => ({ appVersion: "0.4.1", os: "win32", plan })

  it("drops a capture that finishes after a newer opening completed", async () => {
    const held = new FeedbackSnapshots()
    const late = deferred<CapturedImage | null>()
    const a = captureFeedbackSnapshot(held, () => late.promise, () => context("pro"), "Tenants")
    const b = await captureFeedbackSnapshot(held, async () => fakeImage(1200, 0.1), () => context("msp"), "Settings")
    expect(b).toMatchObject({ page: "Settings" })
    late.resolve(fakeImage(1200, 0.1))
    expect(await a).toBeNull()
    expect(held.current(b!.id)).toMatchObject({ page: "Settings", context: { plan: "msp" } })
  })

  it("drops a capture that finishes after a newer opening started but before it finished", async () => {
    const held = new FeedbackSnapshots()
    const first = deferred<CapturedImage | null>()
    const second = deferred<CapturedImage | null>()
    const a = captureFeedbackSnapshot(held, () => first.promise, () => context("pro"), "Tenants")
    const b = captureFeedbackSnapshot(held, () => second.promise, () => context("msp"), "Settings")
    first.resolve(null)
    expect(await a).toBeNull()
    second.resolve(null)
    const shown = await b
    expect(held.current(shown!.id)).toMatchObject({ page: "Settings" })
  })

  it("leaves nothing sendable when the opening is discarded during the capture", async () => {
    const held = new FeedbackSnapshots(() => "opening-1")
    const pending = deferred<CapturedImage | null>()
    const opening = "opening-1"
    const capture = captureFeedbackSnapshot(held, () => pending.promise, () => context("pro"), "Tenants")
    held.discard(opening)
    pending.resolve(fakeImage(1200, 0.1))
    expect(await capture).toBeNull()
    expect(held.current(opening)).toBeNull()
  })

  it("drops a capture when the renderer reloads, crashes or closes meanwhile", async () => {
    for (const end of ["reload", "render-process-gone", "destroyed"] as const) {
      const held = new FeedbackSnapshots()
      const renderer = new EventEmitter()
      watchFeedbackRenderer(renderer as unknown as FeedbackRenderer, held)
      const pending = deferred<CapturedImage | null>()
      const capture = captureFeedbackSnapshot(held, () => pending.promise, () => context("pro"), "Tenants")
      if (end === "reload") renderer.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
      else renderer.emit(end)
      pending.resolve(null)
      expect(await capture, end).toBeNull()
    }
  })

  it("keeps the snapshot across in-page route changes and subframe navigations", async () => {
    const held = new FeedbackSnapshots()
    const renderer = new EventEmitter()
    watchFeedbackRenderer(renderer as unknown as FeedbackRenderer, held)
    const shown = await captureFeedbackSnapshot(held, async () => null, () => context("pro"), "Tenants")
    renderer.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
    renderer.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false })
    expect(held.current(shown!.id)).not.toBeNull()
    renderer.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    expect(held.current(shown!.id)).toBeNull()
  })

  it("refuses to send with a stale opening ID, with the expired message", async () => {
    const held = new FeedbackSnapshots()
    const stale = await captureFeedbackSnapshot(held, async () => null, () => context("pro"), "Tenants")
    const current = await captureFeedbackSnapshot(held, async () => null, () => context("pro"), "Settings")
    const post = vi.fn()
    const draft = { submissionId: "3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b", goal: "a", blocker: "b", includeScreenshot: false }
    await expect(sendFeedbackDraft(draft, held.current(stale!.id), post)).resolves.toEqual({ ok: false, kind: "rejected", message: FEEDBACK_SNAPSHOT_EXPIRED })
    expect(post).not.toHaveBeenCalled()
    post.mockResolvedValue({ ok: true })
    await expect(sendFeedbackDraft(draft, held.current(current!.id), post)).resolves.toEqual({ ok: true })
    expect(post.mock.calls[0]![0]).toMatchObject({ page: "Settings" })
  })

  it("still records the opening when the capture itself fails", async () => {
    const held = new FeedbackSnapshots()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const shown = await captureFeedbackSnapshot(held, async () => { throw new Error("capture failed") }, () => context("community"), undefined)
    expect(shown).toMatchObject({ preview: null, context: { plan: "community" } })
    expect(held.current(shown!.id)).toMatchObject({ screenshot: null })
    warn.mockRestore()
  })
})
