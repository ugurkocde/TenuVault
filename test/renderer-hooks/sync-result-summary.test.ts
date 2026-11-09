import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SyncTarget } from "../../src/renderer/features/sync/api"
import { SyncResult, type ResultTarget } from "../../src/renderer/features/sync/SyncResult"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

function target(tenantId: string, status: string, result: { status: string; objectId?: string | null }): SyncTarget {
  return {
    targetTenantId: tenantId, promotionId: `pr-${tenantId}`, error: null, rollbackChangeSet: null,
    promotion: { id: `pr-${tenantId}`, status: "in-review", items: [], sync: { runId: "run", backup: "none" } } as unknown as SyncTarget["promotion"],
    changeSet: {
      id: `cs-${tenantId}`, status, contentHash: "h", lastError: null, attempts: 1, backupChoice: "none",
      preChange: { capturedAt: "2026-11-09T00:00:00Z", backupFolder: null, captureId: "c", objects: [] },
      operations: [{ key: "op-1", folder: "ConfigurationPolicies", name: "Defender", action: "create", targetId: null, source: { tenantId: "a", objectId: "s", version: null, label: "Defender" } }],
      results: { "op-1": { objectId: null, message: null, readBack: null, attempts: 1, at: null, ...result } },
    } as unknown as SyncTarget["changeSet"],
  }
}

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
})

function render(entries: ResultTarget[], extra: Record<string, unknown> = {}): HTMLDivElement {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props = {
    source: { name: "Contoso Lab", domain: "contosolab.onmicrosoft.com" }, policyCount: 1, entries,
    errors: {}, notes: {}, platforms: {}, onRetry: () => {}, retrying: false, tenantOf: () => undefined, onChanged: () => {},
    ...extra,
  }
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(SyncResult, props)))))
  return container
}

describe("Sync result summary", () => {
  it("does not claim saved links when the only write could not be confirmed, but still counts it for rollback", () => {
    const container = render([
      { target: target(D, "failed", { status: "uncertain" }), name: "Contoso Japan", domain: "contoso.co.jp", phase: "failed", storage: false },
    ])
    const summary = container.querySelector('[aria-label="Summary"]')?.textContent ?? ""
    expect(summary).not.toContain("Links saved for the next sync")
    expect(summary).not.toContain("Rollback available")
    expect(container.textContent).toContain("Rollback needs backup storage in this tenant.")
    // A write that may have gone through is never reported as nothing synced in the status line.
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Synced to 0 of 1 tenant. 1 needs attention.")
  })

  it("shows saved links once a write is verified, and counts the unconfirmed target in the rollback chip", () => {
    const container = render([
      { target: target(B, "applied", { status: "verified", objectId: "new-b" }), name: "Contoso Germany", domain: "contoso.de", phase: "verified", storage: true },
      { target: target(D, "failed", { status: "uncertain" }), name: "Contoso Japan", domain: "contoso.co.jp", phase: "failed", storage: false },
    ])
    const summary = container.querySelector('[aria-label="Summary"]')?.textContent ?? ""
    expect(summary).toContain("Links saved for the next sync")
    expect(summary).toContain("Rollback available in 1 of 2 tenants")
  })
})

/** A target of three operations writing, at the stage its stored records show. */
function writing(tenantId: string, extra: Record<string, unknown>, results: Record<string, { status: string }>, backup: "new" | "none"): SyncTarget {
  const entry = target(tenantId, "applying", { status: "pending" })
  const changeSet = entry.changeSet as unknown as Record<string, unknown>
  changeSet.operations = ["op-1", "op-2", "op-3"].map((key, index) => ({ key, folder: "ConfigurationPolicies", name: `Policy ${index + 1}`, action: "create", targetId: null, source: { tenantId: "a", objectId: `s${index}`, version: null, label: "x" } }))
  changeSet.results = Object.fromEntries(Object.entries(results).map(([key, result]) => [key, { objectId: null, message: null, readBack: null, attempts: 1, at: null, ...result }]))
  Object.assign(changeSet, { preChange: null, backupChoice: backup, ...extra })
  ;(entry.promotion as unknown as { sync: unknown }).sync = { runId: "run", backup }
  return entry
}

