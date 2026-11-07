import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import type { LicenseStatus, TenantLicenseStatus } from "../src/shared/ipc"
import { FEEDBACK_SCREENSHOT_MAX_BYTES, type FeedbackContext } from "../src/shared/feedback"
import {
  buildFeedbackPayload,
  feedbackContext,
  feedbackPlan,
  mapFeedbackResponse,
  postFeedback,
  retryAfterSeconds,
  validateFeedbackInput,
  FeedbackInputError,
  FEEDBACK_SNAPSHOT_EXPIRED,
  sendFeedbackDraft,
  type FeedbackPayload,
  FEEDBACK_REQUEST_TIMEOUT_MS,
} from "../src/main/feedback/send"

const SUBMISSION = "3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b"
const TENANT = "11111111-2222-4333-8444-555555555555"

const input = (overrides: Record<string, unknown> = {}) => ({
  submissionId: SUBMISSION,
  goal: "  Restore a policy  ",
  blocker: "The button was greyed out",
  includeScreenshot: false,
  ...overrides,
})

const status = (overrides: Partial<LicenseStatus> = {}, tenants: Partial<TenantLicenseStatus>[] = []): LicenseStatus => ({
  hasKey: false,
  keyState: "none",
  keyMessage: null,
  keyHint: null,
  persisted: true,
  offline: false,
  message: null,
  plan: null,
  tenantLimit: null,
  validUntil: null,
  communityTenantId: null,
  tenants: tenants.map((tenant) => ({
    tenantId: TENANT,
    signedIn: true,
    activated: false,
    entitled: false,
    source: null,
    plan: null,
    tenants: null,
    expiresAt: null,
    validUntil: null,
    shared: null,
    shareNeedsSignIn: false,
    displayKey: null,
    message: null,
    ...tenant,
  })),
  ...overrides,
})

const context: FeedbackContext = { appVersion: "0.4.1", os: "darwin", osVersion: "26.2", plan: "community" }

describe("validateFeedbackInput", () => {
  it("trims answers and accepts the optional fields", () => {
    expect(validateFeedbackInput(input({ replyTo: " admin@contoso.com " }))).toEqual({
      submissionId: SUBMISSION,
      goal: "Restore a policy",
      blocker: "The button was greyed out",
      replyTo: "admin@contoso.com",
      includeScreenshot: false,
    })
  })

  it("treats an empty reply-to address as none", () => {
    expect(validateFeedbackInput(input({ replyTo: "  " })).replyTo).toBeUndefined()
  })

  it.each([
    ["not an object", null],
    ["an array", []],
    ["an unknown key", input({ tenantId: TENANT })],
    ["a missing submission ID", input({ submissionId: undefined })],
    ["a submission ID that is not a UUID", input({ submissionId: "draft-1" })],
    ["a missing screenshot choice", input({ includeScreenshot: "yes" })],
    ["an empty goal", input({ goal: "   " })],
    ["a goal that is not text", input({ goal: 42 })],
    ["an empty blocker", input({ blocker: "" })],
    ["a goal over 500 characters", input({ goal: "a".repeat(501) })],
    ["a blocker over 500 characters", input({ blocker: "b".repeat(501) })],
    ["an invalid reply-to address", input({ replyTo: "admin at contoso" })],
    ["a reply-to address over 254 characters", input({ replyTo: `${"a".repeat(250)}@contoso.com` })],
    ["a reply-to address that is not text", input({ replyTo: 5 })],
    ["a page from the renderer, which comes from the snapshot instead", input({ page: "Drift Detection" })],
    ["a route as the page", input({ page: `/portal/drift?tenant=${TENANT}` })],
    ["context from the renderer", input({ plan: "msp" })],
    ["a reply-to address the service's email rule refuses: leading dot", input({ replyTo: ".admin@example.com" })],
    ["a reply-to address the service's email rule refuses: double dot", input({ replyTo: "a..b@example.com" })],
    ["a reply-to address the service's email rule refuses: one letter TLD", input({ replyTo: "admin@example.c" })],
    ["a goal with NUL", input({ goal: "Restore\u0000 a policy" })],
    ["a blocker with an unpaired surrogate", input({ blocker: "It failed \uD83D" })],
  ])("rejects %s", (_name, value) => {
    expect(() => validateFeedbackInput(value)).toThrow()
  })

  it("names the field it refuses, so the dialog can mark it", () => {
    const refusal = (value: unknown) => { try { validateFeedbackInput(value) } catch (error) { return error } }
    expect(refusal(input({ goal: "a\u0000" }))).toMatchObject({ field: "goal", message: "Remove unsupported characters." })
    expect(refusal(input({ blocker: "\uDC00" }))).toMatchObject({ field: "blocker" })
    expect(refusal(input({ replyTo: "a..b@example.com" }))).toMatchObject({ field: "replyTo" })
    expect(refusal(input({ submissionId: "x" }))).toBeInstanceOf(FeedbackInputError)
    expect((refusal(input({ submissionId: "x" })) as FeedbackInputError).field).toBeUndefined()
  })

  it("accepts a full emoji, which is a valid surrogate pair", () => {
    expect(validateFeedbackInput(input({ goal: "Restore \u{1F600}" })).goal).toBe("Restore \u{1F600}")
  })

  it("accepts answers of exactly 500 characters", () => {
    expect(validateFeedbackInput(input({ goal: "a".repeat(500), blocker: "b".repeat(500) })).goal).toHaveLength(500)
  })
})

