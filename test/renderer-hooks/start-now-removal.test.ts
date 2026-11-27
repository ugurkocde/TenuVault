import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { tenantPermissionPacks } from "../../src/shared/services/permission-packs"
import { SIGN_IN_METHODS, START_NOW_REMOVED_REASON, TENUVAULT_APP_UNAVAILABLE, TENUVAULT_CLIENT_ID } from "../../src/shared/tenant-connection"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridgeMocks = vi.hoisted(() => ({
  tenuvaultAppAvailable: vi.fn(async () => true),
  packConsentPlan: vi.fn(async () => null),
  switchConnection: vi.fn(async () => ({
    result: { connection: { method: "tenuvaultApp", clientId: "61eff188-672b-4be4-acac-2d254a6f9e05" }, missing: [] },
  })),
  connection: vi.fn(async () => null),
}))
vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    auth: bridgeMocks,
    app: { openExternal: vi.fn(async () => undefined) },
  },
}))
vi.mock("../../src/renderer/lib/license", () => ({ useLicense: () => ({ status: null }) }))

import { ChooseSignInMethodCard } from "../../src/renderer/components/ChooseSignInMethodCard"
import { OnboardingSignIn } from "../../src/renderer/components/OnboardingSignIn"

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111"
const OWN = "bbbbbbbb-2222-4222-8222-222222222222"
const CONSENT_PLAN = { packs: tenantPermissionPacks({ intune: { access: "backup" } }, { azure: false, audit: false }) }
const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  vi.clearAllMocks()
})

function mount(element: ReturnType<typeof createElement>): HTMLDivElement {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(element))
  return container
}

describe("0.6 Start now removal UI", () => {
  it("renders exactly two sign-in methods in OnboardingSignIn with TenuVault app first and kill-switch fallback copy", () => {
    const onChoose = vi.fn()
    const enabled = mount(createElement(OnboardingSignIn, {
      available: { tenuvaultApp: true },
      choice: { intune: { access: "backup" } },
      onChoose,
    }))
    const cards = [...enabled.querySelectorAll<HTMLButtonElement>("[data-sign-in-method]")]
    expect(cards.map(card => card.getAttribute("data-sign-in-method"))).toEqual(["tenuvaultApp", "ownApp"])
    expect(cards[0]?.textContent).toContain("Recommended")
    expect(cards[0]?.disabled).toBe(false)
    expect(enabled.textContent).not.toContain("Start now")

    const disabled = mount(createElement(OnboardingSignIn, {
      available: { tenuvaultApp: false },
      choice: { intune: { access: "backup" } },
      onChoose,
    }))
    const disabledCards = [...disabled.querySelectorAll<HTMLButtonElement>("[data-sign-in-method]")]
    expect(disabledCards.map(card => card.disabled)).toEqual([true, false])
    expect(disabledCards[0]?.textContent).toContain(TENUVAULT_APP_UNAVAILABLE)
  })

  it("renders the compact Choose a sign-in method card with both options and kill-switch fallback", async () => {
    const onChanged = vi.fn()
    const card = mount(createElement(ChooseSignInMethodCard, {
      tenantId: TENANT,
      tenantName: "Contoso",
      consent: CONSENT_PLAN,
      tenuvaultAppAvailable: true,
      onChanged,
    }))
    expect(card.textContent).toContain("Choose a sign-in method")
    expect(card.textContent).toContain(START_NOW_REMOVED_REASON)
    const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")].map(button => button.textContent?.trim())
    expect(buttons).toContain(`${SIGN_IN_METHODS.tenuvaultApp} (Recommended)`)
    expect(buttons).toContain(SIGN_IN_METHODS.ownApp)

    // Opening Your own app registration offers both manual entry and the setup helper.
    const ownButton = [...card.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === SIGN_IN_METHODS.ownApp)!
    await act(async () => ownButton.click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain("Create it for me")
    const input = dialog.querySelector<HTMLInputElement>("input")!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(input, OWN)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    bridgeMocks.switchConnection.mockResolvedValueOnce({
      result: { connection: { method: "ownApp", clientId: OWN }, missing: [] },
    })
    const signInButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Sign in")!
    await act(async () => signInButton.click())
    expect(bridgeMocks.switchConnection).toHaveBeenCalledWith(TENANT, { method: "ownApp", clientId: OWN })
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({
      connection: expect.objectContaining({ method: "ownApp", clientId: OWN }),
    }))
    expect(TENUVAULT_CLIENT_ID).toBe("61eff188-672b-4be4-acac-2d254a6f9e05")

    const unavailable = mount(createElement(ChooseSignInMethodCard, {
      tenantId: TENANT,
      tenantName: "Contoso",
      consent: null,
      tenuvaultAppAvailable: false,
      onChanged,
    }))
    expect(unavailable.textContent).toContain(TENUVAULT_APP_UNAVAILABLE)
    const unavailableButtons = [...unavailable.querySelectorAll("button")].map(button => button.textContent?.trim())
    expect(unavailableButtons).not.toContain(`${SIGN_IN_METHODS.tenuvaultApp} (Recommended)`)
    expect(unavailableButtons).toContain(SIGN_IN_METHODS.ownApp)
  })
})
