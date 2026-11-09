import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackupSettings } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const backups = vi.hoisted(() => ({ importRecoveryKey: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { backups } }))

import { LegacySealedBackupsNotice } from "../../src/renderer/components/LegacySealedBackupsNotice"

const settings: BackupSettings = { localFolder: "/backups", keyFingerprint: "BBBB", recoveryExported: true, hasLocalBackups: false }
const roots: Root[] = []
const containers: HTMLDivElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  vi.resetAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function render(count: number, onImported: () => Promise<void>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  const draw = (next: number) => act(() => root.render(createElement(LegacySealedBackupsNotice, { count: next, onImported })))
  draw(count)
  return { container, draw }
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`No button ${label}`)
  await act(async () => button.click())
  await flush()
}

async function importKey(container: HTMLElement) {
  await click(container, "Import recovery key")
  const textarea = container.querySelector("textarea")!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    setter.call(textarea, "TVK2.example")
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click(container, "Import")
}

describe("legacy sealed Azure backups notice", () => {
  it("shows nothing while every Azure backup can be read", () => {
    const { container } = render(0, vi.fn())
    expect(container.textContent).toBe("")
  })

  it("is advisory: a status message with an Import recovery key action, never an alert", () => {
    const { container } = render(2, vi.fn())
    expect(container.querySelector("[role=status]")).not.toBeNull()
    expect(container.querySelector("[role=alert]")).toBeNull()
    expect(container.textContent).toContain("2 older Azure backups need a recovery key")
    expect(container.textContent).toContain("encrypted by an earlier TenuVault version")
    expect(container.textContent).toContain("New backups and your other backups are not affected")
    expect([...container.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["Import recovery key"])
  })

  it("lists the backups again after an import and says so when the key did not open them", async () => {
    backups.importRecoveryKey.mockResolvedValue(settings)
    const onImported = vi.fn(async () => undefined)
    const { container } = render(1, onImported)
    expect(container.textContent).toContain("An older Azure backup needs a recovery key")
    await importKey(container)
    expect(backups.importRecoveryKey).toHaveBeenCalledWith("TVK2.example")
    expect(onImported).toHaveBeenCalledOnce()
    expect(container.textContent).toContain("The imported key does not open this backup")
  })

  it("goes away once the list after an import has no such backups", async () => {
    backups.importRecoveryKey.mockResolvedValue(settings)
    let draw!: (count: number) => void
    const onImported = vi.fn(async () => { draw(0) })
    const rendered = render(3, onImported)
    draw = rendered.draw
    await importKey(rendered.container)
    expect(rendered.container.textContent).toBe("")
    rendered.draw(1)
    expect(rendered.container.textContent).not.toContain("The imported key does not open")
  })
})
