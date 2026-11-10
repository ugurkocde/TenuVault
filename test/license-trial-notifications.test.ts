import type { BrowserWindow } from "electron"
import { beforeEach, expect, it, vi } from "vitest"
import { notifyTenantTrial } from "../src/main/license/notifications"
const noticeEnd = new Date(2026, 10, 10, 17).getTime()
const state = vi.hoisted(() => ({ supported: true, options: {} as { title: string; body: string }, click: () => {}, show: vi.fn() }))
vi.mock("electron", () => ({ Notification: class {
  static isSupported() { return state.supported }
  constructor(options: typeof state.options) { state.options = options }
  on(_event: string, callback: () => void) { state.click = callback }
  show() { state.show() }
} }))
beforeEach(() => { vi.clearAllMocks(); state.supported = true })
it.each([false, true])("shows the %s notice and opens License", ended => {
  const executeJavaScript = vi.fn(async () => undefined)
  const window = { isDestroyed: () => false, webContents: { executeJavaScript, isLoadingMainFrame: () => false } } as unknown as BrowserWindow
  expect(notifyTenantTrial("Contoso", ended, () => window, noticeEnd)).toBe(true)
  expect(state.options.body).toContain(ended ? `ended on ${new Date(noticeEnd).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : "Your Pro trial for Contoso ends")
  expect(state.show).toHaveBeenCalledOnce()
  state.click()
  expect(executeJavaScript).toHaveBeenCalledWith('location.hash = "/license"')
})
it("waits for a newly opened window to load and handles closure", () => {
  let navigate = () => {}
  let destroyed = false
  const executeJavaScript = vi.fn(async () => undefined)
  const window = { isDestroyed: () => destroyed, webContents: { executeJavaScript, isLoadingMainFrame: () => true, once: (_event: string, callback: () => void) => { navigate = callback } } } as unknown as BrowserWindow
  notifyTenantTrial("Contoso", false, () => window)
  state.click()
  expect(executeJavaScript).not.toHaveBeenCalled()
  navigate()
  expect(executeJavaScript).toHaveBeenCalledOnce()
  destroyed = true
  navigate()
  expect(executeJavaScript).toHaveBeenCalledOnce()
})
it("handles unsupported notifications, missing windows and navigation errors", async () => {
  state.supported = false
  expect(notifyTenantTrial("Contoso", false, () => null)).toBe(false)
  state.supported = true
  notifyTenantTrial("Contoso", false, () => null)
  state.click()
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const window = { isDestroyed: () => false, webContents: { isLoadingMainFrame: () => false, executeJavaScript: vi.fn(async () => { throw new Error("closed") }) } } as unknown as BrowserWindow
  notifyTenantTrial("Contoso", true, () => window)
  state.click()
  await Promise.resolve()
  expect(warn).toHaveBeenCalledWith("Error: closed")
  warn.mockRestore()
})

it.each([0, 1])("uses the local calendar for a notice ending in %s calendar days", offset => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 9))
  try {
    notifyTenantTrial("Contoso", false, () => null, new Date(2026, 10, 10 + offset, offset ? 8 : 17).getTime())
    expect(state.options.body).toContain(`ends ${offset ? "tomorrow" : "today"}`)
    expect(state.options.title).toBe(`Your Pro trial ends ${offset ? "tomorrow" : "today"}`)
  } finally { vi.useRealTimers() }
})

it("does not offer an extension when the ended trial cannot be extended", () => {
  notifyTenantTrial("Contoso", true, () => null, noticeEnd, false)
  expect(state.options.body).toContain("ended on")
  expect(state.options.body).not.toContain("extend the trial")
  expect(state.options.body).toContain("get Pro or ask for an invoice")
})
