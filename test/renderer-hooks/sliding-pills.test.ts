import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useHoverPill } from "../../src/renderer/components/SidebarNavigation"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const observed = new Set<Element>()
class FakeResizeObserver {
  private mine: Element[] = []
  observe(element: Element) { this.mine.push(element); observed.add(element) }
  disconnect() { for (const element of this.mine) observed.delete(element); this.mine = [] }
}

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  observed.clear()
  vi.unstubAllGlobals()
})

/** A nav that is only there while the sidebar shows, like around the first-run setup. */
function Sidebar({ shown, page }: { shown: boolean; page: string }) {
  const pill = useHoverPill(page)
  if (!shown) return null
  const row = (name: string) => createElement("a", { key: name, "data-nav-row": "", "aria-current": page === name ? "page" : undefined }, name)
  return createElement("nav", { ref: pill.navRef, "data-pills": pill.on ? "on" : undefined },
    createElement("span", { className: "tv-pill" }),
    createElement("div", { className: "group" }, row("Dashboard"), row("Reports")))
}

async function setup() {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  const show = async (shown: boolean, page = "Dashboard") => act(async () => root.render(createElement(Sidebar, { shown, page })))
  return { container, show }
}

const hover = async (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })) })

describe("useHoverPill", () => {
  it("binds to the nav that is in the page, also when the sidebar leaves and comes back", async () => {
    const { container, show } = await setup()
    await show(false)
    expect(container.querySelector("nav")).toBeNull()
    await show(true)
    const first = container.querySelector("nav")!
    expect(first.getAttribute("data-pills")).toBe("on")
    await show(false)
    expect(observed.size).toBe(0)
    await show(true)
    const second = container.querySelector("nav")!
    expect(second).not.toBe(first)
    expect(second.getAttribute("data-pills")).toBe("on")
    expect(observed.has(second)).toBe(true)
    expect(observed.has(second.querySelector(".group")!)).toBe(true)
    expect([...observed].some((element) => element.classList.contains("tv-pill"))).toBe(false)
  })

  it("shows the pill on a hovered row and steps off the open page", async () => {
    const { container, show } = await setup()
    await show(true)
    const pill = container.querySelector<HTMLElement>(".tv-pill")!
    const [dashboard, reports] = [...container.querySelectorAll("a")]
    await hover(reports!)
    expect(pill.dataset.shown).toBe("true")
    await hover(dashboard!)
    expect(pill.dataset.shown).toBe("false")
    await hover(reports!)
    expect(pill.dataset.shown).toBe("true")
    // Clicking Reports makes it the open page: the pill steps aside for its own fill.
    await show(true, "Reports")
    expect(pill.dataset.shown).toBe("false")
  })
})
