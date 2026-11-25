import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppPreferences } from "../../src/shared/ipc"
import { GRAPH_CLI_CLIENT_ID, TENUVAULT_CLIENT_ID } from "../../src/shared/tenant-connection"
import type { Tenant } from "~/contexts/TenantContext"

vi.mock("../../src/renderer/components/ServiceBackupNotice", () => ({ ServiceBackupNotice: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  info: vi.fn(),
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
  updateStatus: vi.fn(),
  check: vi.fn(),
  scope: vi.fn(),
  tenants: vi.fn<() => Pick<Tenant, "id" | "name" | "credentials">[]>(),
  accounts: vi.fn(),
  reauthenticate: vi.fn(),
  openExternal: vi.fn(),
  switchConnection: vi.fn(),
  toast: vi.fn(),
  schedulesResult: { schedules: [] as unknown[], error: null as string | null, loading: false, reload: vi.fn() },
}))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { info: state.info, openExternal: state.openExternal },
    auth: {
      accounts: state.accounts,
      connection: async () => null,
      reauthenticate: state.reauthenticate,
      switchConnection: state.switchConnection,
    },
    preferences: { get: state.getPrefs, set: state.setPrefs },
    updates: { status: state.updateStatus, check: state.check, onChanged: () => () => undefined },
    backgroundLaunch: { status: async () => ({ supported: true, installed: false }) },
    backupReader: { status: async () => ({ supported: true, available: false, reader: null }) },
    backups: {
      scope: state.scope,
      settings: async () => ({ localFolder: "/tmp/backups", keyFingerprint: "AAAA-BBBB-CCCC", recoveryExported: true, hasLocalBackups: false }),
    },
    storage: { getItemSync: () => null, setItem: async () => undefined, removeItem: async () => undefined },
  },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: null, error: null, refresh: async () => undefined }),
}))
vi.mock("../../src/renderer/lib/schedules", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/schedules")>()),
  useSchedules: () => state.schedulesResult,
  useRefusals: () => ({ refusals: [], error: null, loading: false, reload: () => undefined }),
}))
vi.mock("../../src/renderer/lib/appearance", () => ({ getAppearance: () => "light", setAppearance: () => undefined }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => state.tenants() ?? [], useTenantOperations: () => ({}) }))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: state.toast }))
vi.mock("~/components/ConfirmDialog", () => ({ useConfirm: () => ({ confirm: async () => true, confirmDialog: null }) }))
vi.mock("../../src/renderer/lib/whats-new", () => ({
  useWhatsNew: () => ({ state: null, refresh: async () => undefined, markSeen: async () => undefined }),
}))

import { BackgroundAndRetention, TenantSettings, Updates } from "../../src/renderer/pages/SettingsPage"
import { BackupSchedulePanel } from "../../src/renderer/components/BackupSchedulePanel"

const prefs = { startAtLogin: false, keepRunningInTray: true, retentionDays: 30, autoUpdate: true, nightlyUpdates: false, autoUpdateManaged: false } as AppPreferences

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  for (const [name, mock] of Object.entries(state)) if (name !== "schedulesResult") (mock as ReturnType<typeof vi.fn>).mockReset()
  state.schedulesResult = { schedules: [], error: null, loading: false, reload: vi.fn() }
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

