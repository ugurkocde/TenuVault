import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SetupDiagnostics, ATTEMPT_LIMIT, MAX_EVENT_AGE_MS, QUEUE_LIMIT, REQUEST_TIMEOUT_MS, SEND_DELAY_MS, WINDOW_MS, type SetupDiagnosticsOptions } from "../src/main/setup-diagnostics/service"
import { diagnosticCode, firstLaunchProps, isNetworkFolder, reasonCode, rendererEvent, signInResult, validEvent, type SetupEvent } from "../src/main/setup-diagnostics/events"
import { firstBackupEvent, isSetupError, licenseEvent, licenseFailureEvent, signInEvent } from "../src/main/setup-diagnostics/hooks"
import { registrationEvent, SignInTimeoutError } from "../src/main/auth/app-registration-setup"
import { ExplainedSignInError, firstSignInError, SignInCancelledError } from "../src/main/auth/msal"
import { LICENSE_REQUIRED, LicenseDenied } from "../src/main/license/service"
import { CommunityChoicePendingError, CommunityLimitError } from "../src/shared/plan-errors"
import { NetworkUnreachableError, ProxyAuthRequiredError } from "../src/main/api/network-error"
import { memoryStore } from "./helpers"

const KEY = "setupDiagnostics.state"
const URL = "https://www.tenuvault.com/api/desktop-events"
const START = Date.parse("2026-11-13T10:00:00.000Z")

interface Sent { url: string; init: RequestInit; body: { schema: number; funnelId: string; appVersion: string; os: string; channel: string; events: SetupEvent[] } }

function harness(overrides: Partial<SetupDiagnosticsOptions> & { responses?: Array<Response | Error> } = {}) {
  const store = overrides.store ?? memoryStore()
  let now = START
  const sent: Sent[] = []
  const responses = overrides.responses ?? []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) })
    const next = responses.shift() ?? new Response(JSON.stringify({ accepted: 1 }), { status: 202 })
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof globalThis.fetch
  const make = () => new SetupDiagnostics({
    store,
    freshInstall: true,
    policy: false,
    url: URL,
    fetch,
    envelope: { appVersion: "0.5.3", os: "darwin", channel: "stable" },
    firstLaunch: () => ({ osVersion: "15.2", arch: "arm64", managedInstall: false }),
    now: () => now,
    ...overrides,
  })
  return { store, sent, fetch, make, advance: (ms: number) => { now += ms }, setNow: (value: number) => { now = value }, saved: () => JSON.parse(store.get(KEY) ?? "null") }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("eligibility", () => {
  it("asks a fresh install and stores only the answer state, no funnel ID or queue", () => {
    const h = harness()
    const diagnostics = h.make()
    expect(diagnostics.status()).toEqual({ state: "unasked", policy: false, reminder: { setup: false, signin: false } })
    const saved = h.saved()
    expect(saved).toMatchObject({ state: "unasked", queue: [], nextSeq: 1, sentOnce: [] })
    expect(saved.funnelId).toBeUndefined()
    expect(saved.firstLaunchAt).toBeUndefined()
  })

  it("never asks an install that already had saved state, and keeps that decision", () => {
    const h = harness({ freshInstall: false })
    const diagnostics = h.make()
    expect(diagnostics.status().state).toBe("ineligible")
    expect(() => diagnostics.consent("welcome")).toThrow("no longer available")
    diagnostics.record({ name: "welcome_continue" })
    // A later launch reads the decision, even though the store is not empty any more.
    expect(harness({ store: h.store, freshInstall: true }).make().status().state).toBe("ineligible")
    expect(h.saved().queue).toEqual([])
  })

  it("treats an unreadable saved state as ineligible", () => {
    const store = memoryStore()
    store.set(KEY, "{not json")
    expect(harness({ store }).make().status().state).toBe("ineligible")
  })

  it("decides once and keeps the answer across launches", () => {
    const h = harness()
    h.make().consent("welcome")
    const again = harness({ store: h.store, freshInstall: false }).make()
    expect(again.status().state).toBe("granted")
  })
})

