import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { it, expect, vi, afterEach } from "vitest"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const api = vi.hoisted(() => ({ apps: vi.fn(), signIn: vi.fn(async () => {}), openExternal: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { appSources: api, app: { openExternal: api.openExternal } } }))
import { IntuneAppsView } from "../../src/renderer/features/app-backup/IntuneAppsView"
HTMLElement.prototype.scrollIntoView = vi.fn()
let root: Root
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.clearAllMocks() })
it("starts from the actual app list and explains preparation without enabling capture or changing assignments", async () => {
  api.apps.mockResolvedValue({ apps: [{ id: "11111111-1111-1111-1111-111111111111", name: "Finance", publisher: "Contoso" }], fetchedAt: new Date().toISOString() })
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node)
  await act(async () => root.render(createElement(IntuneAppsView, { tenant: "tenant", busy: false, attach: vi.fn(), devicePanel: createElement("div", null, "Check this PC") })))
  expect(node.textContent).toContain("Finance")
  const button = [...node.querySelectorAll("button")].find(b => b.textContent?.startsWith("Prepare backup"))!
  await act(async () => button.click())
  expect(node.textContent).toContain("Required can install the app automatically")
  expect(node.textContent).toContain("Installed program files are not a substitute")
  expect([...node.querySelectorAll("button")].find(b => b.textContent === "Capture unavailable in this build")?.disabled).toBe(true)
  expect(api.signIn).not.toHaveBeenCalled()
  const close = [...node.querySelectorAll("button")].find(b => b.textContent === "Close preparation")!
  close.focus()
  await act(async () => close.click())
  expect(document.activeElement).toBe(button)
  expect(node.textContent).not.toContain("Prepare backup: Finance")
})
