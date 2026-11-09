import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { readFileSync } from "node:fs"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const P1 = "11111111-1111-4111-8111-111111111111"
const HASH = "a".repeat(64)
const FINGERPRINT = "b".repeat(64)

const tenant = (id: number, tenantId: string, name: string, domain: string, storage: boolean) => ({ id, name, domain, credentials: { tenantId, appId: "app" }, ...(storage ? { resources: { storageAccountName: `tvlocal-${id}` } } : {}) })
const TENANTS = [tenant(1, A, "Contoso Lab", "contosolab.onmicrosoft.com", true), tenant(2, B, "Contoso Germany", "contoso.de", true), tenant(3, C, "Contoso France", "contoso.fr", true), tenant(4, D, "Contoso Japan", "contoso.co.jp", false)]

const plan = vi.hoisted(() => ({ current: "msp" as "community" | "pro" | "msp" }))
const opened = vi.hoisted(() => [] as unknown[])
vi.mock("~/contexts/TenantContext", () => ({
  useTenants: () => TENANTS,
  useSelectedTenant: () => ({ selectedTenant: TENANTS[0], selectedTenantId: 1, setSelectedTenantId: () => undefined }),
}))
vi.mock("../../src/renderer/lib/license", async (original) => ({
  ...(await original<typeof import("../../src/renderer/lib/license")>()),
  useLicense: () => ({ status: { plan: plan.current, tenants: [] }, signedInTenantIds: new Set(), error: null, refresh: async () => undefined }),
  useTenantPlan: () => plan.current,
}))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { license: { open: async (...args: unknown[]) => { opened.push(args) } }, app: { info: async () => ({}) } } }))
vi.mock("../../src/renderer/lib/plan-dialog", () => ({ showFeaturePlanError: () => false }))

import SyncPage from "../../src/renderer/pages/SyncPage"

// ---------------------------------------------------------------------------------------------
// An in-memory /api/sync with the shapes the route answers with.

interface Scenario {
  targets: Array<{ tenantId: string; eligible: boolean; multiple: boolean; reason: string | null }>
  /** Per target: the item action, and findings by acknowledgement. */
  items: Record<string, { action: "create" | "update"; same?: boolean; inSync?: boolean; findings?: (acknowledged: boolean) => Array<{ code: string; severity: string; message: string }>; warnings?: string[] }>
  /** Targets whose first apply fails after writing nothing. */
  failFirstApply: string[]
  /** Targets whose approval is refused; their change set stays in review. */
  failApprove?: string[]
  /** Targets whose first apply fails at the backup, before anything is captured or written. */
  failBackup?: string[]
  /** Targets whose status read fails, with the message the route answers with. */
  statusError?: Record<string, string>
  /** Targets whose first apply is refused before it claims the change set (a tenant write conflict). */
  conflictApply?: string[]
  /** Holds the first apply of a target until the test releases it. */
  hold?: { tenantId: string; released: Promise<void> }
}

let scenario: Scenario
let calls: Array<{ tenantId: string; action: string; body: Record<string, unknown> }>
let runs: Map<string, { run: Record<string, unknown>; targets: Array<Record<string, unknown>> }>
let failed: Set<string>

const changeSetOf = (target: string, action: "create" | "update", status: string) => ({
  id: `cs-${target}`, status, kind: "change", title: "Sync", origin: { workflow: "sync", recordId: `pr-${target}` }, targetTenantId: target, sourceTenantId: A, sourceVersion: null, ticket: null,
  operations: [{ key: "op-1", folder: "ConfigurationPolicies", action, targetId: action === "update" ? "linked-1" : null, name: "Windows Defender Antivirus", source: { tenantId: A, objectId: P1, version: null, label: "Windows Defender Antivirus" }, proposedHash: HASH, setsAssignments: false, assignmentsHash: null, diff: [], diffTruncated: false }],
  dependencies: [], proposalId: "p", contentHash: HASH, review: null, preChange: null, results: {}, rollbackOf: null, attempts: 0, lastError: null, createdAt: "2026-11-09T10:00:00Z", updatedAt: "2026-11-09T10:00:00Z", history: [],
})