describe("nothing before consent", () => {
  it("drops events before an answer and sends nothing", async () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.start()
    diagnostics.record({ name: "welcome_continue" })
    diagnostics.record({ name: "setup_route", props: { route: "auto" } })
    diagnostics.record({ name: "signin", props: { result: "failed", code: "AADSTS53003", explained: true } })
    await vi.advanceTimersByTimeAsync(60_000)
    await diagnostics.flush()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.saved().queue).toEqual([])
    expect(h.saved().funnelId).toBeUndefined()
  })

  it("holds the last setup error in memory only, for the reminder", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.record({ name: "setup_signin", props: { result: "failed", code: "AADSTS53003" } }, "setup")
    expect(diagnostics.status().reminder).toEqual({ setup: true, signin: false })
    expect(h.store.get(KEY)).not.toContain("AADSTS53003")
    diagnostics.reminderShown()
    expect(diagnostics.status().reminder.setup).toBe(false)
    // Once shown, later errors are not held for a second reminder.
    diagnostics.record({ name: "signin", props: { result: "failed", code: "AADSTS50020", explained: true } }, "signin")
    expect(diagnostics.status().reminder.signin).toBe(false)
    expect(harness({ store: h.store }).make().status().reminder).toEqual({ setup: false, signin: false })
  })
})

describe("consent", () => {
  it("creates a funnel ID and records consent then first_launch, in order", async () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    const saved = h.saved()
    expect(saved.funnelId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(saved.firstLaunchAt).toBe(START)
    expect(saved.queue.map((event: SetupEvent) => [event.seq, event.name, event.props])).toEqual([
      [1, "consent", { where: "welcome" }],
      [2, "first_launch", { osVersion: "15.2", arch: "arm64", managedInstall: false }],
    ])
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS)
    expect(h.sent).toHaveLength(1)
    const [request] = h.sent
    expect(request!.url).toBe(URL)
    expect(request!.init).toMatchObject({ method: "POST", redirect: "error", headers: { "Content-Type": "application/json" } })
    expect(request!.init.signal).toBeInstanceOf(AbortSignal)
    expect(request!.body).toEqual({ schema: 1, funnelId: saved.funnelId, appVersion: "0.5.3", os: "darwin", channel: "stable", events: saved.queue })
    expect(Object.keys(request!.body).sort()).toEqual(["appVersion", "channel", "events", "funnelId", "os", "schema"])
    expect(h.saved().queue).toEqual([])
  })

  it("from the error reminder, shares that error after first_launch", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.record({ name: "signin", props: { result: "failed", code: "AADSTS53003", explained: true } }, "signin")
    h.advance(1000)
    diagnostics.consent("error", "signin")
    expect(h.saved().queue.map((event: SetupEvent) => event.name)).toEqual(["consent", "first_launch", "signin"])
    expect(h.saved().queue[0].props).toEqual({ where: "error" })
    // The error keeps the time it happened.
    expect(h.saved().queue[2].at).toBe(new Date(START).toISOString())
    expect(diagnostics.status().reminder).toEqual({ setup: false, signin: false })
  })

  it("shares only the error of the step the reminder was shown for", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.record({ name: "registration", props: { result: "failed", phase: "consent", code: "HTTP_403" } }, "setup")
    diagnostics.consent("error", "signin")
    expect(h.saved().queue.map((event: SetupEvent) => event.name)).toEqual(["consent", "first_launch"])
  })

  it("validates where and step", () => {
    const diagnostics = harness().make()
    expect(() => diagnostics.consent("elsewhere")).toThrow("Unknown consent place")
    expect(() => diagnostics.consent("error", "backup")).toThrow("Unknown setup step")
  })

  it("is idempotent once granted", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    const id = h.saved().funnelId
    diagnostics.consent("settings")
    expect(h.saved().funnelId).toBe(id)
    expect(h.saved().queue).toHaveLength(2)
  })
})

