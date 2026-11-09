import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Tenant } from "~/contexts/TenantContext"
import type { ListedReport, ReportsStatus } from "../../src/renderer/features/reports/api"
import type { ChangeReport } from "../../src/shared/reports/change-report"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT_ID = "11111111-1111-1111-1111-111111111111"
const api = vi.hoisted(() => ({
  status: vi.fn(),
  report: vi.fn(),
  exportFile: vi.fn(),
  generate: vi.fn(),
  send: vi.fn(),
  saveSettings: vi.fn(),
  remove: vi.fn(),
}))
const saveFile = vi.hoisted(() => vi.fn())

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: { reports: { saveFile: async () => ({ saved: false }) } },
}))
vi.mock("../../src/renderer/features/reports/api", async (original) => ({
  ...(await original<object>()),
  reportsApi: api,
}))
vi.mock("../../src/renderer/components/oib/notices", async (original) => ({
  ...(await original<object>()),
  saveFile,
}))
vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))
vi.mock("../../src/renderer/lib/backup-list", () => ({
  useBackupList: () => ({
    backups: [
      { id: "backup-2026-11-07-020000", timestamp: "2026-11-07T02:00:00.000Z", status: "Completed" },
      { id: "backup-2026-11-05-020000", timestamp: "2026-11-05T02:00:00.000Z", status: "Completed" },
    ],
    loading: false,
  }),
}))

import ChangeReportsTab from "../../src/renderer/features/reports/ChangeReportsTab"

const tenant = {
  id: 1,
  name: "Contoso Ltd",
  credentials: { tenantId: TENANT_ID, appId: "app-1", clientSecret: "" },
} as unknown as Tenant

const backup = (id: string, timestamp: string) => ({ id, timestamp, trigger: "scheduled", status: "Completed" })
const listed = (overrides: Partial<ListedReport> = {}): ListedReport => ({
  id: "report-1",
  title: "Changes in Contoso Ltd, 5 Nov 2026 to 7 Nov 2026",
  summary: "2 changed",
  createdAt: "2026-11-07T08:46:00.000Z",
  trigger: "manual",
  from: backup("backup-2026-11-05-020000", "2026-11-05T02:00:00.000Z"),
  to: backup("backup-2026-11-07-020000", "2026-11-07T02:00:00.000Z"),
  counts: { added: 1, modified: 2, deleted: 0, critical: 0, attributed: 2 },
  audit: "included",
  values: true,
  lastSend: null,
  ...overrides,
})

const settings: ReportsStatus["settings"] = {
  recipients: [{ type: "address", address: "it@contoso.example" }],
  afterScheduledBackup: true,
  skipEmpty: true,
  includeValues: true,
  includeActors: true,
  attachment: "pdf",
  lastAutomatic: null,
}

const report = (listedReport: ListedReport): ChangeReport => ({
  schemaVersion: 1,
  tenantId: TENANT_ID,
  tenantName: "Contoso Ltd",
  generatedAt: listedReport.createdAt,
  trigger: listedReport.trigger,
  from: listedReport.from,
  to: listedReport.to,
  summary: listedReport.counts,
  items: [],
  otherActivity: [],
  moreActivity: 0,
  audit: { status: listedReport.audit, note: listedReport.audit === "included" ? null : "The audit log could not be read.", actors: true },
  values: true,
  warnings: [],
})

const roots: Root[] = []
const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

async function render(allowed = true): Promise<HTMLDivElement> {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  await act(async () => {
    root.render(createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(ChangeReportsTab, { tenant, plan: allowed ? "pro" : "community", allowed })),
    ))
  })
  await flush()
  return container
}

const buttons = (scope: ParentNode) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined
  vi.clearAllMocks()
  api.status.mockResolvedValue({ licensed: true, runtimeNote: "Runtime note", settings, reports: [listed()] })
  api.report.mockImplementation(async (_tenant: unknown, reportId: string) => ({ report: report(listed({ id: reportId })), sends: [] }))
  api.exportFile.mockImplementation(async (_tenant: unknown, _reportId: string, format: string) => ({
    fileName: format === "pdf" ? "report.pdf" : `report.${format === "markdown" ? "md" : "json"}`,
    data: format === "pdf" ? "base64" : "# Report",
    encoding: format === "pdf" ? "base64" : "utf8",
  }))
  saveFile.mockResolvedValue({ saved: true, fileName: "report.md", path: "/tmp/report.md" })
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
})