function server(tenantId: string, action: string, body: Record<string, unknown>): { status: number; body: unknown } {
  calls.push({ tenantId, action, body })
  const findTarget = () => [...runs.values()].flatMap((entry) => entry.targets).find((target) => target.targetTenantId === tenantId && target.promotionId === body.id)!
  switch (action) {
    case "policies": return { status: 200, body: { source: body.folder === "ConfigurationPolicies" ? [{ id: P1, name: "Windows Defender Antivirus", folder: "ConfigurationPolicies", platforms: "windows10", lastModifiedDateTime: null }] : [] } }
    case "targets": return { status: 200, body: { multiple: plan.current === "msp", targets: scenario.targets } }
    case "status": return { status: 200, body: { targets: (body.targetTenants as Array<{ tenantId: string }>).map(({ tenantId: id }) => scenario.statusError?.[id] ? { targetTenantId: id, error: scenario.statusError[id], links: [] } : ({ targetTenantId: id, error: null, links: id === B ? [{ folder: "ConfigurationPolicies", sourceId: P1, sourceName: "Windows Defender Antivirus", targetPolicyId: "linked-1", targetName: "Windows Defender Antivirus", linkedAt: "2026-11-01T00:00:00Z", state: "in-sync", changedIn: null, identical: true, error: null }] : [] })) } }
    case "list-runs": return { status: 200, body: { runs: [...runs.values()].reverse().map((entry) => ({ ...entry.run, applied: entry.targets.some((target) => ((target.changeSet as { attempts?: number } | null)?.attempts ?? 0) > 0) })) } }
    case "plan": {
      const id = `${runs.size + 1}`.padStart(8, "0") + "-0000-4000-8000-000000000000"
      const acknowledged = body.acknowledgeRedacted === true
      // Promotion IDs are unique per run, as the engine's records are.
      const pr = (target: string) => (runs.size ? `pr${runs.size + 1}-${target}` : `pr-${target}`)
      const targets = (body.targetTenants as Array<{ tenantId: string }>).map(({ tenantId: target }) => {
        const item = scenario.items[target]!
        // The engine leaves a policy out of a target where it is already in sync; with nothing left, no promotion.
        if (item.inSync) return { targetTenantId: target, promotionId: null, error: null, skipped: [{ folder: "ConfigurationPolicies", sourceId: P1, sourceName: "Windows Defender Antivirus", reason: "already in sync" }], promotion: null, changeSet: null, rollbackChangeSet: null }
        const findings = item.findings?.(acknowledged) ?? []
        const blocked = findings.some((finding) => finding.severity === "blocking")
        return {
          targetTenantId: target, promotionId: pr(target), error: null,
          promotion: { id: pr(target), status: blocked ? "blocked" : "in-review", sourceTenantId: A, items: [{ folder: "ConfigurationPolicies", sourceId: P1, sourceName: "Windows Defender Antivirus", action: item.action, blocked, findings, destinationId: item.action === "update" ? "linked-1" : null }] },
          changeSet: blocked ? null : changeSetOf(target, item.action, "in-review"),
          rollbackChangeSet: null,
          skipped: [],
        }
      })
      const run = { id, title: body.title, status: "planned", summary: "Planned.", createdAt: "2026-11-09T10:00:00Z", updatedAt: "2026-11-09T10:00:00Z", sourceTenantId: A, ticket: null, options: { includeAssignments: body.includeAssignments, dropUnsupportedExclusions: false, acknowledgeRedacted: acknowledged }, items: body.items, targets: targets.map(({ targetTenantId, promotionId, error, skipped }) => ({ targetTenantId, promotionId, error, skipped })) }
      runs.set(id, { run, targets })
      return { status: 200, body: { run, targets } }
    }
    case "get-run": {
      const entry = runs.get(body.id as string)!
      return { status: 200, body: { run: entry.run, targets: entry.targets } }
    }
    case "preview": {
      const target = findTarget()
      const item = scenario.items[tenantId]!
      return { status: 200, body: { promotion: target.promotion, sourceChanges: [], changeSet: { id: `cs-${tenantId}`, status: "in-review", contentHash: HASH, targetFingerprint: FINGERPRINT, observedAt: "2026-11-09T10:01:00Z", operations: [{ key: "op-1", folder: "ConfigurationPolicies", action: item.action, name: "Windows Defender Antivirus", targetId: null, targetState: "present", fingerprint: FINGERPRINT, diff: item.same ? [] : [{ path: "settings", change: "changed" }], diffTruncated: false, blockers: [], warnings: item.warnings ?? [], irreversible: [], result: { status: "pending" } }], affectedObjects: [], blockers: [], irreversible: [], unsupportedRecovery: [], approval: { valid: false, reason: null }, notice: "" } } }
    }
    case "approve": {
      const target = findTarget()
      if (scenario.failApprove?.includes(tenantId)) return { status: 409, body: { error: "The target changed since the review. Plan again." } }
      // As the route: a Sync approval names the backup choice, stored on the target record.
      if (body.backup !== "new" && body.backup !== "none") return { status: 400, body: { error: "Choose whether to back up before this sync: backup must be \"new\" or \"none\"." } }
      ;(target.promotion as Record<string, unknown>).sync = { runId: "r", backup: body.backup }
      ;(target.changeSet as Record<string, unknown>).status = "approved"
      return { status: 200, body: { promotion: target.promotion, changeSet: target.changeSet } }
    }
    case "apply":
    case "retry": {
      const target = findTarget()
      const changeSet = target.changeSet as Record<string, unknown>
      // As the route: the approved choice binds the apply; another one is refused before the claim.
      const approvedChoice = ((target.promotion as { sync?: { backup?: string } }).sync?.backup)
      if (approvedChoice && body.backup !== undefined && body.backup !== approvedChoice) return { status: 409, body: { error: `This sync was approved ${approvedChoice === "none" ? "without a backup" : "with a backup"}. Apply it with the same choice.` } }
      if (scenario.conflictApply?.includes(tenantId) && !failed.has(tenantId)) {
        failed.add(tenantId)
        Object.assign(changeSet, { lastError: "Another change to this tenant is running. Try again when it finishes." })
        return { status: 409, body: { error: "Another change to this tenant is running. Try again when it finishes." } }
      }
      // As the engine: the first claimed apply fixes the backup choice; another one is refused.
      const stored = (changeSet.backupChoice as string | undefined) ?? approvedChoice
      if (stored && body.backup !== undefined && body.backup !== stored) return { status: 409, body: { error: `This sync was first applied ${stored === "none" ? "without a backup" : "with a backup"}. Retry it with the same choice.` } }
      const choice = stored ?? (body.backup as string | undefined) ?? "new"
      Object.assign(changeSet, { backupChoice: choice, attempts: (changeSet.attempts as number) + 1 })
      if (scenario.failBackup?.includes(tenantId) && !failed.has(tenantId)) {
        failed.add(tenantId)
        Object.assign(changeSet, { status: "approved", lastError: "The pre-change backup could not start, so nothing was written." })
        return { status: 502, body: { error: "The pre-change backup could not start, so nothing was written." } }
      }
      changeSet.preChange = { capturedAt: "2026-11-09T10:02:00Z", backupFolder: choice === "none" ? null : "backup-1", captureId: "c", objects: [] }
      if (scenario.failFirstApply.includes(tenantId) && !failed.has(tenantId)) {
        failed.add(tenantId)
        Object.assign(changeSet, { status: "failed", lastError: "Intune answered 403: the account cannot create this policy type.", results: { "op-1": { status: "failed", objectId: null, message: "Intune answered 403: the account cannot create this policy type.", readBack: null, attempts: 1, at: "2026-11-09T10:03:00Z" } } })
        return { status: 502, body: { error: "Intune answered 403: the account cannot create this policy type." } }
      }
      Object.assign(changeSet, { status: "applied", lastError: null, results: { "op-1": { status: "verified", objectId: `new-${tenantId.slice(0, 4)}`, message: null, readBack: "match", attempts: 1, at: "2026-11-09T10:03:00Z" } } })
      return { status: 200, body: { promotion: target.promotion, changeSet } }
    }
    default: return { status: 400, body: { error: "Unknown action" } }
  }
}

