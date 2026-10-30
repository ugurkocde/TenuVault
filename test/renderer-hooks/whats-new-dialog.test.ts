import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WhatsNewState } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ whatsNew: vi.fn(), markSeen: vi.fn(), openExternal: vi.fn(async () => undefined) }))

vi.mock("@desktop/lib/bridge", () => ({
  bridge: {
    updates: { whatsNew: mocks.whatsNew, markWhatsNewSeen: mocks.markSeen },
    app: { openExternal: mocks.openExternal },
  },
}))

import { WhatsNewAnnouncement, WhatsNewDialog, WhatsNewEntries } from "../../src/renderer/components/WhatsNewDialog"
import { WhatsNewProvider } from "../../src/renderer/lib/whats-new"

const entry = (seen: boolean) => ({
  version: "0.3.1",
  channel: "stable" as const,
  title: "0.3.1",
  publishedAt: "2026-10-21T14:15:11Z",
  url: "https://github.com/ugurkocde/TenuVault/releases/tag/v0.3.1",
  changes: [{ text: "Add the thing", url: "https://github.com/ugurkocde/TenuVault/pull/200", reference: "#200" }],
  issues: [],
  unseen: !seen,
  installed: true,
})

const stateWith = (announceStable: boolean): WhatsNewState => ({
  currentVersion: "0.3.1",
  lastSeenVersion: announceStable ? "0.3.0" : "0.3.1",
  entries: [entry(!announceStable)],
  hasUnseen: announceStable,
  announceStable,
  error: null,
})

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ""
  mocks.whatsNew.mockReset()
  mocks.markSeen.mockReset()
})

async function render(state: WhatsNewState) {
  mocks.whatsNew.mockResolvedValue(state)
  mocks.markSeen.mockResolvedValue({ ...state, hasUnseen: false, announceStable: false, entries: state.entries.map((item) => ({ ...item, unseen: false })) })
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(WhatsNewProvider, null, createElement(WhatsNewAnnouncement))))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return container
}

describe("What's new announcement", () => {
  it("opens once for an unseen stable release and marks it seen on close", async () => {
    await render(stateWith(true))
    expect(document.body.textContent).toContain("What's new")
    expect(document.body.textContent).toContain("Add the thing")
    expect(document.body.textContent).toContain("Version 0.3.1")

    const done = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done")!
    await act(async () => { done.click() })
    expect(mocks.markSeen).toHaveBeenCalledTimes(1)
  })

  it("hides releases newer than the installed build from the dialog list", async () => {
    const state: WhatsNewState = {
      currentVersion: "0.3.0",
      lastSeenVersion: "0.3.0",
      entries: [{ ...entry(true), version: "0.3.2", installed: false }, { ...entry(true), version: "0.3.0" }],
      hasUnseen: false,
      announceStable: false,
      error: null,
    }
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(WhatsNewEntries, { state })))
    expect(container.textContent).toContain("Version 0.3.0")
    expect(container.textContent).not.toContain("Version 0.3.2")
  })

  it("does not mark the version seen when the notes failed to load", async () => {
    mocks.whatsNew.mockResolvedValue({
      currentVersion: "0.3.1",
      lastSeenVersion: "0.3.0",
      entries: [],
      hasUnseen: false,
      announceStable: false,
      error: "The release notes could not be loaded. GitHub answered 503.",
    } satisfies WhatsNewState)
    mocks.markSeen.mockResolvedValue(stateWith(false))
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(WhatsNewProvider, null, createElement(WhatsNewDialog, { open: true, onOpenChange: () => undefined }))))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(document.body.textContent).toContain("could not be loaded")

    const done = [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done")!
    await act(async () => { done.click() })
    expect(mocks.markSeen).not.toHaveBeenCalled()
  })

  it("stays closed when nothing stable is unseen", async () => {
    await render(stateWith(false))
    expect(document.body.textContent).not.toContain("Add the thing")
    expect(mocks.markSeen).not.toHaveBeenCalled()
  })
})