describe("decline and opt-out", () => {
  it("\"Don't share\" is final for the question and the reminder", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.record({ name: "setup_signin", props: { result: "timeout" } }, "setup")
    diagnostics.decline()
    expect(diagnostics.status()).toEqual({ state: "declined", policy: false, reminder: { setup: false, signin: false } })
    diagnostics.record({ name: "setup_signin", props: { result: "timeout" } }, "setup")
    expect(diagnostics.status().reminder.setup).toBe(false)
    expect(h.saved().funnelId).toBeUndefined()
  })

  it("turning it off deletes the funnel ID and the queue, and sends nothing more", async () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    diagnostics.record({ name: "welcome_continue" })
    expect(h.saved().queue).toHaveLength(3)
    diagnostics.decline()
    const saved = h.saved()
    expect(saved).toMatchObject({ state: "declined", queue: [], nextSeq: 1, sentOnce: [] })
    expect(saved.funnelId).toBeUndefined()
    expect(saved.firstLaunchAt).toBeUndefined()
    diagnostics.record({ name: "setup_route", props: { route: "auto" } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it("opting back in from Settings within the 30 days starts a new funnel ID", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    const first = h.saved().funnelId
    diagnostics.decline()
    h.advance(3 * 86_400_000)
    diagnostics.consent("settings")
    const saved = h.saved()
    expect(saved.funnelId).not.toBe(first)
    expect(saved.queue.map((event: SetupEvent) => [event.seq, event.name])).toEqual([[1, "consent"], [2, "first_launch"]])
  })

  it("drops the answer of a request that was running when the admin turned it off", async () => {
    let release!: (response: Response) => void
    const store = memoryStore()
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve })) as unknown as typeof globalThis.fetch
    const diagnostics = harness({ store, fetch }).make()
    diagnostics.consent("welcome")
    const flushing = diagnostics.flush()
    diagnostics.decline()
    release(new Response(null, { status: 503 }))
    await flushing
    expect(JSON.parse(store.get(KEY)!)).toMatchObject({ state: "declined", queue: [] })
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe("30-day window", () => {
  it("ends 30 days after install: deletes everything and refuses consent", async () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    h.advance(WINDOW_MS)
    diagnostics.record({ name: "welcome_continue" })
    expect(diagnostics.status().state).toBe("ended")
    const saved = h.saved()
    expect(saved.funnelId).toBeUndefined()
    expect(saved.queue).toEqual([])
    await diagnostics.flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(() => diagnostics.consent("settings")).toThrow("no longer available")
  })

  it("ends an unanswered or declined install too, and a later launch stays ended", () => {
    const h = harness()
    h.make()
    h.advance(WINDOW_MS + 1)
    expect(h.make().status().state).toBe("ended")
    const declined = harness()
    declined.make().decline()
    declined.advance(WINDOW_MS)
    expect(declined.make().status().state).toBe("ended")
  })

  it("does not reopen sharing after the window when consent came late from Settings", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.decline()
    h.advance(29 * 86_400_000)
    diagnostics.consent("settings")
    h.advance(86_400_000)
    expect(diagnostics.status().state).toBe("ended")
  })
})

