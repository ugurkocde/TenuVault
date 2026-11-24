import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { TenantConnectionSettings } from "../../src/renderer/components/TenantConnectionSettings"

const tenantId = "aaaaaaaa-1111-1111-1111-111111111111"
const clientId = "bbbbbbbb-1111-1111-1111-111111111111"

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { auth: { connection: async () => ({ origin: "wizard", method: "ownApp", clientId }) } },
}))

it("labels the available sign-in action Change app registration", async () => {
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
  } finally {
    act(() => root.unmount())
    container.remove()
    environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
})
