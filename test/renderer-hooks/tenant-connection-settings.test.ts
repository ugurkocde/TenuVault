import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { tenantPermissionPacks } from "../../src/shared/services/permission-packs"
import { GRAPH_CLI_SIGN_IN_REQUIREMENTS } from "../../src/shared/tenant-connection"
import { TenantConnectionSettings } from "../../src/renderer/components/TenantConnectionSettings"

const tenantId = "aaaaaaaa-1111-1111-1111-111111111111"
const clientId = "bbbbbbbb-1111-1111-1111-111111111111"

const useLicense = vi.hoisted(() => vi.fn())
const openExternal = vi.hoisted(() => vi.fn(async () => undefined))
const auth = vi.hoisted(() => ({ graphCliAvailable: vi.fn(), packConsentPlan: vi.fn(), switchConnection: vi.fn() }))
vi.mock("../../src/renderer/lib/license", () => ({ useLicense }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { openExternal },
    auth: { ...auth, connection: async () => ({ origin: "wizard", method: "ownApp", clientId }) },
  },
}))

it.each([
  { source: "key", pending: false, warning: false },
  { source: "tenant", pending: false, warning: true },
  { source: "tenant", pending: true, warning: true },
])("shows the switch warning and renewal status for $source (pending: $pending)", async ({ source, pending, warning }) => {
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
  } finally {
    act(() => root.unmount())
    container.remove()
    environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
})

it.each([false, true])("warns before Start now sign-in and offers upgrades after refusal (TenuVault app enabled: %s)", async enabled => {
  auth.graphCliAvailable.mockResolvedValueOnce(true)
  const plan = { packs: tenantPermissionPacks({ intune: { access: "backup" } }, { azure: false, audit: false }) }
  auth.packConsentPlan.mockResolvedValueOnce(plan).mockResolvedValueOnce(enabled ? plan : null)
  auth.switchConnection.mockReset().mockResolvedValueOnce({ error: { code: "AADSTS50105", message: "Start now is not available in this tenant. (AADSTS50105)" } })
  useLicense.mockReturnValue({ status: { tenants: [] } })
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.textContent === label)
  try {
    await act(async () => root.render(createElement(TenantConnectionSettings, { tenantId, clientId, onChanged: vi.fn() })))
    await act(async () => button("Use Start now")!.click())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(GRAPH_CLI_SIGN_IN_REQUIREMENTS)
    expect(auth.switchConnection).not.toHaveBeenCalled()
    await act(async () => button("Continue to Microsoft")!.click())
    expect(auth.switchConnection).toHaveBeenCalledExactlyOnceWith(tenantId, { method: "graphCli" })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("AADSTS50105")
    expect(button("Use your own app registration")).toBeDefined()
    expect(Boolean(button("Upgrade to the TenuVault app"))).toBe(enabled)
  } finally {
    act(() => root.unmount())
    container.remove()
    environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
})


it("recovers a browser session while switching to Start now", async () => {
  auth.graphCliAvailable.mockResolvedValueOnce(true)
  auth.packConsentPlan.mockReset().mockResolvedValue(null)
  auth.switchConnection.mockReset().mockResolvedValue({ error: {
    code: "browser_sign_in_required", message: "Sign in to Microsoft in your browser first, then try again.",
  } })
  useLicense.mockReturnValue({ status: { tenants: [] } })
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.textContent === label)
  try {
    await act(async () => root.render(createElement(TenantConnectionSettings, { tenantId, clientId, onChanged: vi.fn() })))
    await act(async () => button("Use Start now")!.click())
    await act(async () => button("Continue to Microsoft")!.click())
    expect(container.textContent).toContain("Sign in to Microsoft in your browser first, then try again.")
    expect(button("Use your own app registration")).toBeUndefined()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => button("Open Microsoft sign-in")!.click())
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://intune.microsoft.com")
    expect(auth.switchConnection).toHaveBeenCalledExactlyOnceWith(tenantId, { method: "graphCli" })
    await act(async () => button("Try again")!.click())
    expect(auth.switchConnection).toHaveBeenCalledTimes(2)
    expect(auth.switchConnection).toHaveBeenLastCalledWith(tenantId, { method: "graphCli" })
  } finally {
    act(() => root.unmount())
    container.remove()
    environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
})