beforeEach(() => {
  plan.current = "msp"
  opened.length = 0
  calls = []
  runs = new Map()
  failed = new Set()
  scenario = {
    targets: [B, C, D].map((tenantId) => ({ tenantId, eligible: true, multiple: true, reason: null })),
    items: {
      [B]: { action: "update", same: true },
      [C]: { action: "create", findings: () => [{ code: "sync-link-missing", severity: "warning", message: "\"Windows Defender Antivirus\", which an earlier Sync wrote, no longer exists in this tenant. This Sync creates a new policy." }], warnings: ["1 object(s) named \"Windows Defender Antivirus\" already exist; this creates another one."] },
      [D]: { action: "create" },
    },
    failFirstApply: [],
  }
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: { body: string }) => {
    expect(path).toBe("/api/sync")
    const { tenantId, action, ...body } = JSON.parse(init.body) as Record<string, unknown>
    const hold = scenario.hold
    if (hold && action === "apply" && tenantId === hold.tenantId) {
      scenario.hold = undefined
      await hold.released
    }
    const answer = server(tenantId as string, action as string, body)
    // A response is fresh JSON, never the server's own objects.
    return { ok: answer.status < 400, status: answer.status, json: async () => JSON.parse(JSON.stringify(answer.body)) as unknown }
  }))
})

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function render(): Promise<HTMLDivElement> {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  roots.push(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: ["/portal/sync"] }, createElement(SyncPage)))))
  await settle()
  return container
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (check()) return
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

