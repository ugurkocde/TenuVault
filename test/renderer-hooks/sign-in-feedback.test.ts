import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import { TRIAL_USED_MESSAGE } from "../../src/shared/constants"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({ signIn: vi.fn(), capture: vi.fn(), send: vi.fn(), limit: vi.fn(() => false) }))
vi.mock("@desktop/lib/bridge", () => ({ bridge: {
  auth: { signIn: mocks.signIn },
  feedback: { capture: mocks.capture, send: mocks.send, discardCapture: async () => {} },
} }))
vi.mock("@desktop/lib/plan-dialog", () => ({ showCommunityLimitError: mocks.limit }))
vi.mock("@desktop/components/TenantTrial", () => ({ TrialKeyRefusalActions: () => null }))
import { TenantSignInForm } from "../../src/renderer/components/TenantSignInForm"
import { FeedbackProvider } from "../../src/renderer/components/FeedbackProvider"

let root: Root
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)
const label = "Tell us what went wrong"
const secretError = "Fictional sign-in failure with private details"
const initial = { tenant: "contoso.onmicrosoft.com", clientId: "11111111-2222-4333-8444-555555555555", displayName: "Contoso" }
async function render(fields = initial, hosted = true) {
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container)
  const form = createElement(TenantSignInForm, { initial: fields, onSignedIn: vi.fn(), hidePaste: true })
  await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ["/portal/onboarding"] }, hosted ? createElement(FeedbackProvider, { onOpenSupport: vi.fn(), children: form }) : form)))
}
async function fail(message = secretError) {
  mocks.signIn.mockRejectedValue(new Error(message))
  await act(async () => button("Sign in with Microsoft")!.click())
}
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ""; vi.resetAllMocks() })
it("opens the shared dialog empty, sends nothing until Send, preserves fields and returns focus", async () => {
  const snapshot = { id: "opening", page: "Setup", preview: null, context: { appVersion: "0.3.0", os: "linux", osVersion: "1", plan: "community" } }
  mocks.capture.mockResolvedValue(snapshot)
  mocks.send.mockResolvedValue({ ok: true })
  await render(); await fail()
  const trigger = button(label)!
  expect(trigger.type).toBe("button")
  await act(async () => { trigger.focus(); trigger.click() })
  expect(mocks.capture).toHaveBeenCalledExactlyOnceWith("Setup")
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).not.toContain(secretError)
  expect([...dialog.querySelectorAll<HTMLInputElement>("textarea, input")].map(e => e.value)).toEqual(["", "", ""])
  expect(mocks.send).not.toHaveBeenCalled()
  expect(JSON.stringify(snapshot)).not.toContain(secretError)
  for (const value of Object.values(initial)) {
    expect(dialog.textContent).not.toContain(value)
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(value)
  }
  await act(async () => button("Cancel")!.click())
  await act(async () => new Promise(r => setTimeout(r, 0)))
  expect(document.activeElement).toBe(trigger)
  expect((document.querySelector('#tenant') as HTMLInputElement).value).toBe(initial.tenant)
  await act(async () => trigger.click())
  await act(async () => {
    for (const field of document.querySelectorAll('textarea')) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, "My chosen words")
      field.dispatchEvent(new Event("input", { bubbles: true }))
    }
  })
  await act(async () => button("Send feedback")!.click())
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith("opening", {
    submissionId: expect.any(String), goal: "My chosen words", blocker: "My chosen words", includeScreenshot: false,
  })
})
it.each(["Sign-in cancelled.", TRIAL_USED_MESSAGE, `Sign-in refused: ${TRIAL_USED_MESSAGE} Please try again.`])("omits the action for %s", async message => {
  await render(); await fail(message); expect(button(label)).toBeUndefined(); expect(mocks.capture).not.toHaveBeenCalled()
})
it("omits the action for field validation", async () => {
  await render({ ...initial, tenant: "invalid", clientId: "invalid" }); await fail()
  expect(mocks.signIn).not.toHaveBeenCalled(); expect(button(label)).toBeUndefined()
})
it("omits the action for the Community limit", async () => {
  mocks.limit.mockReturnValue(true); await render(); await fail(); expect(button(label)).toBeUndefined()
})
it("omits the action without a feedback host", async () => {
  await render(initial, false); await fail(); expect(button(label)).toBeUndefined()
})
