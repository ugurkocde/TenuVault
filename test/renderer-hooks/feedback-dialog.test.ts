import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FeedbackContext, FeedbackSendResult, FeedbackSnapshot } from "../../src/shared/feedback"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  discardCapture: vi.fn(async (_openingId: string) => undefined),
  openExternal: vi.fn(async (_url: string) => undefined),
  toast: vi.fn(),
  writeText: vi.fn(async (_text: string) => undefined),
}))

Object.defineProperty(navigator, "clipboard", { value: { writeText: mocks.writeText }, configurable: true })

vi.mock("@desktop/lib/bridge", () => ({
  bridge: {
    feedback: { send: mocks.send, discardCapture: mocks.discardCapture },
    app: { openExternal: mocks.openExternal },
  },
}))
vi.mock("@desktop/lib/toast", () => ({ toast: mocks.toast }))

import { FeedbackDialog } from "../../src/renderer/components/FeedbackDialog"

const context: FeedbackContext = { appVersion: "0.4.1", os: "darwin", osVersion: "26.2", plan: "community" }
const PREVIEW = "data:image/jpeg;base64,AAAA"

const roots: Root[] = []
let setOpen: (open: boolean) => void = () => undefined
const onOpenSupport = vi.fn()

const snapshotWith = (overrides: Partial<FeedbackSnapshot> = {}): FeedbackSnapshot => ({ id: "opening-1", preview: PREVIEW, context, page: "Drift Detection", ...overrides })

beforeEach(() => {
  mocks.send.mockReset()
  mocks.writeText.mockReset()
  mocks.writeText.mockResolvedValue(undefined)
  mocks.openExternal.mockReset()
  mocks.openExternal.mockResolvedValue(undefined)
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

function Harness({ snapshot }: { snapshot: FeedbackSnapshot | null }) {
  const [open, setState] = useState(true)
  setOpen = setState
  return createElement(FeedbackDialog, { open, onOpenChange: setState, snapshot, onOpenSupport })
}

async function render(snapshot: FeedbackSnapshot | null = snapshotWith()) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(Harness, { snapshot })))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null
const textareas = () => [...document.body.querySelectorAll("textarea")]
const button = (name: string) => [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === name) as HTMLButtonElement | undefined
const sentList = () => document.body.querySelector('ul[aria-label="Sent with your feedback"]')!

/** Sets a controlled field the way React expects a user edit. */
function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

async function fill(goal: string, blocker: string) {
  const [first, second] = textareas()
  await act(async () => { type(first!, goal) })
  await act(async () => { type(second!, blocker) })
}

