import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { BackupSchedulePanel } from "../src/renderer/components/BackupSchedulePanel"
import type { BackupSchedule } from "../src/shared/ipc"

const state = vi.hoisted(() => ({ schedules: [] as BackupSchedule[] }))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
}))
vi.mock("@desktop/lib/bridge", () => ({ bridge: {} }))
vi.mock("@desktop/lib/schedules", async (original) => ({
  ...await original<typeof import("../src/renderer/lib/schedules")>(),
  useSchedules: () => state.schedules,
  useRefusals: () => [],
}))
vi.mock("@desktop/lib/license", () => ({ useLicense: () => ({ status: null }), tenantLicense: () => null, tenantPlan: () => null }))

const schedule: BackupSchedule = { tenantId: "tenant", enabled: true, frequency: "weekly", weekday: 0, time: "02:00", since: "2026-10-01T00:00:00Z", nextRunAt: "2026-10-18T02:15:00Z", lastAttemptAt: "2026-10-18T02:00:00Z", attempts: 1 }

function lastAttempt(status: BackupSchedule["lastStatus"]): string {
  state.schedules = [{ ...schedule, lastStatus: status }]
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(BackupSchedulePanel, { tenantId: "tenant", tenantName: "Contoso" })))
  const start = markup.indexOf("Last automatic backup")
  return markup.slice(start, markup.indexOf("</dd>", start))
}

describe("schedule panel last attempt", () => {
  it.each([
    [undefined, "Last automatic backup<", "text-gray-500"],
    ["Cancelled", "Last automatic backup cancelled", "text-gray-500"],
    ["Failed", "Last automatic backup attempt failed", "text-red-600"],
    ["Completed", "Last automatic backup<", "text-green-600"],
  ] as const)("shows status %s with a matching label and icon", (status, label, icon) => {
    const markup = lastAttempt(status)
    expect(markup).toContain(label)
    expect(markup).toContain(icon)
    for (const other of ["text-gray-500", "text-red-600", "text-green-600"].filter((tone) => tone !== icon)) expect(markup).not.toContain(other)
  })
})
