import { describe, expect, it } from "vitest"
import { FEEDBACK_SCREENSHOT_MAX_BYTES } from "../src/shared/feedback"
import { encodeScreenshot, FeedbackScreenshot, SCREENSHOT_MAX_WIDTH, type CapturedImage } from "../src/main/feedback/capture"

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

describe("FeedbackScreenshot", () => {
  it("holds the bytes in memory and returns only a small preview", () => {
    const held = new FeedbackScreenshot()
    const capture = held.store(fakeImage(2000, 0.1))
    expect(capture).not.toBeNull()
    expect(Object.keys(capture!)).toEqual(["preview"])
    expect(capture!.preview.startsWith("data:image/jpeg;base64,")).toBe(true)
    expect(held.current()!.byteLength).toBeGreaterThan(0)
    held.discard()
    expect(held.current()).toBeNull()
  })

  it("drops an earlier capture when a new one fails", () => {
    const held = new FeedbackScreenshot()
    held.store(fakeImage(1200, 0.1))
    expect(held.store(fakeImage(0, 0.1))).toBeNull()
    expect(held.current()).toBeNull()
  })
})
