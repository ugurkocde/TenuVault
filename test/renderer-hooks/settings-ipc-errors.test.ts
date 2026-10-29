import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppPreferences } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  info: vi.fn(),
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
  updateStatus: vi.fn(),
  check: vi.fn(),
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { info: state.info },
    preferences: { get: state.getPrefs, set: state.setPrefs },
    updates: { status: state.updateStatus, check: state.check, onChanged: () => () => undefined },
    backgroundLaunch: { status: async () => ({ supported: true, installed: false }) },
    backupReader: { status: async () => ({ supported: true, available: false, reader: null }) },
    backups: { scope: () => new Promise(() => undefined) },
  },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
}))
vi.mock("../../src/renderer/lib/schedules", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/schedules")>()),
  useSchedules: () => [],
  useRefusals: () => [],
}))
vi.mock("../../src/renderer/lib/appearance", () => ({ getAppearance: () => "light", setAppearance: () => undefined }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [], useTenantOperations: () => ({}) }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))

import { BackgroundAndRetention, Updates } from "../../src/renderer/pages/SettingsPage"
import { BackupSchedulePanel } from "../../src/renderer/components/BackupSchedulePanel"

const prefs = { startAtLogin: false, keepRunningInTray: true, retentionDays: 30, autoUpdate: true, nightlyUpdates: false, autoUpdateManaged: false } as AppPreferences

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  for (const mock of Object.values(state)) mock.mockReset()
})

async function render(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, null, element)))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text))
const alertText = (container: HTMLElement) => [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent).join(" ")

describe("Settings sections on IPC errors", () => {
  it("shows a Background runner read failure with a retry", async () => {
    state.info.mockRejectedValueOnce(new Error("info failed")).mockResolvedValue({ version: "1.0.0", platform: "win32", trayIconLoaded: true })
    state.getPrefs.mockResolvedValue(prefs)
    const container = await render(createElement(BackgroundAndRetention))
    expect(alertText(container)).toContain("info failed")
    await act(async () => { button(container, "Try again")!.click() })
    expect(alertText(container)).toBe("")
    expect(container.textContent).toContain("Keep running in the tray")
  })

  it("shows an Updates read failure and a refused preference change", async () => {
    state.getPrefs.mockRejectedValueOnce(new Error("prefs failed")).mockResolvedValue(prefs)
    state.updateStatus.mockResolvedValue({ state: "idle" })
    const container = await render(createElement(Updates))
    expect(alertText(container)).toContain("prefs failed")
    await act(async () => { button(container, "Try again")!.click() })

    state.setPrefs.mockRejectedValueOnce(new Error("refused by policy"))
    const autoUpdate = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => { autoUpdate.click() })
    expect(alertText(container)).toContain("refused by policy")
  })

  it("shows a failed update check instead of dropping it", async () => {
    state.getPrefs.mockResolvedValue(prefs)
    state.updateStatus.mockResolvedValue({ state: "idle" })
    state.check.mockRejectedValueOnce(new Error("feed unreachable"))
    const container = await render(createElement(Updates))
    await act(async () => { button(container, "Check now")!.click() })
    expect(container.textContent).toContain("Could not check for updates: feed unreachable")
  })

  it("shows background runner preference errors on the schedule panel", async () => {
    state.getPrefs.mockRejectedValueOnce(new Error("prefs failed")).mockResolvedValue(prefs)
    const container = await render(createElement(BackupSchedulePanel, { tenantId: "tenant", tenantName: "Contoso" }))
    expect(alertText(container)).toContain("prefs failed")
    await act(async () => { button(container, "Try again")!.click() })
    expect(container.textContent).toContain("Keep running in the tray")
    expect(container.textContent).toContain("Scheduled backups run as")
    expect(container.textContent).toContain("You (your sign-in)")

    state.setPrefs.mockRejectedValueOnce(new Error("refused by policy"))
    const startAtLogin = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest("label")?.textContent?.includes("Start TenuVault"))!
    await act(async () => { startAtLogin.click() })
    expect(alertText(container)).toContain("refused by policy")
  })
})
