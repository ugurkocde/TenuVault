import { act, createElement, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import { BackupProgressProvider, useBackupProgress } from "../../src/portal/contexts/BackupProgressContext"
import { ConnectLinkHost } from "../../src/renderer/components/ConnectLinkHost"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => [], useTenantOperations: () => ({ updateTenant: vi.fn() }), useSelectedTenant: () => ({ setSelectedTenantId: vi.fn() }),
}))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { connectLink: {
  takePending: async () => ({ rejected: false, pending: { id: 1, details: { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222" } } }),
  onAvailable: () => () => undefined,
} } }))
let root: Root | undefined
function Backup() {
  const { addJob } = useBackupProgress()
  useEffect(() => {
    addJob({ jobId: "job", tenantId: "tenant", tenantName: "Tenant", status: "Running", progress: 0, progressMessage: "Running", isComplete: false, isSuccessful: false, credentials: { tenantId: "tenant", appId: "app", clientSecret: "" }, resources: { subscriptionId: "local", resourceGroupName: "local", automationAccountName: "" } })
  }, [addJob])
  return createElement(ConnectLinkHost)
}
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined
  document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
it.each(["Failed", "Cancelled", "polling error"])("shows the queued connection link after a backup ends with %s", async ending => {
  vi.useFakeTimers()
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  let end = false
  const fetchStatus = vi.fn(async () => {
    if (end && ending === "polling error") throw new Error("Status unavailable")
    return Response.json({ status: end ? ending : "Running", progress: end ? 100 : 0, progressMessage: "Backup", isComplete: end, isSuccessful: false })
  })
  vi.stubGlobal("fetch", fetchStatus)
  const container = document.body.appendChild(document.createElement("div")); root = createRoot(container)
  await act(async () => root!.render(createElement(MemoryRouter, null, createElement(BackupProgressProvider, null, createElement(Backup)))))
  expect(document.body.textContent).not.toContain("Connect a tenant?")
  end = true
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(fetchStatus.mock.calls.length).toBeGreaterThan(1)
  expect(document.body.textContent).toContain("Connect a tenant?")
})