async function clickSend() {
  await act(async () => { button("Send feedback")!.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe("FeedbackDialog", () => {
  it("shows both required questions with live counters", async () => {
    await render()
    expect(dialog()!.textContent).toContain("Share feedback")
    expect(dialog()!.textContent).toContain("What were you trying to do?")
    expect(dialog()!.textContent).toContain("What got in your way, and what would help?")
    const fields = textareas()
    expect(fields).toHaveLength(2)
    for (const field of fields) expect(field.maxLength).toBe(500)
    expect(dialog()!.textContent?.match(/Required/g)).toHaveLength(2)
    expect(dialog()!.textContent?.match(/0\/500/g)).toHaveLength(2)
    await act(async () => { type(fields[0]!, "Restore") })
    expect(dialog()!.textContent).toContain("7/500")
  })

  it("keeps Send disabled until both answers have text", async () => {
    await render()
    expect(button("Send feedback")!.disabled).toBe(true)
    await fill("Restore a policy", "   ")
    expect(button("Send feedback")!.disabled).toBe(true)
    await fill("Restore a policy", "It failed")
    expect(button("Send feedback")!.disabled).toBe(false)
  })

  it("blocks Send for an invalid reply-to email", async () => {
    await render()
    await fill("Restore a policy", "It failed")
    const email = document.body.querySelector('input[type="email"]') as HTMLInputElement
    await act(async () => { type(email, "admin at contoso") })
    expect(button("Send feedback")!.disabled).toBe(true)
    expect(dialog()!.textContent).toContain("Enter a valid email address")
    await act(async () => { type(email, "admin@contoso.com") })
    expect(button("Send feedback")!.disabled).toBe(false)
    expect(sentList().textContent).toContain("Reply-to email: admin@contoso.com")
  })

  it("leaves the screenshot unticked with its warning, and lists it only when ticked", async () => {
    await render()
    const checkbox = document.body.querySelector('button[role="checkbox"]') as HTMLButtonElement
    expect(checkbox.getAttribute("aria-checked")).toBe("false")
    expect(dialog()!.textContent).toContain("Attach a screenshot of this window")
    expect(dialog()!.textContent).toContain("It may show tenant, policy or user names.")
    expect(document.body.querySelector(`img[src="${PREVIEW}"]`)).not.toBeNull()
    expect(sentList().textContent).not.toContain("Screenshot")
    await act(async () => { checkbox.click() })
    expect(checkbox.getAttribute("aria-checked")).toBe("true")
    expect(sentList().textContent).toContain("Screenshot of this window")
  })

  it("hides the screenshot option when capture failed", async () => {
    await render(snapshotWith({ preview: null }))
    expect(document.body.querySelector('button[role="checkbox"]')).toBeNull()
    expect(dialog()!.textContent).not.toContain("Attach a screenshot")
  })

  it("lists exactly the diagnostics that are sent", async () => {
    await render()
    const items = [...sentList().querySelectorAll("li")].map((item) => item.textContent)
    expect(items).toEqual(["App version: 0.4.1", "Operating system: macOS 26.2", "Plan: Community", "Page: Drift Detection", "A random message ID, so a retry is not counted twice"])
  })

  it("leaves out the page when it is unknown", async () => {
    await render(snapshotWith({ page: undefined }))
    expect(sentList().textContent).not.toContain("Page")
  })

  it("sends only the draft fields, then closes, thanks and clears the draft", async () => {
    mocks.send.mockResolvedValue({ ok: true } satisfies FeedbackSendResult)
    await render()
    await fill("  Restore a policy ", "It failed")
    await clickSend()
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0]![0]).toBe("opening-1")
    const sent = mocks.send.mock.calls[0]![1]
    expect(Object.keys(sent).sort()).toEqual(["blocker", "goal", "includeScreenshot", "submissionId"])
    expect(sent).toMatchObject({ includeScreenshot: false })
    expect(sent.submissionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(mocks.toast).toHaveBeenCalledWith("Thanks, your feedback was sent.", "success")
    expect(dialog()).toBeNull()

    await act(async () => setOpen(true))
    expect(textareas().map((field) => field.value)).toEqual(["", ""])
  })

  it("keeps the draft and the submission ID after a failure and offers Copy as email", async () => {
    mocks.send.mockResolvedValue({ ok: false, kind: "rate_limited", message: "Too much feedback was sent from this network. Try again in 2 minutes.", retryAfterSeconds: 120 } satisfies FeedbackSendResult)
    await render()
    await fill("Restore a policy", "It failed")
    await clickSend()
    expect(dialog()).not.toBeNull()
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("Try again in 2 minutes.")
    expect(textareas().map((field) => field.value)).toEqual(["Restore a policy", "It failed"])

    await act(async () => { button("Copy as email")!.click() })
    const url = mocks.openExternal.mock.calls[0]![0]
    expect(url.startsWith("mailto:support@tenuvault.com?subject=TenuVault%20feedback")).toBe(true)
    expect(decodeURIComponent(url)).toContain("Restore a policy")
    expect(decodeURIComponent(url)).toContain("Plan: Community")

    await clickSend()
    expect(mocks.send.mock.calls[1]![1].submissionId).toBe(mocks.send.mock.calls[0]![1].submissionId)
  })

  it("keeps the draft across closing and reopening, and discards the capture on close", async () => {
    await render()
    await fill("Restore a policy", "It failed")
    await act(async () => { button("Cancel")!.click() })
    expect(dialog()).toBeNull()
    expect(mocks.discardCapture).toHaveBeenCalledTimes(1)
    expect(mocks.discardCapture).toHaveBeenCalledWith("opening-1")
    await act(async () => setOpen(true))
    expect(textareas().map((field) => field.value)).toEqual(["Restore a policy", "It failed"])
  })

  it("opens Support from the subtitle", async () => {
    await render()
    await act(async () => { button("Open Support.")!.click() })
    expect(onOpenSupport).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
  })

  it("keeps Send disabled and says so when the snapshot could not be recorded", async () => {
    await render(null)
    await fill("Restore a policy", "It failed")
    expect(button("Send feedback")!.disabled).toBe(true)
    expect(sentList().textContent).toContain("could not be read")
    expect(document.body.querySelector('button[role="checkbox"]')).toBeNull()
  })

  it("rejects NUL and unpaired surrogates with a field message", async () => {
    await render()
    await fill("Restore\u0000 a policy", "It failed")
    expect(button("Send feedback")!.disabled).toBe(true)
    expect(dialog()!.textContent).toContain("Remove unsupported characters.")
    await fill("Restore a policy", "It failed \uD83D")
    expect(button("Send feedback")!.disabled).toBe(true)
    await fill("Restore a policy", "It failed \u{1F600}")
    expect(button("Send feedback")!.disabled).toBe(false)
    expect(dialog()!.textContent).not.toContain("Remove unsupported characters.")
  })

  it("applies the service's email rule", async () => {
    await render()
    await fill("Restore a policy", "It failed")
    const email = document.body.querySelector('input[type="email"]') as HTMLInputElement
    for (const address of [".admin@example.com", "a..b@example.com", "admin@example.c"]) {
      await act(async () => { type(email, address) })
      expect(button("Send feedback")!.disabled).toBe(true)
    }
  })

  it("shows the service's field messages until that field is edited", async () => {
    mocks.send.mockResolvedValue({ ok: false, kind: "rejected", message: "Check your feedback and try again.", fields: { goal: "Describe what you were trying to do.", replyTo: "Enter a valid email address." } } satisfies FeedbackSendResult)
    await render()
    await fill("Restore a policy", "It failed")
    await clickSend()
    expect(dialog()!.textContent).toContain("Describe what you were trying to do.")
    expect(dialog()!.textContent).toContain("Enter a valid email address.")
    expect(textareas()[0]!.getAttribute("aria-invalid")).toBe("true")
    await act(async () => { type(textareas()[0]!, "Restore one policy") })
    expect(dialog()!.textContent).not.toContain("Describe what you were trying to do.")
    expect(dialog()!.textContent).toContain("Enter a valid email address.")
  })

  it("opens Copy as email even when the draft holds an unpaired surrogate", async () => {
    mocks.send.mockResolvedValue({ ok: false, kind: "network", message: "TenuVault could not reach the feedback service." } satisfies FeedbackSendResult)
    await render()
    await fill("Restore a policy", "It failed")
    await clickSend()
    await act(async () => { type(textareas()[1]!, "It failed \uD83D") })
    await act(async () => { button("Copy as email")!.click() })
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
    expect(decodeURIComponent(mocks.openExternal.mock.calls[0]![0])).toContain("It failed \uFFFD")
  })

  describe("Copy as email", () => {
    const failOnce = () => mocks.send.mockResolvedValue({ ok: false, kind: "network", message: "TenuVault could not reach the feedback service." } satisfies FeedbackSendResult)

    it("copies the full text before opening the shortened email draft", async () => {
      failOnce()
      await render()
      const goal = "\u00e9".repeat(500)
      const blocker = "\u00fc".repeat(500)
      await fill(goal, blocker)
      await clickSend()
      await act(async () => { button("Copy as email")!.click() })
      expect(mocks.writeText).toHaveBeenCalledTimes(1)
      const text = mocks.writeText.mock.calls[0]![0]
      expect(text.startsWith("To: support@tenuvault.com\nSubject: TenuVault feedback\n")).toBe(true)
      expect(text).toContain(goal)
      expect(text).toContain(blocker)
      expect(text).toContain("Plan: Community")
      expect(text).toContain(`Message ID: ${mocks.send.mock.calls[0]![1].submissionId}`)
      // The clipboard is written before the mail app opens.
      expect(mocks.writeText.mock.invocationCallOrder[0]!).toBeLessThan(mocks.openExternal.mock.invocationCallOrder[0]!)
      const url = mocks.openExternal.mock.calls[0]![0]
      expect(url.length).toBeLessThanOrEqual(1800)
      expect(decodeURIComponent(url)).not.toContain(goal)
      expect(mocks.toast).toHaveBeenCalledWith("Your feedback was copied. If the email draft is cut off, paste the copied text.", "success")
    })

    it("says the text is on the clipboard and names the address when no mail app opens", async () => {
      failOnce()
      mocks.openExternal.mockRejectedValue(new Error("No application"))
      await render()
      await fill("Restore a policy", "It failed")
      await clickSend()
      await act(async () => { button("Copy as email")!.click() })
      expect(mocks.writeText).toHaveBeenCalledTimes(1)
      expect(mocks.toast).toHaveBeenCalledWith("No email app could be opened. Your feedback is on the clipboard: paste it into an email to support@tenuvault.com.", "error")
    })

    it("still opens the email draft when the clipboard is unavailable", async () => {
      failOnce()
      mocks.writeText.mockRejectedValue(new Error("Denied"))
      await render()
      await fill("Restore a policy", "It failed")
      await clickSend()
      await act(async () => { button("Copy as email")!.click() })
      expect(mocks.openExternal).toHaveBeenCalledTimes(1)
      expect(mocks.toast).toHaveBeenCalledWith("Your feedback could not be copied; the email draft may be shortened.", "info")
    })
  })
})
