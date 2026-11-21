import { act, createElement, useRef, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { app: { openExternal: async () => undefined } } }))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: null, signedInTenantIds: undefined, error: null, refresh: async () => undefined }),
}))

import { SupportDialog } from "../../src/renderer/components/SupportDialog"
import { focusedElement } from "../../src/renderer/lib/return-focus"

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
})

/** A dialog opened from a button that is not its DialogTrigger, as Help and the first-run header do. */
function Opener() {
  const [open, setOpen] = useState(false)
  const back = useRef<HTMLElement | null>(null)
  return createElement("div", null,
    createElement("button", { type: "button", id: "opener", onClick: () => { back.current = focusedElement(); setOpen(true) } }, "Help"),
    createElement(SupportDialog, { open, onOpenChange: setOpen, returnFocus: back }))
}

describe("dialogs opened without a trigger", () => {
  it("hand keyboard focus back to the element that opened them when closed with Escape", async () => {
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(createElement(Opener)))
    const opener = document.getElementById("opener") as HTMLButtonElement
    opener.focus()
    await act(async () => opener.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