describe("Sync result while writing", () => {
  const capture = { preChange: { capturedAt: "t", backupFolder: "b", captureId: "c", objects: [] } }
  const node = (container: HTMLElement, name: string) => [...container.querySelectorAll<HTMLElement>('[role="group"][aria-label]')].find((entry) => entry.getAttribute("aria-label")?.startsWith(`${name}:`))!

  it("labels each target's stage from its change set and target record, with the overall progress in the header", () => {
    const container = render([
      { target: writing(B, {}, {}, "new"), name: "Contoso Germany", domain: "contoso.de", phase: "writing", storage: true },
      { target: writing(D, {}, {}, "none"), name: "Contoso Japan", domain: "contoso.co.jp", phase: "writing", storage: true },
      { target: writing("c", capture, { "op-1": { status: "verified" }, "op-2": { status: "writing" } }, "new"), name: "Contoso France", domain: "contoso.fr", phase: "writing", storage: true },
      { target: writing("e", capture, { "op-1": { status: "verified" }, "op-2": { status: "verified" }, "op-3": { status: "writing" } }, "new"), name: "Contoso Brazil", domain: "contoso.com.br", phase: "writing", storage: true },
    ])
    expect(node(container, "Contoso Germany").getAttribute("aria-label")).toBe("Contoso Germany: Backing up")
    expect(node(container, "Contoso Japan").getAttribute("aria-label")).toBe("Contoso Japan: Saving current versions")
    expect(node(container, "Contoso France").getAttribute("aria-label")).toBe("Contoso France: Writing 2 of 3")
    expect(node(container, "Contoso Brazil").getAttribute("aria-label")).toBe("Contoso Brazil: Verifying")
    expect(node(container, "Contoso France").querySelector('[aria-label="Stages"] [aria-current="step"]')?.textContent).toBe("Write")
    expect(node(container, "Contoso Japan").querySelector('[aria-label="Stages"]')?.textContent).toBe("ApproveSaveWriteVerify")
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Syncing to 4 tenants0 of 4 finished")
    expect(Number(container.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow"))).toBeGreaterThan(0)
    // Writing targets are never faded; only a target left out is.
    for (const name of ["Contoso Germany", "Contoso Japan", "Contoso France", "Contoso Brazil"]) expect(node(container, name).className).not.toMatch(/opacity-/)
  })

  it("shows a run planned and never approved as a card with Continue to review and Discard", () => {
    const onContinue = vi.fn()
    const onDiscard = vi.fn()
    const planned = target(B, "in-review", { status: "pending" })
    Object.assign(planned.changeSet as object, { attempts: 0, preChange: null })
    const container = render([{ target: planned, name: "Contoso Germany", domain: "contoso.de", phase: "excluded", storage: true }], { onContinue, onDiscard, discard: { busy: false, error: null } })
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Planned, not approved yet")
    const buttons = [...container.querySelectorAll("button")]
    act(() => buttons.find((entry) => entry.textContent === "Continue to review")!.click())
    act(() => buttons.find((entry) => entry.textContent === "Discard")!.click())
    expect(onContinue).toHaveBeenCalledOnce()
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it("offers Continue to review when another target of the run was already in sync", () => {
    const planned = target(B, "in-review", { status: "pending" })
    Object.assign(planned.changeSet as object, { attempts: 0, preChange: null })
    const inSync = { targetTenantId: D, promotionId: null, error: null, skipped: [{ folder: "ConfigurationPolicies", sourceId: "s", sourceName: "Defender", reason: "already in sync" }], promotion: null, changeSet: null, rollbackChangeSet: null } as unknown as SyncTarget
    const container = render([
      { target: planned, name: "Contoso Germany", domain: "contoso.de", phase: "excluded", storage: true },
      { target: inSync, name: "Contoso Japan", domain: "contoso.co.jp", phase: "in-sync", storage: false },
    ], { onContinue: () => undefined, onDiscard: () => undefined, discard: { busy: false, error: null } })
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Planned, not approved yet")
    expect([...container.querySelectorAll("button")].map((entry) => entry.textContent)).toContain("Continue to review")
  })
})
