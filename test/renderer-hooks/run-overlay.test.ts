import { act, createElement, StrictMode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { RunOverlay, type RunOverlayStep } from "../../src/renderer/components/RunOverlay"

const steps: RunOverlayStep[] = [
  { label: "Check the backups", state: "done" },
  { label: "Compare the backups", state: "current" },
  { label: "Check revert history", state: "waiting" },
]

interface HarnessOptions {
  percent?: number | null
  captureFocus?: boolean
  strict?: boolean
  error?: string
  onCancel?: () => void
}

const roots: Root[] = []
const containers: HTMLDivElement[] = []

/** A page with a start control, a sidebar stand-in, a results header and the overlay over it. */
function render(options: HarnessOptions = {}): { container: HTMLDivElement; setRunning: (value: boolean) => void; setStartShown: (value: boolean) => void } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  let setRunning: (value: boolean) => void = () => undefined
  let setStartShown: (value: boolean) => void = () => undefined
  function Harness() {
    const [running, setRunningState] = useState(false)
    const [startShown, setStartShownState] = useState(true)
    setRunning = setRunningState
    setStartShown = setStartShownState
    return createElement("div", null,
      createElement("button", { type: "button", id: "sidebar-link" }, "Another page"),
      running && createElement(RunOverlay, {
        ariaLabel: "Scan in progress",
        title: "Comparing the backups",
        subtitle: "Nothing is changed.",
        percent: options.percent === undefined ? 42 : options.percent,
        progressLabel: "Scan progress",
        detail: "Comparing policies: 4 of 10",
        subDetail: "current: A very long policy name",
        steps,
        error: options.error,
        captureFocus: options.captureFocus,
        focusFallbackSelector: "#results-heading",
        actions: createElement("button", { type: "button", onClick: options.onCancel }, "Cancel scan"),
      }),
      createElement("div", { inert: running },
        startShown && createElement("button", { type: "button", id: "start-scan" }, "Compare"),
        createElement("h2", { id: "results-heading", tabIndex: -1 }, "Results"),
      ),
    )
  }
  let root: Root
  act(() => {
    root = createRoot(container)
    roots.push(root)
    root.render(options.strict ? createElement(StrictMode, null, createElement(Harness)) : createElement(Harness))
  })
  return { container, setRunning: (value) => act(() => setRunning(value)), setStartShown: (value) => act(() => setStartShown(value)) }
}

function overlay(container: HTMLDivElement): HTMLElement | null {
  return container.querySelector('[aria-label="Scan in progress"]')
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
})

describe("RunOverlay", () => {
  it("renders as a fixed region with one progressbar, the percent, detail lines and steps", () => {
    const { container, setRunning } = render()
    setRunning(true)
    const view = overlay(container)
    expect(view?.getAttribute("role")).toBe("region")
    expect(view?.className).toContain("fixed")
    expect(view?.className).toContain("run-overlay")
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute("aria-label")).toBe("Scan progress")
    expect(bar?.getAttribute("aria-valuenow")).toBe("42")
    expect(bar?.getAttribute("aria-valuetext")).toBe("42 percent, Comparing policies: 4 of 10")
    expect(view?.textContent).toContain("Comparing the backups")
    expect(view?.textContent).toContain("current: A very long policy name")
    const current = container.querySelectorAll('[aria-current="step"]')
    expect(current).toHaveLength(1)
    expect(current[0]?.textContent).toContain("Compare the backups")
    expect(current[0]?.textContent).toContain("In progress")
  })

  it("omits aria-valuenow and shows the moving bar while indeterminate", () => {
    const { container, setRunning } = render({ percent: null })
    setRunning(true)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.hasAttribute("aria-valuenow")).toBe(false)
    expect(bar?.getAttribute("aria-valuetext")).toBe("Comparing the backups")
    expect(container.querySelector(".run-indeterminate")).not.toBeNull()
  })

  it("takes focus on entry and returns it to the starting control on exit", () => {
    const { container, setRunning } = render()
    const start = container.querySelector<HTMLElement>("#start-scan")!
    act(() => start.focus())
    setRunning(true)
    expect(document.activeElement).toBe(overlay(container))
    setRunning(false)
    expect(document.activeElement).toBe(start)
  })

  it("returns focus to the starting control under Strict Mode", () => {
    const { container, setRunning } = render({ strict: true })
    const start = container.querySelector<HTMLElement>("#start-scan")!
    act(() => start.focus())
    setRunning(true)
    setRunning(false)
    expect(document.activeElement).toBe(start)
  })

  it("falls back to the results heading when the starting control is gone", () => {
    const { container, setRunning, setStartShown } = render()
    const start = container.querySelector<HTMLElement>("#start-scan")!
    act(() => start.focus())
    setRunning(true)
    setStartShown(false)
    setRunning(false)
    expect(document.activeElement).toBe(container.querySelector("#results-heading"))
  })

  it("leaves focus the user moved elsewhere alone on exit", () => {
    const { container, setRunning } = render()
    setRunning(true)
    const sidebar = container.querySelector<HTMLElement>("#sidebar-link")!
    act(() => sidebar.focus())
    setRunning(false)
    expect(document.activeElement).toBe(sidebar)
  })

  it("does not capture focus for a run the admin did not start here", () => {
    const { container, setRunning } = render({ captureFocus: false })
    const sidebar = container.querySelector<HTMLElement>("#sidebar-link")!
    act(() => sidebar.focus())
    setRunning(true)
    expect(document.activeElement).toBe(sidebar)
    setRunning(false)
    expect(document.activeElement).toBe(sidebar)
  })

  it("renders the error as an alert and the actions as working controls", () => {
    const onCancel = vi.fn()
    const { container, setRunning } = render({ error: "The status could not be read.", onCancel })
    setRunning(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The status could not be read.")
    const cancel = [...container.querySelectorAll("button")].find(button => button.textContent === "Cancel scan")!
    act(() => cancel.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
