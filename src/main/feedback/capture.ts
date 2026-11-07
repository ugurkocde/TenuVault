import { FEEDBACK_SCREENSHOT_MAX_BYTES, type FeedbackCapture } from "../../shared/feedback"

/** The part of Electron's NativeImage the encoder uses, so it can be tested without Electron. */
export interface CapturedImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; quality?: "good" | "better" | "best" }): CapturedImage
  toJPEG(quality: number): Uint8Array
}

export const SCREENSHOT_MAX_WIDTH = 1600
const SCREENSHOT_MIN_WIDTH = 640
const SCREENSHOT_QUALITIES = [80, 70, 60, 50, 40]
const PREVIEW_WIDTH = 480

/**
 * Encodes the window as a JPEG of at most 1600 px wide and FEEDBACK_SCREENSHOT_MAX_BYTES, stepping
 * the quality and then the width down until it fits. Null when the image is empty or never fits.
 */
export function encodeScreenshot(image: CapturedImage, maxBytes = FEEDBACK_SCREENSHOT_MAX_BYTES): Uint8Array | null {
  if (image.isEmpty()) return null
  const { width } = image.getSize()
  if (!width) return null
  for (let target = Math.min(width, SCREENSHOT_MAX_WIDTH); ; target = Math.round(target * 0.75)) {
    const scaled = image.resize({ width: target, quality: "better" })
    for (const quality of SCREENSHOT_QUALITIES) {
      const bytes = scaled.toJPEG(quality)
      if (bytes.byteLength > 0 && bytes.byteLength <= maxBytes) return bytes
    }
    if (target <= SCREENSHOT_MIN_WIDTH) return null
  }
}

export function previewDataUrl(image: CapturedImage): string {
  const width = Math.min(image.getSize().width, PREVIEW_WIDTH)
  const bytes = image.resize({ width, quality: "good" }).toJPEG(70)
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`
}

/** Holds the latest window capture in main-process memory until it is sent or discarded. */
export class FeedbackScreenshot {
  private bytes: Uint8Array | null = null

  /** Keeps the encoded screenshot and returns only a small preview for the renderer. */
  store(image: CapturedImage): FeedbackCapture | null {
    this.bytes = null
    const bytes = encodeScreenshot(image)
    if (!bytes) return null
    const preview = previewDataUrl(image)
    this.bytes = bytes
    return { preview }
  }

  current(): Uint8Array | null {
    return this.bytes
  }

  discard(): void {
    this.bytes = null
  }
}