describe("policy", () => {
  it("asks nothing, keeps nothing and sends nothing", async () => {
    const h = harness({ policy: true })
    const diagnostics = h.make()
    expect(diagnostics.status()).toEqual({ state: "unasked", policy: true, reminder: { setup: false, signin: false } })
    diagnostics.record({ name: "setup_signin", props: { result: "failed", code: "AADSTS53003" } }, "setup")
    expect(diagnostics.status().reminder.setup).toBe(false)
    expect(() => diagnostics.consent("welcome")).toThrow("organization")
    diagnostics.start()
    await diagnostics.flush()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it("deletes the funnel ID and queue of an install that was sharing when the policy arrives", async () => {
    const h = harness({ url: null })
    h.make().consent("welcome")
    const withPolicy = harness({ store: h.store, policy: true, fetch: h.fetch }).make()
    expect(withPolicy.status().state).toBe("declined")
    expect(h.saved().funnelId).toBeUndefined()
    expect(h.saved().queue).toEqual([])
    withPolicy.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fetch).not.toHaveBeenCalled()
  })
})

describe("one-time and repeated events", () => {
  it("records one-time events once per funnel ID", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    for (let i = 0; i < 3; i++) {
      diagnostics.record({ name: "welcome_continue" })
      diagnostics.record({ name: "setup_route", props: { route: i === 0 ? "auto" : "manual" } })
      diagnostics.record({ name: "license", props: { outcome: "trial_started" } })
      diagnostics.record({ name: "tenant_added" })
      diagnostics.record({ name: "first_backup", props: { result: "ok" } })
    }
    const names = h.saved().queue.map((event: SetupEvent) => event.name)
    expect(names).toEqual(["consent", "first_launch", "welcome_continue", "setup_route", "license", "tenant_added", "first_backup"])
    expect(h.saved().queue[3].props).toEqual({ route: "auto" })
  })

  it("records sign-in and registration attempts up to the limit, so a later success is seen", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    for (let i = 0; i < ATTEMPT_LIMIT + 3; i++) {
      diagnostics.record({ name: "signin", props: { result: "failed", code: "AADSTS53003", explained: true } })
      diagnostics.record({ name: "setup_signin", props: { result: "ok" } })
      diagnostics.record({ name: "registration", props: { result: "created" } })
    }
    const counts = h.saved().queue.reduce((all: Record<string, number>, event: SetupEvent) => ({ ...all, [event.name]: (all[event.name] ?? 0) + 1 }), {})
    expect(counts).toMatchObject({ signin: ATTEMPT_LIMIT, setup_signin: ATTEMPT_LIMIT, registration: ATTEMPT_LIMIT })
  })

  it("drops invalid events instead of risking a rejected batch", () => {
    const h = harness()
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    diagnostics.record({ name: "signin", props: { result: "failed", code: "Tenant contoso.onmicrosoft.com" } })
    diagnostics.record({ name: "storage", props: { kind: "nas" } })
    diagnostics.record({ name: "license", props: { outcome: "licensed", extra: "x" } })
    diagnostics.record({ name: "registration", props: {} })
    expect(h.saved().queue.map((event: SetupEvent) => event.name)).toEqual(["consent", "first_launch"])
  })

  it("keeps at most 100 events, dropping the oldest", () => {
    const h = harness({ url: null })
    h.make().consent("welcome")
    const saved = h.saved()
    saved.queue = Array.from({ length: QUEUE_LIMIT }, (_, i) => ({ seq: i + 1, name: "active_day", at: new Date(START).toISOString(), props: { day: 1 } }))
    saved.nextSeq = QUEUE_LIMIT + 1
    h.store.set(KEY, JSON.stringify(saved))
    h.make().record({ name: "welcome_continue" })
    const queue = h.saved().queue as SetupEvent[]
    expect(queue).toHaveLength(QUEUE_LIMIT)
    expect(queue[0]!.seq).toBe(2)
    expect(queue.at(-1)).toMatchObject({ seq: QUEUE_LIMIT + 1, name: "welcome_continue" })
  })
})

describe("active_day", () => {
  it("counts the first launch on each later calendar day, from day 1 to 30", () => {
    const h = harness({ url: null })
    h.setNow(new Date(2026, 10, 13, 22, 0).getTime())
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    diagnostics.start()
    expect(h.saved().queue.map((event: SetupEvent) => event.name)).not.toContain("active_day")
    // Three hours later is the next calendar day.
    h.advance(3 * 60 * 60_000)
    h.make().start()
    h.make().start()
    h.advance(5 * 86_400_000)
    h.make().start()
    const days = (h.saved().queue as SetupEvent[]).filter((event) => event.name === "active_day").map((event) => event.props)
    expect(days).toEqual([{ day: 1 }, { day: 6 }])
  })
})