const button = (container: HTMLElement, text: string | RegExp) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => (typeof text === "string" ? entry.textContent?.trim() === text : text.test(entry.textContent ?? "")))
const card = (container: HTMLElement, name: string) => [...container.querySelectorAll<HTMLButtonElement>('section[aria-label="Choose targets"] button[aria-pressed]')].find((entry) => entry.textContent?.includes(name))!
const node = (container: HTMLElement, name: string) => [...container.querySelectorAll<HTMLElement>('section[aria-label="Sync result"] [aria-label]')].find((entry) => entry.getAttribute("aria-label")?.startsWith(`${name}:`))!

async function click(element: HTMLElement | undefined) {
  expect(element).toBeDefined()
  act(() => element!.click())
  await settle()
}

/** Steps 1 and 2: the Defender policy, then the named targets. */
async function toReview(container: HTMLElement, names: string[]) {
  await until(() => !!container.querySelector('input[type="checkbox"]'), "policies")
  await click(container.querySelector<HTMLInputElement>('section[aria-label="Choose settings"] input[type="checkbox"]')!)
  await click(button(container, "Sync 1 policy"))
  await until(() => !!container.querySelector('section[aria-label="Choose targets"] button[aria-pressed]'), "target cards")
  for (const name of names) await click(card(container, name))
  await click(button(container, /^Review \d tenants?$/))
  await until(() => !!button(container, /^(Approve and sync|Continue: nothing to write)/) && !container.textContent?.includes("Checking"), "review")
}

