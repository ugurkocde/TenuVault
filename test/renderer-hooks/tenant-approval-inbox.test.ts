import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { TenantApprovals } from "../../src/renderer/components/write-approvals/TenantApprovals"

vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [{ id: "tenant", name: "Contoso", credentials: { tenantId: "tenant" } }],
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  if (root) act(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it("shows the unreadable-record warning when every inbox record is invalid", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ available: true, enabled: true, invalidRecords: 2, requests: [] }))
  root = createRoot(document.body.appendChild(document.createElement("div")))
  await act(async () => root?.render(createElement(TenantApprovals, { active: true })))
  expect(document.querySelector('[role="status"]')?.textContent).toContain("2 approval records could not be read")
  expect(document.body.textContent).not.toContain("No tenant approval requests")
})
