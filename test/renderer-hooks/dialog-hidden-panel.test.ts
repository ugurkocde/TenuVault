import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { Dialog, DialogAnimationProvider, DialogContent, DialogDescription, DialogTitle } from "../../src/portal/components/ui/dialog"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.innerHTML = ""
})

function render(root: Root, panelActive: boolean, open: boolean) {
  act(() => {
    root.render(
      createElement(DialogAnimationProvider, { value: panelActive },
        createElement(Dialog, { open },
          createElement(DialogContent, null,
            createElement(DialogTitle, null, "License agreement"),
            createElement(DialogDescription, null, "Terms")))),
    )
  })
}

describe("dialogs owned by a hidden panel", () => {
  it("animate while their panel shows and close without an exit animation once it hides", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    render(root, true, true)
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.className).toContain("data-[state=closed]:animate-out")

    // Hiding the panel closes the dialog in the same render. Without the exit animation class
    // Radix removes it at once instead of waiting for an animation that needs drawn frames.
    render(root, false, true)
    expect(document.querySelector('[role="dialog"]')?.className).not.toContain("animate-out")
    render(root, false, false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it("keep their animation outside any panel", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(createElement(Dialog, { open: true }, createElement(DialogContent, null, createElement(DialogTitle, null, "Title"), createElement(DialogDescription, null, "Text"))))
    })
    expect(document.querySelector('[role="dialog"]')?.className).toContain("data-[state=open]:animate-in")
  })
})