describe("sender", () => {
  const granted = (h: ReturnType<typeof harness>, extra = 0) => {
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    for (let i = 0; i < extra; i++) diagnostics.record({ name: "signin", props: { result: "failed", code: "AADSTS53003", explained: true } })
    return diagnostics
  }

  it("waits a few seconds after an event before sending", async () => {
    const h = harness()
    granted(h)
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS - 1)
    expect(h.fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it("sends what is queued at startup", async () => {
    const h = harness({ url: null })
    granted(h)
    const later = harness({ store: h.store })
    later.make().start()
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS)
    expect(later.sent[0]!.body.events.map((event) => event.name)).toEqual(["consent", "first_launch"])
  })

  it("sends in batches of at most 50, then the rest", async () => {
    const h = harness({ url: null, now: undefined })
    const diagnostics = h.make()
    diagnostics.consent("welcome")
    // 60 queued events of a running install.
    const saved = h.saved()
    saved.queue = Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, name: "welcome_continue", at: new Date(START).toISOString() }))
    h.store.set(KEY, JSON.stringify(saved))
    const sender = harness({ store: h.store })
    const instance = sender.make()
    await instance.flush()
    await vi.advanceTimersByTimeAsync(1)
    expect(sender.sent.map((request) => request.body.events.length)).toEqual([50, 10])
    expect(sender.saved().queue).toEqual([])
  })

  it("retries with backoff after a network error, a 5xx and a 429 with Retry-After, keeping the same seq", async () => {
    const h = harness({ responses: [new TypeError("fetch failed"), new Response(null, { status: 503 }), new Response(null, { status: 429, headers: { "Retry-After": "120" } })] })
    granted(h)
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS)
    expect(h.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(h.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sent).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(h.sent).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toHaveLength(4)
    expect(new Set(h.sent.map((request) => JSON.stringify(request.body.events.map((event) => event.seq))))).toEqual(new Set(["[1,2]"]))
    expect(h.saved().queue).toEqual([])
  })

  it("an event during a backoff does not send before the backoff ends", async () => {
    const h = harness({ responses: [new Response(null, { status: 500 })] })
    const diagnostics = granted(h)
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS)
    diagnostics.record({ name: "welcome_continue" })
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS)
    expect(h.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]!.body.events.map((event) => event.seq)).toEqual([1, 2, 3])
  })

  it.each([400, 413])("drops a batch the endpoint refuses with %i and never retries it", async (status) => {
    const h = harness({ responses: [new Response(JSON.stringify({ error: "invalid" }), { status })] })
    granted(h)
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS)
    expect(h.saved().queue).toEqual([])
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(h.sent).toHaveLength(1)
  })

  it("drops events older than 7 days", async () => {
    const h = harness({ url: null })
    granted(h)
    const later = harness({ store: h.store })
    later.setNow(START + MAX_EVENT_AGE_MS + 1)
    await later.make().flush()
    expect(later.fetch).not.toHaveBeenCalled()
    expect(later.saved().queue).toEqual([])
  })

  it("uses a 10 second timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout")
    const h = harness()
    granted(h)
    await vi.advanceTimersByTimeAsync(SEND_DELAY_MS)
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS)
    timeout.mockRestore()
  })

  it("a build without an endpoint sends nothing", async () => {
    const h = harness({ url: null })
    granted(h)
    await vi.advanceTimersByTimeAsync(60_000)
    await h.make().flush()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it("keeps a body under 16 KB", async () => {
    const h = harness({ url: null })
    granted(h)
    const saved = h.saved()
    saved.queue = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, name: "first_launch", at: new Date(START).toISOString(), props: { osVersion: "10.26100", arch: "arm64", managedInstall: false } }))
    h.store.set(KEY, JSON.stringify(saved))
    const sender = harness({ store: h.store })
    await sender.make().flush()
    for (const request of sender.sent) expect(Buffer.byteLength(JSON.stringify(request.body))).toBeLessThanOrEqual(16_000)
  })
})

