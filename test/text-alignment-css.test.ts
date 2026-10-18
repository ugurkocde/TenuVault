import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..")

describe("touch target minimum height", () => {
  it("applies the 44px minimum only on coarse pointers, so desktop controls keep their declared heights", () => {
    const css = readFileSync(join(root, "src/portal/styles/globals.css"), "utf8")
    // Remove every coarse pointer media block (one level of nesting inside @layer base).
    const withoutCoarseBlocks = css.replace(/@media \(hover: none\) and \(pointer: coarse\) \{[^}]*(\{[^}]*\}[^}]*)*\}/g, "")
    expect(withoutCoarseBlocks).not.toMatch(/min-height:\s*44px/)
    expect(css).toMatch(/@media \(hover: none\) and \(pointer: coarse\) \{\s*button, a, input, select, textarea \{\s*min-height: 44px;/)
  })
})

describe("dialog header", () => {
  it("reserves room for the absolute close button so titles and descriptions never run under it", () => {
    const dialog = readFileSync(join(root, "src/portal/components/ui/dialog.tsx"), "utf8")
    const header = dialog.match(/const DialogHeader[\s\S]*?^\)/m)?.[0] ?? ""
    expect(header).toMatch(/"flex flex-col space-y-1\.5 pr-10/)
  })
})
