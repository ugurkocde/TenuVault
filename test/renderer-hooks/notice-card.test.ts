import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"
import { NoticeCard } from "../../src/renderer/components/NoticeCard"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it("remembers dismissed tips for the same tenant and keeps backup facts visible", () => {
  const container = document.body.appendChild(document.createElement("div"))
  let root = createRoot(container)
  const tip = (tenantId: string) => createElement(NoticeCard, {
    summary: "Backup history is limited by this tenant's plan.",
    dismiss: { kind: "tip", tenantId, id: "retention" },
  })
  try {
    act(() => root.render(tip("Contoso")))
    act(() => container.querySelector("button")!.click())
    expect(container.textContent).toBe("")
    act(() => root.unmount())
    root = createRoot(container)
    act(() => root.render(tip("contoso")))
    expect(container.textContent).toBe("")
    act(() => root.render(tip("Fabrikam")))
    expect(container.textContent).toContain("Backup history")
    act(() => root.render(createElement(NoticeCard, { summary: "A backup type needs access." })))
    expect(container.textContent).toBe("A backup type needs access.")
    expect(container.querySelector("button")).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
    localStorage.clear()
  }
})