describe("buildFeedbackPayload", () => {
  it("contains exactly the contract keys, with no screenshot unless ticked", () => {
    const payload = buildFeedbackPayload(validateFeedbackInput(input({ replyTo: "admin@contoso.com" })), { context, page: "Backup & Restore", screenshot: new Uint8Array([1, 2, 3]) })
    expect(Object.keys(payload).sort()).toEqual(["appVersion", "blocker", "goal", "os", "osVersion", "page", "plan", "replyTo", "submissionId"])
    expect(payload).not.toHaveProperty("screenshot")
  })

  it("leaves out optional keys that have no value", () => {
    const payload = buildFeedbackPayload(validateFeedbackInput(input()), { context: { appVersion: "0.4.1", os: "win32", plan: "none" }, screenshot: null })
    expect(Object.keys(payload).sort()).toEqual(["appVersion", "blocker", "goal", "os", "plan", "submissionId"])
  })

  it("attaches the held screenshot as base64 JPEG only when ticked", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const payload = buildFeedbackPayload(validateFeedbackInput(input({ includeScreenshot: true })), { context, screenshot: bytes })
    expect(payload.screenshot).toEqual({ mime: "image/jpeg", data: Buffer.from(bytes).toString("base64") })
    expect(Buffer.from(payload.screenshot!.data, "base64").byteLength).toBeLessThanOrEqual(FEEDBACK_SCREENSHOT_MAX_BYTES)
  })

  it("refuses a ticked screenshot that is no longer held or is too large", () => {
    const ticked = validateFeedbackInput(input({ includeScreenshot: true }))
    expect(() => buildFeedbackPayload(ticked, { context, screenshot: null })).toThrow(/no longer available/)
    expect(() => buildFeedbackPayload(ticked, { context, screenshot: new Uint8Array(FEEDBACK_SCREENSHOT_MAX_BYTES + 1) })).toThrow(/too large/)
  })

  it("never includes installation, tenant or license identifiers", () => {
    const licensed = status({ hasKey: true, keyHint: "****ABCD", plan: "pro", communityTenantId: TENANT }, [{ entitled: true, plan: "pro", displayKey: "****ABCDEF" }])
    const ctx = feedbackContext({ appVersion: "0.4.1", platform: "win32", systemVersion: "10.0.26100", status: licensed })
    const body = JSON.stringify(buildFeedbackPayload(validateFeedbackInput(input()), { context: ctx, page: "Tenants", screenshot: null }))
    expect(body).not.toContain(TENANT)
    expect(body).not.toContain("ABCD")
    expect(body).not.toMatch(/install/i)
    expect(body).not.toContain("/portal")
  })
})

