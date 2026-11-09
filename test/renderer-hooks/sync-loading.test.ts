import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { stillReading, useElapsed } from "../../src/renderer/features/sync/loading"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
})

function Clock({ running }: { running: boolean }) {
  return createElement("p", null, stillReading(useElapsed(running)) ?? "reading")
}

describe("Sync loading clock", () => {
  it("counts real seconds while a request runs, says so after 5 s, and resets when it ends", () => {
    vi.useFakeTimers()
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(Clock, { running: true })))
    act(() => { vi.advanceTimersByTime(4000) })
    expect(container.textContent).toBe("reading")
    act(() => { vi.advanceTimersByTime(8000) })
    expect(container.textContent).toBe("Still reading, 12 s")
    act(() => root.render(createElement(Clock, { running: false })))
    expect(container.textContent).toBe("reading")
  })
})
