import { FEEDBACK_SCREENSHOT_MAX_BYTES, type FeedbackContext, type FeedbackSnapshot } from "../../shared/feedback"

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

export interface HeldFeedbackSnapshot {
  context: FeedbackContext
  page?: string
  screenshot: Uint8Array | null
}

/**
 * The snapshot of one Share feedback opening, held in main-process memory until it is sent or
 * discarded: the encoded screenshot, and the context and page the dialog shows. Send uses exactly
 * this snapshot, never a fresh one.
 */
export class FeedbackSnapshots {
  private held: HeldFeedbackSnapshot | null = null

  /** Records a new snapshot and returns what the renderer may see: a small preview, not the bytes. */
  open(context: FeedbackContext, page: string | undefined, image: CapturedImage | null): FeedbackSnapshot {
    this.held = null
    let screenshot: Uint8Array | null = null
    let preview: string | null = null
    if (image) {
      try {
        screenshot = encodeScreenshot(image)
        if (screenshot) preview = previewDataUrl(image)
      } catch {
        screenshot = null
        preview = null
      }
    }
    this.held = { context, ...(page ? { page } : {}), screenshot: preview ? screenshot : null }
    return { preview, context, ...(page ? { page } : {}) }
  }

  current(): HeldFeedbackSnapshot | null {
    return this.held
  }

  discard(): void {
    this.held = null
  }
}