describe("Sync page plans", () => {
  it("B2: shows Community only the locked preview", async () => {
    plan.current = "community"
    const container = await render()
    expect(container.querySelector('section[aria-label="Sync preview"]')).not.toBeNull()
    expect(container.textContent).toContain("Pro syncs between the two tenants of your license. Syncing to more tenants is part of MSP.")
    expect(container.querySelector('ol[aria-label="Steps"]')).toBeNull()
    expect(container.querySelector('section[aria-label="Recent syncs"]')).toBeNull()
    expect(container.querySelector('section[aria-label="Choose settings"]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("B3: on Pro only the tenant sharing the license can be chosen; the others show MSP and the neutral notice", async () => {
    plan.current = "pro"
    scenario.targets = [{ tenantId: B, eligible: true, multiple: false, reason: null }, { tenantId: C, eligible: false, multiple: false, reason: "msp" }, { tenantId: D, eligible: false, multiple: false, reason: "msp" }]
    const container = await render()
    await until(() => !!container.querySelector('section[aria-label="Choose settings"] input[type="checkbox"]'), "policies")
    await click(container.querySelector<HTMLInputElement>('section[aria-label="Choose settings"] input[type="checkbox"]')!)
    await click(button(container, "Sync 1 policy"))
    await until(() => !!container.querySelector('section[aria-label="Choose targets"] button[aria-pressed]'), "target cards")
    expect(card(container, "Contoso Germany").textContent).toContain("On your Pro license")
    expect(card(container, "Contoso Germany").textContent).toContain("1 policy linked")
    for (const name of ["Contoso France", "Contoso Japan"]) {
      expect(card(container, name).textContent).toContain("MSP")
      expect(card(container, name).getAttribute("aria-disabled")).toBe("true")
      await click(card(container, name))
      expect(card(container, name).getAttribute("aria-pressed")).toBe("false")
    }
    await click(card(container, "Contoso Germany"))
    expect(card(container, "Contoso Germany").getAttribute("aria-pressed")).toBe("true")
    expect(container.textContent).toContain("Pro syncs between the two tenants of your license. Syncing to more tenants is part of MSP.")
    expect(container.textContent).not.toMatch(/upsell|upgrade now|unlock/i)
    await click(button(container, "See plans"))
    expect(opened).toEqual([["buy", { source: "sync-targets" }]])
    expect(button(container, "Review 1 tenant")?.disabled).toBe(false)
  })
})

describe("Sync review", () => {
  it("B1 status chip and B4: per-target rows and warnings, no reviewer or note, OIB backup wording", async () => {
    const container = await render()
    await until(() => container.textContent?.includes("In sync with Contoso Germany") === true, "status chip")
    await toReview(container, ["Contoso Germany", "Contoso France"])
    const plans = calls.filter((call) => call.action === "plan")
    expect(plans).toHaveLength(1)
    expect(plans[0]!.body).toMatchObject({ targetTenants: [{ tenantId: B }, { tenantId: C }], includeAssignments: false, acknowledgeRedacted: false, items: [{ folder: "ConfigurationPolicies", sourceId: P1 }] })
    const review = container.querySelector('section[aria-label="Review"]')!
    expect(review.textContent).toContain("No change")
    expect(review.textContent).toContain("It is written again unchanged.")
    expect(review.textContent).toContain("Create")
    expect(review.textContent).toContain("no longer exists in this tenant. This Sync creates a new policy.")
    expect(review.textContent).toContain("already exist; this creates another one.")
    expect(review.textContent).not.toMatch(/Reviewer|Decision note/)
    expect(review.querySelectorAll("input:not([type])")).toHaveLength(0)
    expect(review.querySelector("legend")?.textContent).toBe("Backup before changes")
    expect(review.textContent).toContain("Back up the affected policy types now")
    expect(review.textContent).toContain("Skip the backup")
    expect(review.querySelector<HTMLInputElement>('input[value="new"]')!.checked).toBe(true)
    expect(button(container, "Approve and sync to 2 tenants")?.disabled).toBe(false)
    // Nothing was approved or written by the review.
    expect(calls.map((call) => call.action)).not.toContain("approve")
  })

  it("B4: secrets gate Approve until acknowledged, which plans again with the acknowledgement", async () => {
    scenario.items[B] = { action: "create", findings: (acknowledged) => [{ code: "secret-values", severity: acknowledged ? "warning" : "blocking", message: "The source policy holds values Intune masks." }] }
    const container = await render()
    await toReview(container, ["Contoso Germany"])
    expect(container.textContent).toContain("Left out")
    const approve = () => button(container, /^Approve and sync/)!
    expect(approve().disabled).toBe(true)
    const ack = [...container.querySelectorAll<HTMLInputElement>('section[aria-label="Review"] input[type="checkbox"]')].find((input) => input.parentElement?.textContent?.includes("secrets in these policies are not synced"))!
    await click(ack)
    await until(() => calls.filter((call) => call.action === "plan").length === 2 && approve().textContent === "Approve and sync to 1 tenant" && !approve().disabled, "plan with acknowledgement")
    expect(calls.filter((call) => call.action === "plan")[1]!.body.acknowledgeRedacted).toBe(true)
    await click(ack)
    expect(approve().disabled).toBe(true)
  })

  it("shows a target already in sync as skipped, writes nothing there and shows it green in the result", async () => {
    scenario.items[B] = { action: "update", inSync: true }
    const container = await render()
    await toReview(container, ["Contoso Germany", "Contoso France"])
    const review = container.querySelector('section[aria-label="Review"]')!
    expect(review.textContent).toContain("Skip: already in sync")
    expect(review.textContent).toContain("Nothing is written.")
    expect(review.textContent).toContain("Already in sync")
    expect(calls.filter((call) => call.action === "preview").map((call) => call.tenantId)).toEqual([C])
    await click(button(container, "Approve and sync to 1 tenant"))
    await until(() => node(container, "Contoso France")?.className.includes("border-green-600") === true, "result")
    const germany = node(container, "Contoso Germany")
    expect(germany.getAttribute("aria-label")).toBe("Contoso Germany: Already in sync, nothing written. No backup taken.")
    expect(germany.className).toContain("border-green-600")
    expect(germany.querySelector("a")).toBeNull()
    for (const action of ["approve", "apply", "retry"]) expect(calls.filter((call) => call.action === action).map((call) => call.tenantId)).not.toContain(B)
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Synced to 2 tenants")
  })

  it("lets the admin finish when every target is already in sync, without writing", async () => {
    scenario.items[B] = { action: "update", inSync: true }
    const container = await render()
    await toReview(container, ["Contoso Germany"])
    await click(button(container, "Continue: nothing to write"))
    await until(() => !!node(container, "Contoso Germany"), "result")
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Already in sync. Nothing was written.")
    expect(calls.map((call) => call.action)).not.toContain("approve")
    expect(container.textContent).not.toContain("Backup taken in each tenant")
  })

  it("leaves out a target without backup storage unless the backup is skipped", async () => {
    const container = await render()
    await toReview(container, ["Contoso Germany", "Contoso Japan"])
    expect(container.textContent).toContain("This tenant has no backup storage, so no backup can be taken. It is left out unless you choose Skip the backup.")
    expect(button(container, /^Approve and sync/)!.textContent).toBe("Approve and sync to 1 tenant")
    await click(container.querySelector<HTMLInputElement>('section[aria-label="Review"] input[value="none"]')!)
    expect(button(container, /^Approve and sync/)!.textContent).toBe("Approve and sync to 2 tenants")
  })
})

describe("Sync apply and result", () => {
  it("B5 and B6: approves and applies each target on its own; a failed target offers Retry failed and never affects the other", async () => {
    scenario.failFirstApply = [C]
    const container = await render()
    await toReview(container, ["Contoso Germany", "Contoso France"])
    await click(button(container, "Approve and sync to 2 tenants"))
    await until(() => !!button(container, "Retry failed"), "result")
    const byTarget = (action: string) => calls.filter((call) => call.action === action).map((call) => ({ tenantId: call.tenantId, ...call.body }))
    expect(byTarget("approve")).toEqual([{ tenantId: B, id: `pr-${B}`, contentHash: HASH, targetFingerprint: FINGERPRINT, backup: "new" }, { tenantId: C, id: `pr-${C}`, contentHash: HASH, targetFingerprint: FINGERPRINT, backup: "new" }])
    expect(byTarget("apply")).toEqual([{ tenantId: B, id: `pr-${B}`, contentHash: HASH, confirm: true, backup: "new" }, { tenantId: C, id: `pr-${C}`, contentHash: HASH, confirm: true, backup: "new" }])
    for (const call of calls.filter((entry) => entry.action === "approve")) expect(call.body).not.toHaveProperty("reviewer")

    const germany = node(container, "Contoso Germany")
    expect(germany.getAttribute("aria-label")).toBe("Contoso Germany: 1 change verified. Backup taken first.")
    expect(germany.className).toContain("border-green-600")
    expect(button(germany, "Retry failed")).toBeUndefined()
    const intune = germany.querySelector<HTMLAnchorElement>("a")!
    expect(intune.textContent).toBe("Open Intune")
    expect(intune.href).toBe(`https://intune.microsoft.com/#@${B}/view/Microsoft_Intune_Workflows/PolicySummaryBlade/policyId/new-bbbb/isAssigned~/false/technology/mdm/templateId//platformName/windows10`)
    expect(intune.target).toBe("_blank")

    const france = node(container, "Contoso France")
    expect(france.className).toContain("border-red-500")
    expect(france.textContent).toContain("Nothing was synced.")
    expect(france.textContent).toContain("Intune answered 403")
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Synced to 1 of 2 tenants. 1 needs attention.")
    expect(container.textContent).toContain("Links saved for the next sync")
    expect(container.textContent).toContain("Backup taken in each tenant")
    expect(container.textContent).toContain("Recorded in the audit log")

    await click(button(france, "Retry failed"))
    await until(() => node(container, "Contoso France").className.includes("border-green-600"), "retried")
    // The change set's first apply stored the choice, so the retry names none and the route applies it.
    expect(byTarget("retry")).toEqual([{ tenantId: C, id: `pr-${C}`, contentHash: HASH, confirm: true }])
    expect(byTarget("apply")).toHaveLength(2)
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Synced to 2 tenants")
  })

  it("offers no retry for a target whose approval was refused, and applies the other", async () => {
    scenario.failApprove = [C]
    const container = await render()
    await toReview(container, ["Contoso Germany", "Contoso France"])
    await click(button(container, "Approve and sync to 2 tenants"))
    await until(() => node(container, "Contoso Germany")?.className.includes("border-green-600") === true && node(container, "Contoso France")?.className.includes("border-red-500") === true, "result")
    const france = node(container, "Contoso France")
    expect(france.textContent).toContain("Nothing was synced. Start a new sync to review it again.")
    expect(france.textContent).toContain("The target changed since the review. Plan again.")
    expect(button(france, "Retry failed")).toBeUndefined()
    expect(calls.filter((call) => call.action === "apply").map((call) => call.tenantId)).toEqual([B])
  })

  it("B6: applies with the skipped backup and says so on every target", async () => {
    const container = await render()
    await toReview(container, ["Contoso Germany"])
    await click(container.querySelector<HTMLInputElement>('section[aria-label="Review"] input[value="none"]')!)
    await click(button(container, "Approve and sync to 1 tenant"))
    await until(() => node(container, "Contoso Germany")?.className.includes("border-green-600") === true, "result")
    expect(calls.find((call) => call.action === "apply")!.body.backup).toBe("none")
    expect(node(container, "Contoso Germany").getAttribute("aria-label")).toBe("Contoso Germany: 1 change verified. No backup taken.")
    expect(container.textContent).toContain("Backup skipped")
  })

  it("opens a recent run in the result view from the stored records", async () => {
    const container = await render()
    await toReview(container, ["Contoso Germany"])
    await click(button(container, "Approve and sync to 1 tenant"))
    await until(() => node(container, "Contoso Germany")?.className.includes("border-green-600") === true, "result")
    await click(button(container, "Start a new sync"))
    await until(() => !!container.querySelector('section[aria-label="Recent syncs"] button'), "recent syncs")
    await click(container.querySelector<HTMLButtonElement>('section[aria-label="Recent syncs"] button')!)
    await until(() => node(container, "Contoso Germany")?.className.includes("border-green-600") === true, "reopened run")
  })
})

describe("Sync review round 1", () => {
  it("retries with the choice stored on the change set, never the backup choice of a newer draft", async () => {
    scenario.failBackup = [B]
    const container = await render()
    await toReview(container, ["Contoso Germany"])
    await click(button(container, "Approve and sync to 1 tenant"))
    await until(() => !!button(container, "Retry failed"), "failed backup")
    expect(node(container, "Contoso Germany").textContent).toContain("Retry backs up first.")
    // A newer draft chooses to skip the backup, then the first run is opened again.
    await click(button(container, "Start a new sync"))
    await toReview(container, ["Contoso Germany"])
    await click(container.querySelector<HTMLInputElement>('section[aria-label="Review"] input[value="none"]')!)
    const first = [...container.querySelectorAll<HTMLButtonElement>('section[aria-label="Recent syncs"] button')].at(-1)!
    await click(first)
    await until(() => !!button(container, "Retry failed"), "reopened run")
    await click(button(container, "Retry failed"))
    await until(() => node(container, "Contoso Germany")?.className.includes("border-green-600") === true, "retried")
    const retry = calls.find((call) => call.action === "retry")!
    expect(retry.body).not.toHaveProperty("backup")
    expect(node(container, "Contoso Germany").getAttribute("aria-label")).toBe("Contoso Germany: 1 change verified. Backup taken first.")
  })

  it("counts only backups that completed, from the stored pre-change evidence", async () => {
    scenario.failBackup = [C]
    const container = await render()
    await toReview(container, ["Contoso Germany", "Contoso France"])
    await click(button(container, "Approve and sync to 2 tenants"))
    await until(() => !!button(container, "Retry failed") && node(container, "Contoso Germany")?.className.includes("border-green-600") === true, "result")
    const summary = container.querySelector('[aria-label="Summary"]')!.textContent
    expect(summary).toContain("Backup taken in 1 of 2 tenants")
    expect(summary).not.toContain("Backup taken in each tenant")
    expect(node(container, "Contoso Germany").getAttribute("aria-label")).toBe("Contoso Germany: 1 change verified. Backup taken first.")
  })

  it("shows no backup chip when the only requested backup never completed", async () => {
    scenario.failBackup = [B]
    const container = await render()
    await toReview(container, ["Contoso Germany"])
    await click(button(container, "Approve and sync to 1 tenant"))
    await until(() => !!button(container, "Retry failed"), "result")
    expect(container.textContent).not.toMatch(/Backup taken in|Backup skipped/)
  })

  it("keeps a pending apply and its late error in its own run", async () => {
    let release!: () => void
    scenario.hold = { tenantId: B, released: new Promise<void>((resolve) => { release = resolve }) }
    scenario.failFirstApply = [B]
    const container = await render()
    await toReview(container, ["Contoso Germany"])
    await click(button(container, "Approve and sync to 1 tenant"))
    await until(() => node(container, "Contoso Germany")?.className.includes("border-coral-500") === true, "first run writing")
    await click(button(container, "Start a new sync"))
    await toReview(container, ["Contoso Germany"])
    // The pending apply of the first run does not hold up the second.
    expect(button(container, "Approve and sync to 1 tenant")!.disabled).toBe(false)
    scenario.failFirstApply = []
    await click(button(container, "Approve and sync to 1 tenant"))
    await until(() => node(container, "Contoso Germany")?.className.includes("border-green-600") === true, "second run verified while the first is pending")
    release()
    await until(() => calls.filter((call) => call.action === "apply").length === 2 && !container.querySelector('[role="status"] .motion-safe\\:animate-spin'), "first run settled")
    await settle()
    const germany = node(container, "Contoso Germany")
    expect(germany.className).toContain("border-green-600")
    expect(germany.textContent).not.toContain("Intune answered 403")
  })

  it("shows Unknown with the reason when a target's status could not be read", async () => {
    scenario.statusError = { [C]: "The target tenant could not be read: Sign in again." }
    const container = await render()
    await until(() => !!container.querySelector('section[aria-label="Choose settings"] label span[title]'), "status chip")
    const chip = container.querySelector<HTMLElement>('section[aria-label="Choose settings"] label span[title]')!
    expect(chip.textContent).toBe("Unknown")
    expect(chip.title).toContain("Contoso France: The target tenant could not be read: Sign in again.")
  })

  it("matches the source tenant whatever the casing of its stored ID", async () => {
    const credentials = TENANTS[0]!.credentials
    credentials.tenantId = A.toUpperCase()
    try {
      const container = await render()
      const select = container.querySelector<HTMLSelectElement>('section[aria-label="Choose settings"] select')!
      expect(select.selectedOptions[0]?.textContent).toContain("Contoso Lab")
      // The option of the source itself is selected, not the first option React falls back to.
      expect(select.value).toBe(A)
    } finally {
      credentials.tenantId = A
    }
  })

  it("lists every run and marks the runs never applied", async () => {
    const container = await render()
    await toReview(container, ["Contoso Germany"])
    await click(button(container, "Back"))
    await click(button(container, "Review 1 tenant"))
    await until(() => calls.filter((call) => call.action === "plan").length === 2 && !!button(container, /^Approve and sync/) && !container.textContent?.includes("Checking"), "second review")
    await until(() => container.querySelectorAll('section[aria-label="Recent syncs"] li').length > 0, "recent syncs")
    const rows = () => [...container.querySelectorAll('section[aria-label="Recent syncs"] li')]
    // The draft the second review replaced stays listed; both were never applied.
    await until(() => rows().length === 2, "both runs")
    expect(rows().map((row) => row.textContent?.includes("Not applied"))).toEqual([true, true])
    await click(button(container, "Approve and sync to 1 tenant"))
    await until(() => node(container, "Contoso Germany")?.className.includes("border-green-600") === true, "applied")
    await until(() => !rows()[0]!.textContent?.includes("Not applied"), "applied run")
    expect(rows()[1]!.textContent).toContain("Not applied")
  })
})

describe("Sync review round 3", () => {
  /** Approves without a backup, has the apply refused before it claims the change set, then opens the run again in a fresh page. */
  async function refusedThenReopened() {
    scenario.conflictApply = [B]
    let container = await render()
    await toReview(container, ["Contoso Germany"])
    await click(container.querySelector<HTMLInputElement>('section[aria-label="Review"] input[value="none"]')!)
    await click(button(container, "Approve and sync to 1 tenant"))
    await until(() => !!button(container, "Retry failed"), "refused apply")
    for (const root of roots.splice(0)) act(() => root.unmount())
    document.body.replaceChildren()
    container = await render()
    await until(() => !!container.querySelector('section[aria-label="Recent syncs"] button'), "recent syncs")
    await click(container.querySelector<HTMLButtonElement>('section[aria-label="Recent syncs"] button')!)
    await until(() => !!button(container, "Retry failed"), "reopened run")
    return container
  }

  it("retries with the choice approved, after a refused apply and a fresh page", async () => {
    const container = await refusedThenReopened()
    expect(node(container, "Contoso Germany").textContent).toContain("Retry applies without a backup")
    await click(button(container, "Retry failed"))
    await until(() => node(container, "Contoso Germany")?.className.includes("border-green-600") === true, "retried")
    expect(calls.find((call) => call.action === "retry")!.body).not.toHaveProperty("backup")
    expect(node(container, "Contoso Germany").getAttribute("aria-label")).toBe("Contoso Germany: 1 change verified. No backup taken.")
  })

  it("applies from Details with the choice approved", async () => {
    const container = await refusedThenReopened()
    await click(button(node(container, "Contoso Germany"), "Details"))
    expect(container.textContent).toContain("Backup choice of this sync: applied without a backup.")
    await click(button(container, "Apply to tenant"))
    await until(() => !!button(document.body, "Apply without a backup"), "confirmation")
    expect(document.body.textContent).toContain("No backup runs: the current state of every affected object is captured first")
    await click(document.body.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!)
    await click(button(document.body, "Apply without a backup"))
    await until(() => node(container, "Contoso Germany")?.className.includes("border-green-600") === true, "applied from details")
    const applies = calls.filter((call) => call.action === "apply")
    expect(applies.at(-1)!.body).not.toHaveProperty("backup")
    expect(node(container, "Contoso Germany").getAttribute("aria-label")).toBe("Contoso Germany: 1 change verified. No backup taken.")
  })
})

describe("Sync flowchart motion", () => {
  it("B6: turns every animation off under reduced motion, so only end states show", () => {
    const css = readFileSync("src/renderer/desktop.css", "utf8")
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"))
    expect(reduced).toContain(".sync-link, .sync-ring, .sync-pop, .sync-node { animation: none; transition: none; }")
    expect(reduced).toContain(".sync-pulse, .sync-ring { display: none; }")
    // A link without its draw animation is drawn in full: its resting dash offset is 0.
    expect(css).toContain(".sync-link { stroke-dasharray: 1; stroke-dashoffset: 0;")
  })
})
