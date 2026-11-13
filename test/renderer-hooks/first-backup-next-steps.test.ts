import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  schedules: { list: vi.fn(), set: vi.fn() },
  backups: { settings: vi.fn(), exportRecoveryKey: vi.fn() },
}))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge }))
vi.mock("../../src/renderer/lib/plan-dialog", () => ({ showFeaturePlanError: vi.fn() }))

import { FirstBackupNextSteps } from "../../src/renderer/components/FirstBackupNextSteps"

const TENANT = "11111111-1111-1111-1111-111111111111"
const roots: Root[] = []
const containers: HTMLDivElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  vi.resetAllMocks()
})

async function render(local: boolean) {
  bridge.schedules.list.mockResolvedValue([])
  bridge.backups.settings.mockResolvedValue({ localFolder: "/backups", keyFingerprint: "AAAA", recoveryExported: false, hasLocalBackups: true })
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(FirstBackupNextSteps, { tenantId: TENANT, plan: "pro", local })))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

describe("first backup next steps", () => {
  it("asks to save the recovery key for backups on this device", async () => {
    const container = await render(true)
    expect(container.textContent).toContain("Save your recovery key")
    expect(container.textContent).toContain("Backups on this device are encrypted")
  })

  it("leaves the recovery key out for Azure storage, which does not depend on it", async () => {
    const container = await render(false)
    expect(container.textContent).toContain("Turn on automatic backups")
    expect(container.textContent).toContain("Set up a scheduled backup to keep restore points for future losses. Only items captured in a backup can be restored.")
    expect(container.textContent).not.toContain("recovery key")
    expect(bridge.backups.settings).not.toHaveBeenCalled()
  })
})