describe("feedbackContext", () => {
  it("fills the app version, operating system and a version of at most 64 characters", () => {
    expect(feedbackContext({ appVersion: "0.4.1", platform: "darwin", systemVersion: "26.2", status: status() })).toEqual({ appVersion: "0.4.1", os: "darwin", osVersion: "26.2", plan: "community" })
    expect(feedbackContext({ appVersion: "0.4.1", platform: "linux", systemVersion: "x".repeat(80), status: status() }).osVersion).toHaveLength(64)
    expect(feedbackContext({ appVersion: "0.4.1", platform: "win32", systemVersion: " ", status: status() })).not.toHaveProperty("osVersion")
  })
})

describe("feedbackPlan", () => {
  it("uses the plan of this machine's key first", () => {
    expect(feedbackPlan(status({ hasKey: true, plan: "msp" }, [{ plan: "community" }]))).toBe("msp")
    expect(feedbackPlan(status({ hasKey: true, plan: "pro" }))).toBe("pro")
  })

  it("then a paid license shared with a tenant, MSP over Pro", () => {
    expect(feedbackPlan(status({}, [{ entitled: true, source: "tenant", plan: "pro" }]))).toBe("pro")
    expect(feedbackPlan(status({}, [{ entitled: true, plan: "pro" }, { entitled: true, plan: "msp" }]))).toBe("msp")
  })

  it("ignores a paid tenant license that is not entitled any more", () => {
    expect(feedbackPlan(status({}, [{ entitled: false, plan: "pro" }]))).toBe("none")
  })

  it("then Community when a tenant uses the free plan", () => {
    expect(feedbackPlan(status({}, [{ plan: "community" }]))).toBe("community")
    expect(feedbackPlan(status({ communityTenantId: TENANT }))).toBe("community")
  })

  it("is none for a failed key even with a Community tenant, as the License chip shows Inactive", () => {
    expect(feedbackPlan(status({ hasKey: true, keyState: "failed", communityTenantId: TENANT }, [{ plan: "community" }]))).toBe("none")
  })

  it("is Community on a machine without a key and without uncovered tenants, as the License chip shows", () => {
    expect(feedbackPlan(status())).toBe("community")
    expect(feedbackPlan(status({}, [{ signedIn: false, activated: true }]))).toBe("community")
  })

  it("is none while the key failed or is pending, or a signed-in tenant is not covered", () => {
    expect(feedbackPlan(status({ hasKey: true, keyState: "failed" }))).toBe("none")
    expect(feedbackPlan(status({ hasKey: true, keyState: "pending" }))).toBe("none")
    expect(feedbackPlan(status({}, [{ signedIn: true, entitled: false, plan: null }]))).toBe("none")
  })
})

