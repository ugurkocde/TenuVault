import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { tenantPermissionPacks } from "../../src/shared/services/permission-packs"
import { START_NOW_REMOVED_REASON, TENUVAULT_APP_UNAVAILABLE, TENUVAULT_CLIENT_ID, type TenantConnection } from "../../src/shared/tenant-connection"
import { TenantConnectionSettings } from "../../src/renderer/components/TenantConnectionSettings"

const tenantId = "aaaaaaaa-1111-1111-1111-111111111111"
const clientId = "bbbbbbbb-1111-1111-1111-111111111111"

const useLicense = vi.hoisted(() => vi.fn())
const openExternal = vi.hoisted(() => vi.fn(async () => undefined))
const auth = vi.hoisted(() => ({
  tenuvaultAppAvailable: vi.fn(async () => true),
  packConsentPlan: vi.fn(),
  switchConnection: vi.fn(),
  connection: vi.fn(async (): Promise<TenantConnection | null> => ({
    version: 1, origin: "wizard", method: "ownApp", clientId, createdAt: "", updatedAt: "",
  })),
}))
vi.mock("../../src/renderer/lib/license", () => ({ useLicense }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { openExternal },
    auth,
  },
}))

it.each([
  { source: "key", pending: false, warning: false },
  { source: "tenant", pending: false, warning: true },
  { source: "tenant", pending: true, warning: true },
])("shows the switch warning and renewal status for $source (pending: $pending)", async ({ source, pending, warning }) => {
  auth.connection.mockResolvedValue({ version: 1, origin: "wizard", method: "ownApp", clientId, createdAt: "", updatedAt: "" })
  auth.tenuvaultAppAvailable.mockResolvedValue(true)
  auth.packConsentPlan.mockResolvedValue(null)
  useLicense.mockReturnValue({ status: { tenants: [{ tenantId, source, organizationRenewalPending: pending }] } })
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(TenantConnectionSettings, { tenantId, clientId, onChanged: vi.fn() })))
    const button = container.querySelector("button")
    expect(button?.textContent).toBe("Change app registration")
    await act(async () => button?.click())
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Change app registration")
    expect(document.querySelector('[role="dialog"]')?.textContent?.includes("Ask the license key holder")).toBe(warning)
    expect(container.textContent?.includes("Your current license coverage lasts")).toBe(pending)
    expect(container.textContent).not.toContain("Start now")
  } finally {
    act(() => root.unmount())
    container.remove()
    environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
})

it("shows the Choose a sign-in method card for a migrated Start now tenant and offers both methods", async () => {
  auth.connection.mockResolvedValue({ version: 1, origin: "wizard", method: null, clientId: "", needsSignInMethod: true, createdAt: "", updatedAt: "" })
  auth.tenuvaultAppAvailable.mockResolvedValue(true)
  auth.packConsentPlan.mockResolvedValue({ packs: tenantPermissionPacks({ intune: { access: "backup" } }, { azure: false, audit: false }) })
  auth.switchConnection.mockReset().mockResolvedValue({ result: { connection: { method: "tenuvaultApp", clientId: TENUVAULT_CLIENT_ID }, missing: [] } })
  useLicense.mockReturnValue({ status: { tenants: [] } })
  const onChanged = vi.fn()
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label)
  try {
    await act(async () => root.render(createElement(TenantConnectionSettings, { tenantId, clientId: "", onChanged })))
    expect(container.textContent).toContain("Choose a sign-in method")
    expect(container.textContent).toContain(START_NOW_REMOVED_REASON)
    expect(button("TenuVault app (Recommended)")).toBeDefined()
    expect(button("Your own app registration")).toBeDefined()
    await act(async () => button("Your own app registration")!.click())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Use your own app registration")
  } finally {
    act(() => root.unmount())
    container.remove()
    environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
})

it("shows own registration as the working path when the TenuVault app kill switch is off", async () => {
  auth.connection.mockResolvedValue({ version: 1, origin: "wizard", method: null, clientId: "", needsSignInMethod: true, createdAt: "", updatedAt: "" })
  auth.tenuvaultAppAvailable.mockResolvedValue(false)
  auth.packConsentPlan.mockResolvedValue(null)
  useLicense.mockReturnValue({ status: { tenants: [] } })
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label)
  try {
    await act(async () => root.render(createElement(TenantConnectionSettings, { tenantId, clientId: "", onChanged: vi.fn() })))
    expect(container.textContent).toContain(TENUVAULT_APP_UNAVAILABLE)
    expect(button("TenuVault app (Recommended)")).toBeUndefined()
    expect(button("Your own app registration")).toBeDefined()
  } finally {
    act(() => root.unmount())
    container.remove()
    environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
})
