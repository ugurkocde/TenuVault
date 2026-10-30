import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TENANT = "11111111-1111-1111-1111-111111111111"
const state = vi.hoisted(() => ({ list: vi.fn(), refusals: vi.fn(), changed: null as null | ((next: unknown[]) => void) }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    schedules: {
      list: state.list,
      refusals: state.refusals,
      onChanged: (listener: (next: unknown[]) => void) => { state.changed = listener; return () => undefined },
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
  const { schedules, error, loading, reload } = useSchedules()
  return createElement("div", null,
    createElement("p", { "data-schedules": "" }, String(schedules.length)),
    createElement("p", { "data-error": "" }, error ?? ""),
    createElement("p", { "data-loading": "" }, String(loading)),
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

  it("reports loading until the first read settles", async () => {
    let resolveList: ((value: unknown[]) => void) | undefined
    state.list.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    const container = await renderProbe(createElement(SchedulesProbe))
    expect(container.querySelector("[data-loading]")?.textContent).toBe("true")
    await act(async () => resolveList!([]))
    expect(container.querySelector("[data-loading]")?.textContent).toBe("false")
  })

  it("ignores a read that a change event superseded, whether it resolves or rejects", async () => {
    let rejectList: ((error: Error) => void) | undefined
    state.list.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectList = reject }))
    const container = await renderProbe(createElement(SchedulesProbe))
    await act(async () => state.changed!([{ tenantId: TENANT, enabled: true }]))
    expect(container.querySelector("[data-schedules]")?.textContent).toBe("1")
    await act(async () => rejectList!(new Error("stale failure")))
    expect(container.querySelector("[data-error]")?.textContent).toBe("")
    expect(container.querySelector("[data-schedules]")?.textContent).toBe("1")
  })

  it("exposes a refusals failure instead of reporting none", async () => {
    state.refusals.mockRejectedValueOnce(new Error("refusals IPC down"))
    const container = await renderProbe(createElement(RefusalsProbe))
    expect(container.querySelector("[data-refusals]")?.textContent).toBe("0")
    expect(container.querySelector("[data-error]")?.textContent).toContain("refusals IPC down")
  })
})
