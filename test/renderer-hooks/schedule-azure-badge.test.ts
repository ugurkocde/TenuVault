import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const licenseStatus = vi.hoisted(() => ({ current: null as unknown }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { info: async () => ({ version: "1.0.0", platform: "darwin", trayIconLoaded: true }) },
    preferences: { get: async () => ({ startAtLogin: false, keepRunningInTray: true, retentionDays: 30, autoUpdate: true, nightlyUpdates: false, autoUpdateManaged: false }), set: async () => ({}) },
    backgroundLaunch: { status: async () => ({ supported: true, installed: false }) },
    backupReader: { status: async () => ({ supported: true, available: false, reader: null }) },
    backups: { scope: () => new Promise(() => undefined), settings: async () => ({ localFolder: "/tmp/backups", keyFingerprint: "AAAA", recoveryExported: true, hasLocalBackups: false }) },
    license: { open: async () => undefined },
    storage: { getItemSync: () => null, setItem: async () => undefined, removeItem: async () => undefined },
  },
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: licenseStatus.current, error: null, refresh: async () => undefined }),
}))
vi.mock("../../src/renderer/lib/schedules", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/schedules")>()),
  useSchedules: () => ({ schedules: [], error: null, loading: false, reload: () => undefined }),
  useRefusals: () => ({ refusals: [], error: null, loading: false, reload: () => undefined }),
}))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [], useTenantOperations: () => ({}) }))

import { BackupSchedulePanel } from "../../src/renderer/components/BackupSchedulePanel"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  licenseStatus.current = null
})

function statusFor(plan: "community" | "pro" | "msp") {
  const paid = plan !== "community"
  const tenant = { tenantId: "tenant", signedIn: true, activated: paid, entitled: paid, source: paid ? "key" : null, plan, tenants: paid ? 2 : null, expiresAt: paid ? "2030-01-01T00:00:00.000Z" : null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }
  return { hasKey: paid, keyState: paid ? "active" : "none", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null, plan: paid ? plan : null, tenantLimit: paid ? 2 : null, validUntil: null, communityTenantId: paid ? null : "tenant", tenants: [tenant] }
}

async function azureRadio(): Promise<HTMLButtonElement> {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, null, createElement(BackupSchedulePanel, { tenantId: "tenant", tenantName: "Contoso" }))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => radio.textContent?.includes("In Azure"))!
}

describe("Azure cloud runner option", () => {
  it("carries the Pro badge for Community and still opens the cloud setup", async () => {
    licenseStatus.current = statusFor("community")
    const radio = await azureRadio()
    expect(radio.textContent).toContain("In Azure, no computer neededPro")
    expect(radio.disabled).toBe(false)
    await act(async () => radio.click())
    expect(radio.getAttribute("aria-checked")).toBe("true")
  })

  it("shows no badge on Pro, MSP or while the plan is not known", async () => {
    for (const status of [statusFor("pro"), statusFor("msp"), null]) {
      licenseStatus.current = status
      const radio = await azureRadio()
      expect(radio.textContent).toContain("In Azure, no computer needed")
      expect(radio.textContent).not.toContain("neededPro")
      document.body.replaceChildren()
    }
  })
})
