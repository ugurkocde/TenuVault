import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT = "11111111-1111-1111-1111-111111111111"
const state = vi.hoisted(() => ({ list: vi.fn(), refusals: vi.fn() }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    schedules: {
      list: state.list,
      refusals: state.refusals,
      onChanged: () => () => undefined,
      onRefusalsChanged: () => () => undefined,
    },
  },
}))

import { useRefusals, useSchedules } from "../../src/renderer/lib/schedules"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  state.list.mockReset()
  state.refusals.mockReset()
})

async function renderProbe(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(element))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

function SchedulesProbe() {
  const { schedules, error, reload } = useSchedules()
  return createElement("div", null,
    createElement("p", { "data-schedules": "" }, String(schedules.length)),
    createElement("p", { "data-error": "" }, error ?? ""),
    createElement("button", { onClick: reload }, "Reload schedules"))
}

function RefusalsProbe() {
  const { refusals, error } = useRefusals(TENANT)
  return createElement("div", null,
    createElement("p", { "data-refusals": "" }, String(refusals.length)),
    createElement("p", { "data-error": "" }, error ?? ""))
}

describe("schedule hooks on IPC failure", () => {
  it("exposes the failure instead of reporting no schedules, and clears it on reload", async () => {
    state.list.mockRejectedValueOnce(new Error("schedule IPC down")).mockResolvedValue([{ tenantId: TENANT, enabled: true }])
    const container = await renderProbe(createElement(SchedulesProbe))
    expect(container.querySelector("[data-schedules]")?.textContent).toBe("0")
    expect(container.querySelector("[data-error]")?.textContent).toContain("schedule IPC down")
    const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Reload schedules")!
    await act(async () => { button.click() })
    expect(container.querySelector("[data-schedules]")?.textContent).toBe("1")
    expect(container.querySelector("[data-error]")?.textContent).toBe("")
  })

  it("exposes a refusals failure instead of reporting none", async () => {
    state.refusals.mockRejectedValueOnce(new Error("refusals IPC down"))
    const container = await renderProbe(createElement(RefusalsProbe))
    expect(container.querySelector("[data-refusals]")?.textContent).toBe("0")
    expect(container.querySelector("[data-error]")?.textContent).toContain("refusals IPC down")
  })
})
