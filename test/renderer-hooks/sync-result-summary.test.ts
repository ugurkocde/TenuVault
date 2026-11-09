import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it } from "vitest"
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

function render(entries: ResultTarget[]): HTMLDivElement {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props = {
    source: { name: "Contoso Lab", domain: "contosolab.onmicrosoft.com" }, policyCount: 1, entries,
    errors: {}, notes: {}, platforms: {}, onRetry: () => {}, retrying: false, tenantOf: () => undefined, onChanged: () => {},
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
