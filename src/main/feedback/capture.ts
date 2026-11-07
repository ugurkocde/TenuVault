import { randomUUID } from "node:crypto"
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
  /** The opening this snapshot belongs to. */
  id: string
  context: FeedbackContext
  page?: string
  screenshot: Uint8Array | null
}

/**
 * The snapshot of the current Share feedback opening, held in main-process memory until it is sent
 * or discarded: the encoded screenshot, and the context and page the dialog shows. Each opening gets
 * an ID made here. A capture that finishes after a newer opening started, after a discard or after
 * the renderer reloaded is dropped, and send only accepts the ID of the current snapshot, so what is
 * sent is always what the open dialog shows.
 */
export class FeedbackSnapshots {
  private opening: string | null = null
  private held: HeldFeedbackSnapshot | null = null

  constructor(private readonly newId: () => string = () => randomUUID()) {}

  /** Starts an opening before the window is captured; it replaces any earlier one. */
  begin(): string {
    this.opening = this.newId()
    this.held = null
    return this.opening
  }

  /**
   * Records the snapshot of an opening once its capture finished, and returns what the renderer may
   * see: a small preview, not the bytes. Null when the opening is no longer current.
   */
  complete(id: string, context: FeedbackContext, page: string | undefined, image: CapturedImage | null): FeedbackSnapshot | null {
    if (id !== this.opening) return null
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
    this.held = { id, context, ...(page ? { page } : {}), screenshot: preview ? screenshot : null }
    return { id, preview, context, ...(page ? { page } : {}) }
  }

  /** The snapshot for this opening ID, or null when it is not the current, completed opening. */
  current(id: unknown): HeldFeedbackSnapshot | null {
    return typeof id === "string" && id === this.opening && this.held?.id === id ? this.held : null
  }

  /** Ends the opening with this ID; an older ID leaves a newer opening alone. */
  discard(id: unknown): void {
    if (typeof id === "string" && id === this.opening) this.invalidate()
  }

  /** Ends whatever opening is current, for example when the renderer reloads or goes away. */
  invalidate(): void {
    this.opening = null
    this.held = null
  }
}

/**
 * Captures the window for a new opening and records its snapshot. Null when the opening was
 * replaced, discarded or invalidated while the capture ran: a late capture never replaces the
 * snapshot the open dialog shows. A failed capture only leaves the screenshot out.
 */
export async function captureFeedbackSnapshot(
  snapshots: FeedbackSnapshots,
  capture: () => Promise<CapturedImage | null>,
  context: () => FeedbackContext,
  page: string | undefined,
): Promise<FeedbackSnapshot | null> {
  const id = snapshots.begin()
  let image: CapturedImage | null = null
  try {
    image = await capture()
  } catch {
    console.warn("[feedback] Could not capture the window")
  }
  return snapshots.complete(id, context(), page, image)
}

/** The renderer events that end an opening: a new document, a crashed renderer or a closed window. */
export interface FeedbackRenderer {
  on(event: "did-start-navigation", listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown
  on(event: "render-process-gone" | "destroyed", listener: () => void): unknown
}

/**
 * Invalidates the current opening when its renderer reloads, navigates to another document, crashes
 * or is destroyed. In-page route changes (the hash router) keep it.
 */
export function watchFeedbackRenderer(renderer: FeedbackRenderer, snapshots: FeedbackSnapshots): void {
  renderer.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) snapshots.invalidate()
  })
  renderer.on("render-process-gone", () => snapshots.invalidate())
  renderer.on("destroyed", () => snapshots.invalidate())
}
