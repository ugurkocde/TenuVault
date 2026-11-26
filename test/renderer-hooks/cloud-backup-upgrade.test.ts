import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { CloudBackupSettings } from "../../src/renderer/components/CloudBackupSettings"
import type { CloudBackupConfig, CloudBackupStatus } from "../../src/shared/cloud-backup"

vi.mock("@desktop/lib/bridge", () => ({ bridge: { backups: { scope: async () => ({ scope: { excluded: [] } }) } } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it("asks for a coverage update until the Azure runbook reports 1.6.1 or later", async () => {
  const config: CloudBackupConfig = {
    tenantId: "tenant", subscriptionId: "subscription", resourceGroup: "rg", automationAccount: "automation",
    storageAccount: "store", scheduleName: "Daily", frequency: "daily", time: "", weekday: 0, timeZone: "UTC", tenantKey: "tenant", linked: true,
  }
  const status: CloudBackupStatus = {
    lastRunAt: "2026-11-24T01:00:00Z", lastStatus: "Success", lastMessage: "Backup completed.", backupFolder: null,
    runbookVersion: "1.5.0", auditCapability: true,
  }
  const node = document.createElement("div")
  const root = createRoot(node)
  const render = (runbookVersion: string) => act(async () => root.render(createElement(CloudBackupSettings, {
    tenant: undefined, community: false,
    cloud: { config, status: { ...status, runbookVersion }, statusError: null, refresh: vi.fn(), save: vi.fn(), clear: vi.fn() },
  })))
  try {
    await render("1.5.0")
    expect.soft(node.textContent).toContain("Run the setup script again with the same values")
    expect.soft(node.textContent).toContain("accurate change reports")
    await render("1.6.0")
    expect.soft(node.textContent).toContain("accurate change reports")
    await render("1.6.1")
    expect.soft(node.textContent).not.toContain("accurate change reports")
    await render("1.7.0")
    expect.soft(node.textContent).not.toContain("accurate change reports")
    await render("1.1.0")
    expect(node.textContent).toContain("recovery key from Key Vault")
  } finally {
    await act(async () => root.unmount())
  }
})