describe("mapFeedbackResponse", () => {
  it("accepts 200 with ok true only", () => {
    expect(mapFeedbackResponse(200, null, { ok: true })).toEqual({ ok: true })
    expect(mapFeedbackResponse(200, null, null)).toMatchObject({ ok: false, kind: "server" })
  })

  it("shows the service's reason for 400", () => {
    expect(mapFeedbackResponse(400, null, { error: "Goal is too long.", fields: ["goal"] })).toEqual({ ok: false, kind: "rejected", message: "Goal is too long." })
    expect(mapFeedbackResponse(400, null, null)).toMatchObject({ ok: false, kind: "rejected" })
  })

  it("passes the service's field messages for the answers and the reply-to address", () => {
    const body = { error: "Check your feedback and try again.", fields: { replyTo: "Enter a valid email address.", goal: "Remove unsupported characters.", appVersion: "Invalid", blocker: 5 } }
    expect(mapFeedbackResponse(400, null, body)).toEqual({
      ok: false,
      kind: "rejected",
      message: "Check your feedback and try again.",
      fields: { replyTo: "Enter a valid email address.", goal: "Remove unsupported characters." },
    })
    expect(mapFeedbackResponse(400, null, { error: "Bad", fields: { appVersion: "Invalid" } })).not.toHaveProperty("fields")
  })

  it("maps 413 and 415 to rejected", () => {
    expect(mapFeedbackResponse(413, null, null)).toMatchObject({ ok: false, kind: "rejected", message: expect.stringMatching(/screenshot/) })
    expect(mapFeedbackResponse(415, null, null)).toMatchObject({ ok: false, kind: "rejected" })
  })

  it("says when to try again after 429", () => {
    expect(mapFeedbackResponse(429, "120", { error: "Too many requests" })).toEqual({ ok: false, kind: "rate_limited", message: "Too much feedback was sent from this network. Try again in 2 minutes.", retryAfterSeconds: 120 })
    expect(mapFeedbackResponse(429, "30", null)).toMatchObject({ retryAfterSeconds: 30, message: expect.stringContaining("in 30 seconds") })
    expect(mapFeedbackResponse(429, "1", null)).toMatchObject({ message: expect.stringContaining("in 1 second.") })
    const result = mapFeedbackResponse(429, null, null)
    expect(result).toMatchObject({ kind: "rate_limited", message: expect.stringContaining("in a few minutes") })
    expect(result).not.toHaveProperty("retryAfterSeconds")
  })

  it("reads Retry-After as seconds or an HTTP date", () => {
    expect(retryAfterSeconds("90")).toBe(90)
    expect(retryAfterSeconds(new Date(Date.UTC(2026, 10, 7, 12, 1, 0)).toUTCString(), Date.UTC(2026, 10, 7, 12, 0, 0))).toBe(60)
    expect(retryAfterSeconds("soon")).toBeUndefined()
  })

  it("maps 5xx to server, with the service's message when it gives one", () => {
    expect(mapFeedbackResponse(503, null, { error: "Feedback is paused." })).toEqual({ ok: false, kind: "server", message: "Feedback is paused." })
    expect(mapFeedbackResponse(502, null, null)).toMatchObject({ ok: false, kind: "server", message: expect.stringContaining("Copy as email") })
  })

  it("treats 404 as a normal failure while the endpoint is not deployed", () => {
    expect(mapFeedbackResponse(404, null, { error: "Not found" })).toMatchObject({ ok: false, kind: "server", message: expect.stringContaining("not available") })
  })

  it("strips control characters and caps the service's message", () => {
    const result = mapFeedbackResponse(400, null, { error: `bad\u0000\ninput${"x".repeat(400)}` })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message.startsWith("bad input")).toBe(true)
      expect(result.message.length).toBeLessThanOrEqual(300)
    }
  })
})

describe("postFeedback", () => {
  const payload = buildFeedbackPayload(validateFeedbackInput(input()), { context, screenshot: null })
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } })

  it("posts JSON to the feedback endpoint without following redirects and with a 20 second timeout", async () => {
    const fetchImpl = vi.fn(async () => json(200, { ok: true }))
    const timeout = vi.spyOn(AbortSignal, "timeout")
    await expect(postFeedback(fetchImpl as unknown as typeof fetch, "https://www.tenuvault.com", payload)).resolves.toEqual({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://www.tenuvault.com/api/desktop-feedback")
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { "Content-Type": "application/json" } })
    expect(JSON.parse(init.body as string)).toEqual(payload)
    expect(timeout).toHaveBeenCalledWith(FEEDBACK_REQUEST_TIMEOUT_MS)
    expect(FEEDBACK_REQUEST_TIMEOUT_MS).toBe(20_000)
    timeout.mockRestore()
  })

  it("passes Retry-After from a 429", async () => {
    const fetchImpl = async () => json(429, { error: "Slow down" }, { "retry-after": "60" })
    await expect(postFeedback(fetchImpl as unknown as typeof fetch, "https://www.tenuvault.com", payload)).resolves.toMatchObject({ kind: "rate_limited", retryAfterSeconds: 60 })
  })

  it("does not trust an HTML page from a proxy", async () => {
    const fetchImpl = async () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } })
    await expect(postFeedback(fetchImpl as unknown as typeof fetch, "https://www.tenuvault.com", payload)).resolves.toMatchObject({ ok: false, kind: "server" })
  })

  it("maps a timeout while reading the answer to network, and invalid JSON to server", async () => {
    const stalled = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("The operation timed out.", "TimeoutError")) } }), { status: 200, headers: { "content-type": "application/json" } })
    await expect(postFeedback((async () => stalled) as unknown as typeof fetch, "https://www.tenuvault.com", payload)).resolves.toMatchObject({ ok: false, kind: "network", message: expect.stringContaining("timed out") })
    const broken = new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })
    await expect(postFeedback((async () => broken) as unknown as typeof fetch, "https://www.tenuvault.com", payload)).resolves.toMatchObject({ ok: false, kind: "server" })
  })

  it("maps a 404 page without JSON to a normal failure", async () => {
    const fetchImpl = async () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } })
    await expect(postFeedback(fetchImpl as unknown as typeof fetch, "https://www.tenuvault.com", payload)).resolves.toMatchObject({ ok: false, kind: "server" })
  })

  it("maps a network error to network", async () => {
    const fetchImpl = async () => { throw new TypeError("net::ERR_INTERNET_DISCONNECTED") }
    await expect(postFeedback(fetchImpl as unknown as typeof fetch, "https://www.tenuvault.com", payload)).resolves.toMatchObject({ ok: false, kind: "network", message: expect.stringContaining("could not reach") })
  })

  it("maps a timeout to network", async () => {
    const fetchImpl = async () => { throw new DOMException("The operation timed out.", "TimeoutError") }
    await expect(postFeedback(fetchImpl as unknown as typeof fetch, "https://www.tenuvault.com", payload)).resolves.toMatchObject({ ok: false, kind: "network", message: expect.stringContaining("timed out") })
  })
})

