import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("../../src/renderer/lib/toast", () => ({ toast: () => undefined }))
vi.mock("../../src/renderer/lib/plan-dialog", () => ({ showFeaturePlanError: () => false }))

import { ChangeSetFlow } from "../../src/renderer/features/shared/ChangeSetFlow"
import type { ChangeSet, ChangeSetActions } from "../../src/renderer/features/shared/change-set"

const changeSet = (status: string) => ({ id: "cs", title: "Promote Defender", status, kind: "change", contentHash: "h", ticket: null, sourceVersion: null, createdAt: "2026-11-09T10:00:00Z", operations: [], results: {}, review: null, preChange: null, lastError: null, history: [] }) as unknown as ChangeSet
const preview = { id: "cs", status: "in-review", contentHash: "h", targetFingerprint: "f", observedAt: "2026-11-09T10:00:00Z", operations: [], affectedObjects: [], blockers: [], irreversible: [], unsupportedRecovery: [], approval: { valid: false, reason: "Not approved yet." }, notice: "" }
const actions = { preview: async () => preview } as unknown as ChangeSetActions

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
})

async function render(props: Record<string, unknown>) {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(MemoryRouter, null, createElement(ChangeSetFlow, { actions, tenantName: "Contoso", onChanged: () => undefined, ...props } as never))))
  const click = async (text: string) => {
    const target = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text))!
    await act(async () => { target.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  return { container, click }
}

describe("ChangeSetFlow decision fields and apply wording", () => {
  it("keeps the reviewer and decision note by default, as Dev to Prod uses it", async () => {
    const { container, click } = await render({ changeSet: changeSet("in-review") })
    await click("Review against the live tenant")
    expect(container.textContent).toContain("Reviewer")
    expect(container.textContent).toContain("Decision note")
  })

  it("leaves both out with decisionFields false", async () => {
    const { container, click } = await render({ changeSet: changeSet("in-review"), decisionFields: false })
    await click("Review against the live tenant")
    expect(container.textContent).not.toMatch(/Reviewer|Decision note/)
    expect(container.textContent).toContain("Approve this content and target state")
  })

  it("words the apply from the stored backup choice", async () => {
    const skipped = await render({ changeSet: changeSet("approved"), backupSkipped: true })
    await skipped.click("Apply to tenant")
    expect([...document.body.querySelectorAll("button")].map((entry) => entry.textContent)).toContain("Apply without a backup")
    act(() => roots.pop()!.unmount())
    document.body.replaceChildren()
    const backedUp = await render({ changeSet: changeSet("approved") })
    await backedUp.click("Apply to tenant")
    expect([...document.body.querySelectorAll("button")].map((entry) => entry.textContent)).toContain("Back up and apply")
  })
})

describe("ChangeSetFlow after approve and apply", () => {
  const operation = { key: "op-1", folder: "ConfigurationPolicies", name: "Defender", action: "update", targetId: "t", source: null, diff: [{ path: "settings", change: "changed" }], diffTruncated: false, setsAssignments: false }
  const withOperation = (status: string) => ({ ...changeSet(status), operations: [operation] }) as unknown as ChangeSet
  const live = (valid: boolean) => ({ ...preview, operations: [{ key: "op-1", diff: [{ path: "description", change: "added" }], diffTruncated: false, blockers: [], warnings: [] }], approval: { valid, reason: valid ? null : "Not approved." } })

  it("reads the review again after approving, so it no longer says Not approved (Dev to Prod, with decision fields)", async () => {
    let approved = false
    const calls: string[] = []
    const promotion = {
      preview: async () => { calls.push("preview"); return live(approved) },
      approve: async () => { calls.push("approve"); approved = true; return {} },
      reject: async () => ({}),
    } as unknown as ChangeSetActions
    const { container, click } = await render({ changeSet: withOperation("in-review"), actions: promotion })
    await click("Review against the live tenant")
    expect(container.textContent).toContain("Stored approval: Not approved.")
    await click("Approve this content and target state")
    expect(calls).toEqual(["preview", "approve", "preview"])
    expect(container.textContent).toContain("Stored approval: valid for this content and target state.")
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent?.includes("Approve this content and target state"))).toBe(false)
  })

  it("drops the review read before an apply, so the live difference is not shown under the written result", async () => {
    const actions = { preview: async () => live(true), apply: async () => ({}) } as unknown as ChangeSetActions
    const { container, click } = await render({ changeSet: withOperation("approved"), actions })
    await click("Apply to tenant")
    const dialog = document.body.querySelector('[role="dialog"]')!
    // The dialog is labelled by its title and says what the backup covers.
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Apply this change set")
    expect(dialog.textContent).toContain("A backup with this tenant's backup settings runs first and must hold every policy type this change writes.")
    expect(dialog.textContent).not.toContain("A full backup runs first")
    await click("Defender")
    expect(container.textContent).toContain("Difference against the live tenant now:")
    await act(async () => { dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    await click("Back up and apply")
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).not.toContain("Difference against the live tenant now:")
    expect(container.textContent).toContain("Difference recorded when the change set was created:")
  })
})
