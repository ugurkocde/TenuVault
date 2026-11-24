import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it.each(["../RELEASING.md", "../docs-site/src/content/docs/tenants.md"])("documents recovery for public-only tenants in %s", path => {
  const doc = readFileSync(new URL(path, import.meta.url), "utf8")
  const note = doc.split(/\n\s*\n/).find(paragraph => paragraph.includes("Before downgrading to 0.5.x"))?.replace(/\s+/g, " ") ?? ""
  expect(note).toContain("switch to your own app registration in 0.6")
  expect(note).toContain("return to 0.6")
  expect(note).toContain("deletes its backup schedule")
})