describe("diagnosticCode", () => {
  it.each([
    [new Error("AADSTS53003: Access has been blocked by Conditional Access policies."), "AADSTS53003"],
    [new Error("Microsoft refused (AADSTS7000112) for admin@contoso.com"), "AADSTS7000112"],
    [new Error("AADSTS123 short"), "other"],
    [new Error("AADSTS1234567890 long"), "other"],
    [Object.assign(new Error("Graph POST failed: Insufficient privileges"), { status: 403 }), "HTTP_403"],
    [new Error("Setup did not finish.", { cause: Object.assign(new Error("x"), { status: 429 }) }), "HTTP_429"],
    [new ProxyAuthRequiredError(), "proxy_auth"],
    [new Error("net::ERR_CERT_AUTHORITY_INVALID"), "tls"],
    [new NetworkUnreachableError("graph.microsoft.com could not be reached. (ERR_PROXY_CONNECTION_FAILED)"), "proxy"],
    [new DOMException("timed out", "TimeoutError"), "timeout"],
    [new TypeError("fetch failed"), "unreachable"],
    [Object.assign(new Error("interaction needed"), { errorCode: "interaction_required" }), "interaction_required"],
    [Object.assign(new Error("x"), { errorCode: "Tenant contoso" }), "other"],
    [new Error("Something about tenant contoso.onmicrosoft.com"), "other"],
    ["text", "other"],
    [null, "other"],
  ])("%s -> %s", (error, code) => {
    expect(diagnosticCode(error)).toBe(code)
  })

  it("passes only one-word reasons", () => {
    expect(reasonCode("trial_used")).toBe("trial_used")
    expect(reasonCode("Not a reason")).toBe("other")
    expect(reasonCode(undefined)).toBe("other")
  })
})

