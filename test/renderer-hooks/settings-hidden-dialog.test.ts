import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })) as typeof window.matchMedia

// Every bridge call resolves to nothing and every subscription returns an unsubscribe, so the
// sections render their empty states. This test is only about the About panel's dialog.
vi.mock("../../src/renderer/lib/bridge", () => {
  const call = (name: string) => (name.startsWith("on") ? () => () => undefined : async () => undefined)
  const namespace = () => new Proxy({}, { get: (_target, name) => (name === "getItemSync" ? () => null : call(String(name))) })
  return { bridge: new Proxy({}, { get: () => namespace() }) }
})
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
}))
vi.mock("../../src/renderer/lib/local-inventory", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/local-inventory")>()),
  useBackupSettings: () => [null, () => undefined],
}))
vi.mock("../../src/renderer/lib/appearance", () => ({ getAppearance: () => "light", setAppearance: () => undefined }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [], useTenantOperations: () => ({}) }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
vi.mock("../../src/renderer/lib/whats-new", () => ({ useWhatsNew: () => ({ state: null, refresh: async () => undefined, markSeen: async () => undefined }) }))
vi.mock("../../src/renderer/components/PdfBrandingSettings", () => ({ PdfBrandingSettings: () => null }))
vi.mock("../../src/renderer/components/BackupReaderSettings", () => ({ BackupReaderSettings: () => null }))
vi.mock("../../src/renderer/components/ServicesSettings", () => ({ ServicesSettings: () => null }))
vi.mock("../../src/renderer/features/notifications/NotificationsPanel", () => ({ NotificationsPanel: () => null }))

// jsdom runs no CSS, so Radix would remove a closing dialog at once with or without its exit
// animation. Report the animation its classes would run, as a browser does, so a dialog that
// keeps its exit animation stays mounted waiting for animationend, as in the real window.
const computedStyle = window.getComputedStyle.bind(window)
window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
  // Live, like a browser's computed style: Radix keeps the object and reads it again on close.
  const animationName = () => {
    const classes = element.getAttribute("class") ?? ""
    const state = element.getAttribute("data-state")
    if (state === "closed" && classes.includes("data-[state=closed]:animate-out")) return "exit"
    return state === "open" && classes.includes("data-[state=open]:animate-in") ? "enter" : "none"
  }
  return new Proxy(computedStyle(element, pseudo), { get: (target, name) => (name === "animationName" ? animationName() : Reflect.get(target, name)) })
}) as typeof window.getComputedStyle

import SettingsPage from "../../src/renderer/pages/SettingsPage"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
})

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const click = (element: Element | undefined) => act(() => { (element as HTMLElement).click() })

describe("Settings page dialogs when their section hides", () => {
  it("drop the license agreement at once, without waiting for an exit animation", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(MemoryRouter, { initialEntries: ["/settings?section=about"] }, createElement(SettingsPage))))
    await settle()

    const about = container.querySelector("#settings-about")!
    click([...about.querySelectorAll("button")].find((entry) => entry.textContent === "License agreement"))
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain("License agreement")
    expect(dialog?.className).toContain("data-[state=closed]:animate-out")

    // Switching sections hides About. Its dialog loses the exit animation in the same commit, so
    // Radix removes it now instead of waiting for animation frames a hidden window may never draw.
    const links = [...container.querySelectorAll('nav[aria-label="Settings sections"] a')]
    click(links.find((entry) => entry.getAttribute("aria-current") !== "page"))
    expect(container.querySelector("#settings-about")?.hasAttribute("hidden")).toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