describe("change report export access", () => {
  it("exports a collapsed report from its row Export menu without loading its details", async () => {
    let finishSave: ((result: { saved: boolean; fileName: string; path: string }) => void) | undefined
    saveFile.mockImplementation(() => new Promise((resolve) => { finishSave = resolve }))
    const container = await render()
    const trigger = buttons(container).find((button) => button.getAttribute("aria-label")?.startsWith("Export Changes in Contoso Ltd"))
    expect(trigger, "collapsed report Export menu").toBeDefined()
    expect(trigger?.textContent).toContain("Export")
    trigger!.focus()

    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
      trigger!.click()
    })
    await flush()
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual(["PDF report", "Markdown", "JSON"])

    const markdown = menuItems().find((item) => item.textContent?.trim() === "Markdown")!
    await act(async () => {
      markdown.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }))
      markdown.click()
    })
    await flush()
    expect(api.exportFile).toHaveBeenCalledWith(tenant, "report-1", "markdown")
    expect(saveFile).toHaveBeenCalledWith("# Report", "report.md", "utf8")
    expect(trigger!.disabled).toBe(false)
    expect(trigger!.getAttribute("aria-disabled")).toBe("true")
    expect(document.activeElement).toBe(trigger)

    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
      trigger!.click()
    })
    await flush()
    expect(menuItems()).toHaveLength(0)

    await act(async () => { finishSave?.({ saved: true, fileName: "report.md", path: "/tmp/report.md" }) })
    await flush()
    expect(trigger!.getAttribute("aria-disabled")).not.toBe("true")
    expect(document.activeElement).toBe(trigger)
    expect(api.report).not.toHaveBeenCalled()
    expect(container.textContent).toContain("report.md")
  })

  it("keeps Export in a sticky expanded action bar, separated from Remove", async () => {
    api.status.mockResolvedValue({
      licensed: true,
      runtimeNote: "Runtime note",
      settings,
      reports: [listed({ id: "report-unavailable", audit: "unavailable" })],
    })
    const container = await render()
    const toggle = buttons(container).find((button) => button.textContent?.includes("Changes in Contoso Ltd"))!
    await act(async () => { toggle.click() })
    await flush()

    const actions = container.querySelector<HTMLElement>('[aria-label="Report actions"]')
    expect(actions, "expanded report actions").not.toBeNull()
    expect(actions?.className).toContain("sticky")
    expect(actions?.textContent).toContain("Export")
    expect(actions?.textContent).not.toContain("Markdown")
    expect(actions?.textContent).toContain("Send by email")
    expect(actions?.textContent).toContain("Regenerate this report")
    const remove = buttons(actions!).find((button) => button.textContent?.trim() === "Remove")
    expect(remove?.className).toContain("ml-auto")
  })

  it("keeps stored reports exportable in read-only mode without write actions", async () => {
    api.status.mockResolvedValue({ licensed: true, runtimeNote: "Runtime note", settings, reports: [listed({ audit: "unavailable" })] })
    const container = await render(false)
    expect(buttons(container).some((button) => button.getAttribute("aria-label")?.startsWith("Export Changes in Contoso Ltd"))).toBe(true)

    const toggle = buttons(container).find((button) => button.textContent?.includes("Changes in Contoso Ltd"))!
    await act(async () => { toggle.click() })
    await flush()
    const actions = container.querySelector<HTMLElement>('[aria-label="Report actions"]')
    expect(actions?.textContent).toContain("Export")
    expect(actions?.textContent).not.toContain("Send by email")
    expect(actions?.textContent).not.toContain("Remove")
    expect(actions?.textContent).not.toContain("Regenerate this report")
  })
})

 it("announces paused automatic reports only when configured", async () => {
   api.status.mockResolvedValue({ licensed: false, runtimeNote: "", settings: { ...settings, afterScheduledBackup: true }, reports: [] })
   const configured = await render(false)
   expect(configured.textContent).toContain("Paused on Community")
   expect(configured.textContent).not.toContain("Generate one above")
   expect(configured.querySelector('a[href="/license"]')).not.toBeNull()
   api.status.mockResolvedValue({ licensed: false, runtimeNote: "", settings: { ...settings, afterScheduledBackup: false }, reports: [] })
   expect((await render(false)).textContent).not.toContain("Paused on Community")
 })