describe("hooks", () => {
  it("classifies sign-in results", () => {
    expect(signInResult(new SignInCancelledError())).toBe("cancelled")
    expect(signInResult(new SignInTimeoutError("late"))).toBe("timeout")
    expect(signInResult(new Error("boom"))).toBe("failed")
    expect(signInEvent(firstSignInError(new Error("AADSTS53003: blocked")))).toEqual({ name: "signin", props: { result: "failed", code: "AADSTS53003", explained: true } })
    expect(signInEvent(firstSignInError(new Error("AADSTS50076: MFA")))).toEqual({ name: "signin", props: { result: "failed", code: "AADSTS50076", explained: false } })
    expect(signInEvent(firstSignInError(new Error("user_cancelled")))).toEqual({ name: "signin", props: { result: "cancelled" } })
    expect(firstSignInError(new Error("AADSTS50020: x"))).toBeInstanceOf(ExplainedSignInError)
  })

  it("names which outcomes are setup errors for the reminder", () => {
    expect(isSetupError({ name: "signin", props: { result: "failed" } })).toBe(true)
    expect(isSetupError({ name: "setup_signin", props: { result: "timeout" } })).toBe(true)
    expect(isSetupError({ name: "license", props: { outcome: "refused" } })).toBe(true)
    expect(isSetupError({ name: "signin", props: { result: "cancelled" } })).toBe(false)
    expect(isSetupError({ name: "registration", props: { result: "created" } })).toBe(false)
  })

  it("maps registration outcomes", () => {
    const result = { tenantId: "t", clientId: "c", username: "u", displayName: "TenuVault Desktop", candidateCount: 0, ready: true, reused: false, missingConsent: [] as string[] }
    expect(registrationEvent({ result }).props).toEqual({ result: "created" })
    expect(registrationEvent({ result: { ...result, reused: true } }).props).toEqual({ result: "reused" })
    expect(registrationEvent({ result: { ...result, ready: false } }).props).toEqual({ result: "not_ready" })
    expect(registrationEvent({ result: { ...result, reused: true, missingConsent: ["DeviceManagementApps.ReadWrite.All"] } }).props).toEqual({ result: "missing_consent" })
    expect(registrationEvent({ error: Object.assign(new Error("denied"), { status: 403 }), phase: "consent", cancelled: false }).props).toEqual({ result: "failed", phase: "consent", code: "HTTP_403" })
    expect(registrationEvent({ error: new Error("Sign-in cancelled."), phase: "registration", cancelled: true }).props).toEqual({ result: "cancelled", phase: "registration" })
  })

  it("maps license outcomes, including the reason no trial started", () => {
    expect(licenseEvent("pro", "trial", undefined).props).toEqual({ outcome: "trial_started" })
    expect(licenseEvent("msp", "key", undefined).props).toEqual({ outcome: "licensed" })
    expect(licenseEvent("community", null, "no_id_token").props).toEqual({ outcome: "community", reason: "no_id_token" })
    expect(licenseEvent("community", null, undefined).props).toEqual({ outcome: "community" })
    expect(licenseFailureEvent(new LicenseDenied("x", "trial_used")).props).toEqual({ outcome: "refused", reason: "trial_used" })
    expect(licenseFailureEvent(new CommunityLimitError("t", "x")).props).toEqual({ outcome: "refused", reason: "community_limit" })
    expect(licenseFailureEvent(new CommunityChoicePendingError()).props).toEqual({ outcome: "refused", reason: "community_choice_pending" })
    expect(licenseFailureEvent(new Error(LICENSE_REQUIRED)).props).toEqual({ outcome: "refused", reason: "tenant_not_licensed" })
    expect(licenseFailureEvent(new Error("The licensing service could not be reached. Check your connection.")).props).toEqual({ outcome: "unreachable" })
    expect(licenseFailureEvent(new Error("Something else")).props).toEqual({ outcome: "refused", reason: "other" })
  })

  it("maps first backup outcomes to closed classes", () => {
    const job = { status: "Completed" as const, progressMessage: "Backup completed", failures: 0 }
    expect(firstBackupEvent(job).props).toEqual({ result: "ok" })
    expect(firstBackupEvent({ ...job, failures: 2 }).props).toEqual({ result: "partial" })
    expect(firstBackupEvent({ ...job, progressMessage: "Backup completed with 1 warning" }).props).toEqual({ result: "partial" })
    expect(firstBackupEvent({ status: "Cancelled", progressMessage: "" }).props).toEqual({ result: "failed", errorClass: "cancelled" })
    const failed = (exception: string, unreachable = false) => firstBackupEvent({ status: "Failed", progressMessage: "Backup failed", exception, unreachable }).props
    expect(failed("x", true)).toEqual({ result: "failed", errorClass: "network" })
    expect(failed("Graph answered 429 Too Many Requests")).toEqual({ result: "failed", errorClass: "throttled" })
    expect(failed("Graph answered 403 Forbidden")).toEqual({ result: "failed", errorClass: "permission" })
    expect(failed("The backup folder could not be written")).toEqual({ result: "failed", errorClass: "storage" })
    expect(failed("Unexpected")).toEqual({ result: "failed", errorClass: "other" })
  })

  it("checks renderer events: only its own names and props, share decided from the folder", () => {
    expect(rendererEvent("welcome_continue", undefined, () => false)).toEqual({ name: "welcome_continue" })
    expect(rendererEvent("setup_route", { route: "handoff" }, () => false)).toEqual({ name: "setup_route", props: { route: "handoff" } })
    expect(rendererEvent("script_saved", null, () => false)).toEqual({ name: "script_saved" })
    expect(rendererEvent("storage", { kind: "local" }, () => true)).toEqual({ name: "storage", props: { kind: "share" } })
    expect(rendererEvent("storage", { kind: "azure" }, () => true)).toEqual({ name: "storage", props: { kind: "azure" } })
    expect(() => rendererEvent("storage", { kind: "share" }, () => false)).toThrow("Invalid")
    expect(() => rendererEvent("signin", { result: "ok" }, () => false)).toThrow("Unknown")
    expect(() => rendererEvent("consent", { where: "welcome" }, () => false)).toThrow("Unknown")
    expect(() => rendererEvent("setup_route", { route: "auto", tenant: "contoso" }, () => false)).toThrow("Invalid")
    expect(() => rendererEvent("welcome_continue", "text", () => false)).toThrow("Invalid")
    expect(() => rendererEvent(42, undefined, () => false)).toThrow("Unknown")
  })

  it("recognizes network folders", () => {
    expect(isNetworkFolder("\\\\fileserver\\backups", "win32")).toBe(true)
    expect(isNetworkFolder("C:\\Users\\admin\\Documents", "win32")).toBe(false)
    expect(isNetworkFolder("/Volumes/Backups", "darwin")).toBe(true)
    expect(isNetworkFolder("/Users/admin/Documents", "darwin")).toBe(false)
    expect(isNetworkFolder("/mnt/share", "linux")).toBe(true)
  })

  it("reduces the system version to major.minor and the CPU to known names", () => {
    expect(firstLaunchProps("15.2.1", "arm64", true)).toEqual({ osVersion: "15.2", arch: "arm64", managedInstall: true })
    expect(firstLaunchProps("10.0.26100", "x64", false)).toEqual({ osVersion: "10.0", arch: "x64", managedInstall: false })
    expect(firstLaunchProps("24", "riscv64", false)).toEqual({ osVersion: "24", arch: "other", managedInstall: false })
    expect(firstLaunchProps("unknown", "ia32", false)).toMatchObject({ osVersion: "0", arch: "ia32" })
    expect(validEvent({ name: "first_launch", props: firstLaunchProps("10.0.26100", "x64", false) })).toBe(true)
  })
})

