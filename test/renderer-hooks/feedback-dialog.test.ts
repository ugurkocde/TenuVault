import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FeedbackContext, FeedbackSendResult } from "../../src/shared/feedback"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  send: vi.fn(),
  discardCapture: vi.fn(async () => undefined),
  openExternal: vi.fn(async (_url: string) => undefined),
  toast: vi.fn(),
}))

vi.mock("@desktop/lib/bridge", () => ({
  bridge: {
    feedback: { context: mocks.context, send: mocks.send, discardCapture: mocks.discardCapture },
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

beforeEach(() => {
  mocks.context.mockResolvedValue(context)
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

function Harness({ preview, page }: { preview: string | null; page?: string }) {
  const [open, setState] = useState(true)
  setOpen = setState
  return createElement(FeedbackDialog, { open, onOpenChange: setState, preview, page, onOpenSupport })
}

async function render(preview: string | null = PREVIEW, page: string | null = "Drift Detection") {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(Harness, { preview, page: page ?? undefined })))
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
    await render(null)
    expect(document.body.querySelector('button[role="checkbox"]')).toBeNull()
    expect(dialog()!.textContent).not.toContain("Attach a screenshot")
  })

  it("lists exactly the diagnostics that are sent", async () => {
    await render()
    const items = [...sentList().querySelectorAll("li")].map((item) => item.textContent)
    expect(items).toEqual(["App version: 0.4.1", "Operating system: macOS 26.2", "Plan: Community", "Page: Drift Detection"])
  })

  it("leaves out the page when it is unknown", async () => {
    await render(PREVIEW, null)
    expect(sentList().textContent).not.toContain("Page")
  })

  it("sends only the draft fields, then closes, thanks and clears the draft", async () => {
    mocks.send.mockResolvedValue({ ok: true } satisfies FeedbackSendResult)
    await render()
    await fill("  Restore a policy ", "It failed")
    await clickSend()
    expect(mocks.send).toHaveBeenCalledTimes(1)
    const sent = mocks.send.mock.calls[0]![0]
    expect(Object.keys(sent).sort()).toEqual(["blocker", "goal", "includeScreenshot", "page", "submissionId"])
    expect(sent).toMatchObject({ includeScreenshot: false, page: "Drift Detection" })
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
    expect(mocks.send.mock.calls[1]![0].submissionId).toBe(mocks.send.mock.calls[0]![0].submissionId)
  })

  it("keeps the draft across closing and reopening, and discards the capture on close", async () => {
    await render()
    await fill("Restore a policy", "It failed")
    await act(async () => { button("Cancel")!.click() })
    expect(dialog()).toBeNull()
    expect(mocks.discardCapture).toHaveBeenCalledTimes(1)
    await act(async () => setOpen(true))
    expect(textareas().map((field) => field.value)).toEqual(["Restore a policy", "It failed"])
  })

  it("opens Support from the subtitle", async () => {
    await render()
    await act(async () => { button("Open Support.")!.click() })
    expect(onOpenSupport).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
  })
})
