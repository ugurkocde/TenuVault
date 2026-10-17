import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver

const baseJob = {
  tenantId: "tenant", status: "Running", progress: 37, progressMessage: "Backing up apps",
  isComplete: false, isSuccessful: false, isMinimized: true,
  credentials: { tenantId: "tenant", appId: "app", clientSecret: "" },
  resources: { subscriptionId: "local", resourceGroupName: "local", automationAccountName: "", storageAccountName: "tvlocal-tenant" },
}
const running = { ...baseJob, jobId: "desktop-running", tenantName: "Ugur Koc Lab" }
const stuck = { ...baseJob, jobId: "desktop-stuck", tenantName: "UgurLabs Production", progress: 12, pollError: "Failed to check job status" }

// A stateful stand-in for the backup progress store: removeJob really removes the job.
vi.mock("~/contexts/BackupProgressContext", async () => {
  const react = await import("react")
  return {
    useBackupProgress: () => {
      const [activeJobs, setActiveJobs] = react.useState([running, stuck])
      return { activeJobs, removeJob: (jobId: string) => setActiveJobs((prev) => prev.filter((job) => job.jobId !== jobId)) }
    },
  }
})
vi.mock("@desktop/lib/bridge", () => ({ bridge: { backups: { cancel: async () => undefined } } }))
vi.mock("@desktop/lib/license", () => ({ useLicense: () => ({ status: null }), tenantLicense: () => null, tenantPlan: () => null }))
vi.mock("@desktop/components/FirstBackupNote", () => ({ FirstBackupNote: () => null }))

import { FloatingProgress } from "../../src/portal/components/backup/floating-progress"

const roots: Root[] = []
function mount(): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(createElement(FloatingProgress)) })
  return container
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
})

describe("floating backup panel dismissal", () => {
  it("keeps a job whose status polling failed dismissible, while a healthy running job has no dismiss", async () => {
    const container = mount()
    expect(container.textContent).toContain("2 running")
    expect(container.textContent).toContain("Failed to check job status")
    expect(container.querySelector('[aria-label="Dismiss backup for Ugur Koc Lab"]')).toBeNull()

    const dismiss = container.querySelector('[aria-label="Dismiss backup for UgurLabs Production"]')
    expect(dismiss).not.toBeNull()
    await act(async () => { (dismiss as HTMLElement).click() })

    expect(container.textContent).not.toContain("UgurLabs Production")
    expect(container.textContent).toContain("Ugur Koc Lab")
  })
})