describe("privacy", () => {
  const TENANT_ID = "8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14"
  const CLIENT_ID = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"
  const UPN = "megan.bowen@contoso.onmicrosoft.com"
  const EMAIL = "it-admin@contoso.com"
  const TENANT_NAME = "Contoso Pharmaceuticals"
  const SECRETS = [TENANT_ID, CLIENT_ID, UPN, EMAIL, TENANT_NAME, "contoso"]
  const message = (prefix: string) => `${prefix} Tenant ${TENANT_NAME} (${TENANT_ID}), app ${CLIENT_ID}, account ${UPN}, contact ${EMAIL}.`

  it("never puts tenant IDs, names, accounts, emails, client IDs or message text into a payload", async () => {
    const h = harness()
    const diagnostics = h.make()
    const errors: unknown[] = [
      new Error(message("AADSTS53003: Access blocked.")),
      new Error(message("No code here.")),
      Object.assign(new Error(message("Graph POST failed.")), { status: 403 }),
      new Error(message("Setup did not finish."), { cause: Object.assign(new Error(message("inner")), { status: 500 }) }),
      new NetworkUnreachableError(message("graph.microsoft.com could not be reached. (ERR_NAME_NOT_RESOLVED)")),
      Object.assign(new Error(message("MSAL")), { errorCode: `${TENANT_NAME}` }),
      Object.assign(new Error(message("MSAL")), { errorCode: "invalid_grant" }),
      new SignInTimeoutError(message("The sign-in in the browser was not completed.")),
      new SignInCancelledError(),
    ]
    // A setup error before the answer, shared through the reminder.
    diagnostics.record(signInEvent(firstSignInError(errors[0])), "signin")
    diagnostics.consent("error", "signin")
    for (const error of errors) {
      diagnostics.record({ name: "setup_signin", props: { result: signInResult(error), ...(signInResult(error) === "failed" ? { code: diagnosticCode(error) } : {}) } })
      diagnostics.record(registrationEvent({ error, phase: "consent", cancelled: false }))
      diagnostics.record(signInEvent(firstSignInError(error)))
      diagnostics.record(signInEvent(error))
    }
    diagnostics.record(licenseFailureEvent(new LicenseDenied(message("Denied."), message("reason"))))
    diagnostics.record(licenseEvent("community", null, message("skip")))
    diagnostics.record(firstBackupEvent({ status: "Failed", progressMessage: message("Backup failed."), exception: message("403") }))
    diagnostics.record(rendererEvent("storage", { kind: "local" }, () => isNetworkFolder(`\\\\${TENANT_NAME}\\${UPN}`, "win32")))
    await diagnostics.flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sent.length).toBeGreaterThan(0)
    const payloads = h.sent.map((request) => String(request.init.body))
    const events = h.sent.flatMap((request) => request.body.events)
    expect(events.length).toBeGreaterThan(20)
    for (const payload of payloads) {
      for (const secret of SECRETS) expect(payload.toLowerCase()).not.toContain(secret.toLowerCase())
      expect(payload).not.toMatch(/Access blocked|No code here|could not be reached|Denied|Backup failed/)
    }
    for (const event of events) expect(validEvent(event)).toBe(true)
    // The stored queue holds the same: nothing beyond the contract.
    expect(h.store.get(KEY)!.toLowerCase()).not.toContain("contoso")
  })
})
