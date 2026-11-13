import { act, createElement, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SetupDiagnosticsStatus } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  status: null as unknown as SetupDiagnosticsStatus,
  consent: vi.fn(),
  decline: vi.fn(),
  reminderShown: vi.fn(async () => undefined),
  record: vi.fn(async () => undefined),
  openExternal: vi.fn(async (_url: string) => undefined),
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    diagnostics: {
      status: async () => state.status,
      consent: state.consent,
      decline: state.decline,
      reminderShown: state.reminderShown,
      record: state.record,
    },
    app: { openExternal: state.openExternal },
  },
}))

import { recordSetup, SETUP_DIAGNOSTICS_DOCS_URL, SetupDiagnosticsCard, SetupDiagnosticsReminder, SetupDiagnosticsSetting } from "../../src/renderer/components/SetupDiagnostics"

const roots: Root[] = []
const status = (changes: Partial<SetupDiagnosticsStatus> = {}): SetupDiagnosticsStatus => ({ state: "unasked", policy: false, reminder: { setup: false, signin: false }, ...changes })

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(element) })
  await act(async () => { await Promise.resolve() })
  return container
}
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text)
async function click(element: Element | undefined) {
  if (!element) throw new Error("Element not found")
  await act(async () => { (element as HTMLElement).click() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  state.status = status()
  state.consent.mockImplementation(async () => status({ state: "granted" }))
  state.decline.mockImplementation(async () => status({ state: "declined" }))
})
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

describe("welcome card", () => {
  it("asks with the exact copy and two equal buttons, nothing preselected", async () => {
    const container = await render(createElement(SetupDiagnosticsCard))
    const text = container.textContent ?? ""
    expect(text).toContain("Help us make setup work in your environment")
    expect(text).toContain("TenuVault can tell us which setup steps worked and which Microsoft error codes stopped them, for 30 days after you agree. Never sent: tenant names or IDs, account names, policies or backups. A random ID links the steps. It is deleted from this computer after 30 days, and we delete the events after 180 days.")
    expect(text).toContain("Change it anytime in Settings")
    expect(text).not.toMatch(/[\u2013\u2014]/)
    const share = button(container, "Share setup diagnostics")!
    const decline = button(container, "Don't share")!
    expect(share.className).toBe(decline.className)
    expect(container.querySelector("input")).toBeNull()
    expect(state.consent).not.toHaveBeenCalled()
  })

  it("opens the docs page that lists what is sent", async () => {
    const container = await render(createElement(SetupDiagnosticsCard))
    await click(button(container, "See exactly what is sent"))
    expect(state.openExternal).toHaveBeenCalledWith(SETUP_DIAGNOSTICS_DOCS_URL)
    expect(SETUP_DIAGNOSTICS_DOCS_URL).toBe("https://docs.tenuvault.com/security/data-flows/#setup-diagnostics")
  })

  it.each([
    ["Share setup diagnostics", "consent", "Setup diagnostics are on"],
    ["Don't share", "decline", "Setup diagnostics stay off"],
  ] as const)("%s answers and leaves a short confirmation", async (label, call, confirmation) => {
    const container = await render(createElement(SetupDiagnosticsCard))
    await click(button(container, label))
    if (call === "consent") expect(state.consent).toHaveBeenCalledWith("welcome")
    else expect(state.decline).toHaveBeenCalled()
    expect(container.textContent).toContain(confirmation)
    expect(button(container, "Share setup diagnostics")).toBeUndefined()
  })

  it.each([
    status({ state: "granted" }),
    status({ state: "declined" }),
    status({ state: "ineligible" }),
    status({ state: "ended" }),
    status({ policy: true }),
  ])("is not shown for %j", async (value) => {
    state.status = value
    const container = await render(createElement(SetupDiagnosticsCard))
    expect(container.textContent).toBe("")
  })
})

describe("error reminder", () => {
  it("is shown once, next to an error main holds for the step, and shares it", async () => {
    state.status = status({ reminder: { setup: false, signin: true } })
    const container = await render(createElement(SetupDiagnosticsReminder, { step: "signin" }))
    expect(container.textContent).toContain("Share this error and the next setup steps with TenuVault so we can fix setups like yours?")
    expect(state.reminderShown).toHaveBeenCalledTimes(1)
    await click(button(container, "Share"))
    expect(state.consent).toHaveBeenCalledWith("error", "signin")
    expect(button(container, "Share")).toBeUndefined()
  })

  it("Don't share declines", async () => {
    state.status = status({ reminder: { setup: true, signin: false } })
    const container = await render(createElement(SetupDiagnosticsReminder, { step: "setup" }))
    await click(button(container, "Don't share"))
    expect(state.decline).toHaveBeenCalled()
    expect(container.textContent).toContain("Nothing is shared.")
  })

  it("stays away without a held error for its step", async () => {
    state.status = status({ reminder: { setup: true, signin: false } })
    const container = await render(createElement(SetupDiagnosticsReminder, { step: "signin" }))
    expect(container.textContent).toBe("")
    expect(state.reminderShown).not.toHaveBeenCalled()
  })
})

describe("Settings toggle", () => {
  const checkbox = (container: HTMLElement) => container.querySelector<HTMLInputElement>("input[type=checkbox]")!

  it("turns sharing on and off, and says turning it off deletes what was sent", async () => {
    state.status = status({ state: "declined" })
    const container = await render(createElement(SetupDiagnosticsSetting))
    expect(container.textContent).toContain("Turning it off also deletes the events already sent.")
    expect(checkbox(container).checked).toBe(false)
    await click(checkbox(container))
    expect(state.consent).toHaveBeenCalledWith("settings")
    expect(checkbox(container).checked).toBe(true)
    await click(checkbox(container))
    expect(state.decline).toHaveBeenCalled()
    expect(checkbox(container).checked).toBe(false)
  })

  it("is locked off by the policy, with a note", async () => {
    state.status = status({ state: "granted", policy: true })
    const container = await render(createElement(SetupDiagnosticsSetting))
    expect(checkbox(container).disabled).toBe(true)
    expect(checkbox(container).checked).toBe(false)
    expect(container.textContent).toContain("Turned off by your organization.")
  })

  it("says it ended after 30 days", async () => {
    state.status = status({ state: "ended" })
    const container = await render(createElement(SetupDiagnosticsSetting))
    expect(checkbox(container).disabled).toBe(true)
    expect(container.textContent).toContain("Ended 30 days after you agreed")
  })

  it("is not shown on an install from before setup diagnostics", async () => {
    state.status = status({ state: "ineligible" })
    const container = await render(createElement(SetupDiagnosticsSetting))
    expect(container.textContent).toBe("")
  })
})

it("reports renderer steps without ever throwing", () => {
  recordSetup({ name: "setup_route", props: { route: "handoff" } })
  expect(state.record).toHaveBeenCalledWith({ name: "setup_route", props: { route: "handoff" } })
  state.record.mockImplementationOnce(() => { throw new Error("no bridge") })
  expect(() => recordSetup({ name: "welcome_continue" })).not.toThrow()
})
