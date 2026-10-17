import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UpdateStatus } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const updatesStatus = vi.hoisted(() => vi.fn())
const updatesCheck = vi.hoisted(() => vi.fn())
const updatesInstall = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => vi.fn())
const listener = vi.hoisted(() => ({ current: null as ((status: UpdateStatus) => void) | null }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    updates: {
      status: updatesStatus,
      check: updatesCheck,
      install: updatesInstall,
      onChanged: (onChanged: (status: UpdateStatus) => void) => {
        listener.current = onChanged
        return () => {
          listener.current = null
        }
      },
    },
  },
}))

vi.mock("../../src/renderer/lib/toast", () => ({ toast }))

import { UpdateSidebarLabel } from "../../src/renderer/components/UpdateSidebarLabel"

const roots: Root[] = []
const containers: HTMLDivElement[] = []

function render(): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  let root: Root
  act(() => {
    root = createRoot(container)
    roots.push(root)
    root.render(createElement(UpdateSidebarLabel))
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function emit(status: UpdateStatus): void {
  act(() => listener.current?.(status))
}

function button(container: HTMLDivElement): HTMLButtonElement | null {
  return container.querySelector("button")
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await flush()
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  listener.current = null
  vi.clearAllMocks()
  updatesStatus.mockResolvedValue({ state: "idle" })
  updatesCheck.mockResolvedValue({ state: "idle" })
  updatesInstall.mockResolvedValue(undefined)
})

describe("UpdateSidebarLabel", () => {
  it("renders nothing while no update is available", async () => {
    updatesStatus.mockResolvedValue({ state: "idle" })
    const container = render()
    await flush()
    expect(button(container)).toBeNull()
    emit({ state: "checking" })
    expect(button(container)).toBeNull()
    emit({ state: "not-available" })
    expect(button(container)).toBeNull()
    emit({ state: "disabled" })
    expect(button(container)).toBeNull()
  })

  it("shows a green label with the version while the update downloads", async () => {
    updatesStatus.mockResolvedValue({ state: "downloading", version: "0.3.1", percent: 40 })
    const container = render()
    await flush()
    const label = button(container)
    expect(label).not.toBeNull()
    expect(label?.className).toContain("bg-green-700")
    expect(label?.textContent).toContain("Update available")
    expect(label?.textContent).toContain("0.3.1")
    expect(label?.getAttribute("aria-disabled")).toBeNull()
    expect(label?.getAttribute("aria-label")).toBe("Download and install TenuVault 0.3.1")
  })

  it("keeps the label readable for a long nightly version, with the full version in the tooltip", async () => {
    updatesStatus.mockResolvedValue({ state: "ready", version: "0.3.1-nightly.20261017090000" })
    const container = render()
    await flush()
    const label = button(container)
    expect(label?.textContent).toContain("Update available")
    expect(label?.textContent).not.toContain("0.3.1-nightly.20261017090000")
    expect(label?.getAttribute("title")).toBe("TenuVault 0.3.1-nightly.20261017090000")
    expect(label?.getAttribute("aria-label")).toBe("Download and install TenuVault 0.3.1-nightly.20261017090000")
  })

  it("installs once the download finishes after being pressed during downloading", async () => {
    updatesStatus.mockResolvedValue({ state: "downloading", version: "0.3.1-nightly.20261017090000", percent: 40 })
    const container = render()
    await flush()
    await click(button(container)!)
    expect(updatesInstall).not.toHaveBeenCalled()
    expect(updatesCheck).not.toHaveBeenCalled()
    expect(button(container)?.getAttribute("aria-disabled")).toBe("true")
    expect(button(container)?.hasAttribute("disabled")).toBe(false)
    expect(button(container)?.textContent).toContain("Downloading 40%")
    expect(button(container)?.textContent).not.toContain("0.3.1-nightly.20261017090000")
    emit({ state: "downloading", version: "0.3.1-nightly.20261017090000", percent: 80 })
    expect(button(container)?.textContent).toContain("Downloading 80%")
    emit({ state: "ready", version: "0.3.1-nightly.20261017090000" })
    await flush()
    expect(updatesInstall).toHaveBeenCalledTimes(1)
    emit({ state: "ready", version: "0.3.1-nightly.20261017090000" })
    await flush()
    expect(updatesInstall).toHaveBeenCalledTimes(1)
  })

  it("installs right away when pressed after the download finished", async () => {
    updatesStatus.mockResolvedValue({ state: "ready", version: "0.3.1" })
    const container = render()
    await flush()
    expect(button(container)?.textContent).toContain("Update available")
    await click(button(container)!)
    expect(updatesInstall).toHaveBeenCalledTimes(1)
    expect(button(container)?.getAttribute("aria-disabled")).toBe("true")
    expect(button(container)?.textContent).toContain("Installing update")
  })

  it("reports a failed download after being pressed and drops the pending install", async () => {
    updatesStatus.mockResolvedValue({ state: "downloading", version: "0.3.1", percent: 10 })
    const container = render()
    await flush()
    await click(button(container)!)
    emit({ state: "error", message: "net::ERR_INTERNET_DISCONNECTED" })
    await flush()
    expect(updatesInstall).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith("Update failed: net::ERR_INTERNET_DISCONNECTED", "error")
    expect(button(container)).toBeNull()
    emit({ state: "ready", version: "0.3.1" })
    await flush()
    expect(updatesInstall).not.toHaveBeenCalled()
    expect(button(container)?.getAttribute("aria-disabled")).toBeNull()
  })

  it("does not toast for an update error nobody asked to install", async () => {
    updatesStatus.mockResolvedValue({ state: "downloading", version: "0.3.1", percent: 10 })
    render()
    await flush()
    emit({ state: "error", message: "net::ERR_INTERNET_DISCONNECTED" })
    await flush()
    expect(toast).not.toHaveBeenCalled()
  })

  it("drops a pending install when the update goes away, for example after a channel change", async () => {
    updatesStatus.mockResolvedValue({ state: "downloading", version: "0.3.1-nightly.20261017090000", percent: 10 })
    const container = render()
    await flush()
    await click(button(container)!)
    emit({ state: "idle" })
    expect(button(container)).toBeNull()
    emit({ state: "downloading", version: "0.3.1", percent: 50 })
    expect(button(container)?.textContent).toContain("Update available")
    expect(button(container)?.getAttribute("aria-disabled")).toBeNull()
    emit({ state: "ready", version: "0.3.1" })
    await flush()
    expect(updatesInstall).not.toHaveBeenCalled()
    await click(button(container)!)
    expect(updatesInstall).toHaveBeenCalledTimes(1)
  })

  it("toasts once when a failed install also reports an error status", async () => {
    updatesStatus.mockResolvedValue({ state: "ready", version: "0.3.1" })
    let rejectInstall: (error: Error) => void = () => {}
    updatesInstall.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectInstall = reject }))
    const container = render()
    await flush()
    await click(button(container)!)
    emit({ state: "error", message: "The downloaded update was not installed: bad signature" })
    await flush()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith("Update failed: The downloaded update was not installed: bad signature", "error")
    await act(async () => {
      rejectInstall(new Error("The downloaded update was not installed: bad signature"))
    })
    await flush()
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it("can be pressed again after install itself fails", async () => {
    updatesStatus.mockResolvedValue({ state: "ready", version: "0.3.1" })
    updatesInstall.mockRejectedValueOnce(new Error("The downloaded update was not installed: bad signature"))
    const container = render()
    await flush()
    await click(button(container)!)
    expect(toast).toHaveBeenCalledWith("The downloaded update was not installed: bad signature", "error")
    expect(button(container)?.getAttribute("aria-disabled")).toBeNull()
    await click(button(container)!)
    expect(updatesInstall).toHaveBeenCalledTimes(2)
  })
})