describe("Settings tenant sign-in", () => {
  const tenantId = "aaaaaaaa-1111-1111-1111-111111111111"
  const account = { tenantId, username: "admin@contoso.test" }

  async function renderTenant(clientId: string, signedIn = false) {
    state.tenants.mockReturnValue([{ id: 1, name: "Contoso", credentials: { tenantId, appId: clientId, clientSecret: "" } }])
    state.accounts.mockResolvedValue([account]).mockResolvedValueOnce(signedIn ? [account] : [])
    return render(createElement(TenantSettings, { active: true }))
  }

  it.each([false, true])("uses the permission-pack sign-in for the TenuVault app (signed in: %s)", async signedIn => {
    state.switchConnection.mockResolvedValue({ result: { missing: [] } })
    const container = await renderTenant(TENUVAULT_CLIENT_ID.toUpperCase(), signedIn)
    await act(async () => { button(container, signedIn ? "Sign in again" : "Sign in")!.click() })
    expect(state.switchConnection).toHaveBeenCalledExactlyOnceWith(tenantId, { method: "tenuvaultApp" })
    expect(state.reauthenticate).not.toHaveBeenCalled()
    expect(state.accounts).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain(`Signed in as ${account.username}`)
  })

  it("shows a permission-pack sign-in failure and allows retry", async () => {
    const message = "Review the permission packs and try again."
    state.switchConnection.mockResolvedValue({ error: { code: "conflict", message } })
    const container = await renderTenant(TENUVAULT_CLIENT_ID)
    await act(async () => { button(container, "Sign in")!.click() })
    expect(state.toast).toHaveBeenCalledWith(message, "error")
    expect(button(container, "Sign in")?.disabled).toBe(false)
  })

  it("recovers a Start now session when signing in again from Settings", async () => {
    state.reauthenticate.mockResolvedValueOnce({ error: {
      code: "browser_sign_in_required", message: "Sign in to Microsoft in your browser first, then try again.",
    } }).mockResolvedValueOnce(account)
    state.openExternal.mockResolvedValue(undefined)
    const container = await renderTenant(GRAPH_CLI_CLIENT_ID, true)
    await act(async () => button(container, "Sign in again")!.click())
    expect(container.textContent).toContain("Sign in to Microsoft in your browser first, then try again.")
    expect(state.toast).not.toHaveBeenCalled()
    await act(async () => button(container, "Open Microsoft sign-in")!.click())
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("https://intune.microsoft.com")
    expect(state.reauthenticate).toHaveBeenCalledExactlyOnceWith(tenantId, GRAPH_CLI_CLIENT_ID)
    await act(async () => button(container, "Try again")!.click())
    expect(state.reauthenticate).toHaveBeenLastCalledWith(tenantId, GRAPH_CLI_CLIENT_ID)
    expect(state.reauthenticate).toHaveBeenCalledTimes(2)
    expect(button(container, "Open Microsoft sign-in")).toBeUndefined()
    expect(state.toast).toHaveBeenCalledWith(`Signed in as ${account.username}.`, "success")
  })

  it.each([GRAPH_CLI_CLIENT_ID, "bbbbbbbb-1111-1111-1111-111111111111"])("keeps generic reauthentication for %s", async clientId => {
    state.reauthenticate.mockResolvedValue(account)
    const container = await renderTenant(clientId)
    await act(async () => { button(container, "Sign in")!.click() })
    expect(state.reauthenticate).toHaveBeenCalledExactlyOnceWith(tenantId, clientId)
    expect(state.switchConnection).not.toHaveBeenCalled()
  })
})

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

  it("shows a schedule load failure on the panel and blocks saving over the saved schedule", async () => {
    state.schedulesResult = { schedules: [], error: "schedule IPC down", loading: false, reload: vi.fn() }
    state.getPrefs.mockResolvedValue(prefs)
    state.scope.mockImplementation(() => new Promise(() => undefined))
    const container = await render(createElement(BackupSchedulePanel, { tenantId: "tenant", tenantName: "Contoso" }))
    expect(alertText(container)).toContain("Could not load the saved schedule.")
    expect(container.querySelector("[data-notice-tone=error] [hidden]")?.textContent).toContain("schedule IPC down")
    const enable = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest("label")?.textContent?.includes("automatically"))!
    await act(async () => { enable.click() })
    expect(button(container, "Save")!.disabled).toBe(true)
  })

  it("shows a backup scope load failure with a retry instead of hiding the section", async () => {
    state.getPrefs.mockResolvedValue(prefs)
    state.scope.mockRejectedValueOnce(new Error("scope IPC down")).mockResolvedValue({ scope: { excluded: [] }, saved: true })
    const container = await render(createElement(BackupSchedulePanel, { tenantId: "tenant", tenantName: "Contoso" }))
    expect(container.textContent).toContain("What to back up")
    expect(alertText(container)).toContain("scope IPC down")
    await act(async () => { button(container, "Try again")!.click() })
    expect(alertText(container)).toBe("")
    expect(state.scope).toHaveBeenCalledTimes(2)
  })

  it("shows background runner preference errors on the schedule panel", async () => {
    state.getPrefs.mockRejectedValueOnce(new Error("prefs failed")).mockResolvedValue(prefs)
    state.scope.mockImplementation(() => new Promise(() => undefined))
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
