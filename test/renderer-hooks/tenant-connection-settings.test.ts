import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { TenantConnectionSettings } from "../../src/renderer/components/TenantConnectionSettings"

const tenantId = "aaaaaaaa-1111-1111-1111-111111111111"
const clientId = "bbbbbbbb-1111-1111-1111-111111111111"

const useLicense = vi.hoisted(() => vi.fn())
vi.mock("../../src/renderer/lib/license", () => ({ useLicense }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    auth: { connection: async () => ({ origin: "wizard", method: "ownApp", clientId }) },
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
