import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { CommunityTenantPicker } from "../../src/renderer/components/CommunityTenantPicker"

const state = vi.hoisted(() => ({ choices: ["contoso", "fabrikam"], choose: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined) }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { license: { chooseCommunity: state.choose } } }))
vi.mock("../../src/renderer/lib/license", () => ({ useLicense: () => ({ status: { communityChoiceTenantIds: state.choices }, refresh: state.refresh }) }))
vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [{ name: "Contoso", credentials: { tenantId: "contoso" } }, { name: "Fabrikam", credentials: { tenantId: "fabrikam" } }] }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let cleanup = () => {}
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.clearAllMocks() })
it("asks for a tenant, explains backup preservation and persists the selected tenant", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")))
  cleanup = () => act(() => root.unmount())
  act(() => root.render(createElement(CommunityTenantPicker)))
  expect(document.body.textContent).toContain("Choose your Community tenant")
  expect(document.body.textContent).toContain("Backups of the other tenants are kept")
  const fabrikam = [...document.querySelectorAll('button')].find((button) => button.textContent === "Fabrikam")!
  await act(async () => fabrikam.click())
  expect(state.choose).toHaveBeenCalledWith("fabrikam")
  expect(state.refresh).toHaveBeenCalledTimes(1)
})
