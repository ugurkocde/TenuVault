import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { TenuVaultConsent } from "../../src/renderer/components/TenuVaultConsent"
import { tenantPermissionPacks } from "../../src/shared/services/permission-packs"

const auth = vi.hoisted(() => ({ packConsentPlan: vi.fn(), packConsent: vi.fn(), switchConnection: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { auth } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(["sign-in", "admin consent"])("offers approval for the selected pack after a refusal from %s", async origin => {
  const tenantId = "aaaaaaaa-1111-1111-1111-111111111111"
  const plan = { packs: tenantPermissionPacks({ intune: { access: "backup" } }, { azure: false, audit: false }) }
  auth.packConsentPlan.mockResolvedValue(plan)
  auth.switchConnection.mockReset().mockResolvedValue({ error: { code: "AADSTS90095", message: "Approval required" } })
  auth.packConsent.mockReset().mockImplementation(async (_tenant, _pack, action) =>
    (origin === "sign-in" && action === "open")
      ? { status: "error", issue: { code: "AADSTS65001", message: "Admin consent refused" } }
      : { status: "waiting", issue: { code: "AADSTS90095", message: "Approval required" } })
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const button = (text: string) => [...document.querySelectorAll("button")].find(node => node.textContent === text)
  try {
    await act(async () => root.render(createElement(TenuVaultConsent, { tenantId, plan, active: false, onChanged: vi.fn() })))
    await act(async () => button("Use TenuVault app")!.click())
    expect(button("Request approval")).toBeUndefined()
    if (origin === "sign-in") {
      await act(async () => button("Sign in")!.click())
      expect(button("Request approval")).toBeDefined()
      expect(document.querySelector("[role=alert]")?.textContent).toContain("Choose a permission pack")
      expect(auth.packConsent).not.toHaveBeenCalled()
    }
    const select = document.querySelector("select")!
    const choose = async (id: string) => act(async () => {
      select.value = id
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await choose("intune-backup")
    await act(async () => button("Open admin consent")!.click())
    expect(button("Request approval")).toBeDefined()
    if (origin === "sign-in") expect(document.querySelector("[role=alert]")?.textContent).toBe("Admin consent refused")
    await choose("basics")
    if (origin === "sign-in") expect(button("Request approval")).toBeDefined()
    else expect(button("Request approval")).toBeUndefined()
    await choose("intune-backup")
    await act(async () => button("Request approval")!.click())
    expect(auth.packConsent).toHaveBeenLastCalledWith(tenantId, "intune-backup", "request")
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