describe("sendFeedbackDraft", () => {
  const snapshot = { context, page: "Drift Detection", screenshot: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }

  it("sends the snapshot recorded when the dialog opened, with the screenshot only when ticked", async () => {
    const post = vi.fn(async (_payload: FeedbackPayload) => ({ ok: true }) as const)
    await expect(sendFeedbackDraft(input(), snapshot, post)).resolves.toEqual({ ok: true })
    expect(post.mock.calls[0]![0]).toMatchObject({ appVersion: "0.4.1", os: "darwin", osVersion: "26.2", plan: "community", page: "Drift Detection" })
    expect(post.mock.calls[0]![0]).not.toHaveProperty("screenshot")
    await sendFeedbackDraft(input({ includeScreenshot: true }), snapshot, post)
    expect(post.mock.calls[1]![0]).toHaveProperty("screenshot")
  })

  it("fails clearly without a snapshot instead of reading fresh details", async () => {
    const post = vi.fn()
    await expect(sendFeedbackDraft(input(), null, post)).resolves.toEqual({ ok: false, kind: "rejected", message: FEEDBACK_SNAPSHOT_EXPIRED })
    expect(post).not.toHaveBeenCalled()
  })

  it("returns the refused field without posting", async () => {
    const post = vi.fn()
    await expect(sendFeedbackDraft(input({ replyTo: ".admin@example.com" }), snapshot, post)).resolves.toMatchObject({ ok: false, kind: "rejected", fields: { replyTo: expect.any(String) } })
    await expect(sendFeedbackDraft(input({ page: "Tenants" }), snapshot, post)).resolves.toMatchObject({ ok: false, kind: "rejected" })
    expect(post).not.toHaveBeenCalled()
  })
})

describe("feedback IPC wiring", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

  it("registers every channel the preload bridge invokes", () => {
    const preload = read("../src/preload/index.ts")
    const main = read("../src/main/index.ts")
    for (const channel of ["feedback:capture", "feedback:send", "feedback:discardCapture"]) {
      expect(preload).toContain(`invoke("${channel}"`)
      expect(main).toContain(`handleTrusted("${channel}"`)
    }
    expect(preload).toContain(`capture: (page) => invoke("feedback:capture", page)`)
    // Send uses the stored snapshot; only the capture handler reads the context.
    expect(main.match(/feedbackContext\(/g)).toHaveLength(1)
    expect(main).toContain("sendFeedbackDraft(raw, snapshot,")
  })
})
