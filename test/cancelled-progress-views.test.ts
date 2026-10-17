import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ jobs: [] as Array<Record<string, unknown>>, overrides: new Map<number, unknown>(), calls: 0 }))
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>()
  return {
    ...react,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    // Lets a test give one useState call of a render, by its order, another initial value.
    useState: (initial: unknown) => {
      const index = state.calls++
      return [state.overrides.has(index) ? state.overrides.get(index) : typeof initial === "function" ? (initial as () => unknown)() : initial, vi.fn()]
    },
  }
})
vi.mock("~/contexts/BackupProgressContext", () => ({ useBackupProgress: () => ({ activeJobs: state.jobs, addJob: vi.fn(), updateJob: vi.fn(), removeJob: vi.fn() }) }))
vi.mock("~/contexts/TenantContext", () => ({ useSelectedTenant: () => ({ setSelectedTenantId: vi.fn() }), useTenantOperations: () => ({ addTenant: vi.fn(), updateTenant: vi.fn() }) }))
vi.mock("~/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children)
  return { Dialog: pass, DialogContent: pass, DialogDescription: pass, DialogFooter: pass, DialogHeader: pass, DialogTitle: pass }
})
vi.mock("@desktop/lib/bridge", () => ({ bridge: {} }))
vi.mock("@desktop/lib/license", () => ({ useTenantPlan: () => null, useLicense: () => ({ status: null }), tenantLicense: () => null, tenantPlan: () => null }))
vi.mock("@desktop/components/FirstBackupNote", () => ({ FirstBackupNote: () => null }))
vi.mock("../src/renderer/components/StorageChooser", () => ({ StorageChooser: () => null }))
vi.mock("../src/renderer/components/TenantSignInForm", () => ({ SetupScriptCard: () => null, TenantSignInForm: () => null }))
vi.mock("@desktop/lib/feature-api", () => ({ FeatureApiError: class extends Error {} }))
vi.mock("@desktop/lib/plan-dialog", () => ({ showFeaturePlanError: vi.fn() }))
vi.mock("@desktop/components/UpgradeNote", () => ({ PlanBadge: () => null, UpgradeNote: () => null }))

import { BackupProgressModal } from "../src/portal/components/tenants/backup-progress-modal"
import { FloatingProgress } from "../src/portal/components/backup/floating-progress"
import { JobStateIcon } from "../src/renderer/pages/OnboardingPage"
import { RestoreWizard } from "../src/portal/components/backup/restore-wizard"

const ended = (status: "Cancelled" | "Failed") => ({
  jobId: "job-1", tenantName: "Contoso", tenantId: "tenant", status, progress: 100, progressMessage: status === "Cancelled" ? "Backup cancelled" : "Backup failed",
  exception: status === "Cancelled" ? "Backup cancelled by you. This run is never offered as a complete backup." : "Sign in again.", isComplete: true, isSuccessful: false,
  credentials: { tenantId: "tenant", appId: "app", clientSecret: "" }, resources: { subscriptionId: "local", resourceGroupName: "local", automationAccountName: "", storageAccountName: "tvlocal-tenant" },
})
const render = (node: ReturnType<typeof createElement>) => {
  state.calls = 0
  return renderToStaticMarkup(createElement(MemoryRouter, null, node))
}

beforeEach(() => {
  state.jobs = []
  state.overrides = new Map()
})

describe("a backup the user cancelled, in the progress views", () => {
  const modal = () => render(createElement(BackupProgressModal, { open: true, onOpenChange: () => undefined, tenantName: "Contoso", jobId: "job-1", credentials: null, resources: null }))

  it("shows a grey icon and a neutral cancel message in the Backup Progress dialog, and red only for a failure", () => {
    state.jobs = [ended("Cancelled")]
    const cancelled = modal()
    expect(cancelled).toContain("bg-gray-100 p-5 text-gray-500")
    expect(cancelled).toContain("Backup cancelled by you.")
    // Class tokens only: the shared button styles name aria-invalid:border-destructive for invalid fields.
    for (const red of ["bg-red-50", "text-destructive", "border-destructive", "text-red-700"]) expect(cancelled).not.toMatch(new RegExp(`(^|["\\s])${red}(["\\s/]|$)`))
    state.jobs = [ended("Failed")]
    const failed = modal()
    expect(failed).toContain("bg-red-50 p-5 text-red-600")
    expect(failed).toMatch(/(^|["\s])border-destructive\/50(["\s]|$)/)
  })

  it("shows a grey icon and, expanded, a neutral cancel message in the floating progress panel", () => {
    // Expanded: the panel's first useState holds the expanded job.
    state.overrides = new Map<number, unknown>([[0, "job-1"]])
    state.jobs = [ended("Cancelled")]
    const cancelled = render(createElement(FloatingProgress))
    expect(cancelled).toContain("Backup cancelled")
    expect(cancelled).toContain("h-5 w-5 text-gray-500")
    expect(cancelled).toMatch(/<div class="rounded-2xl p-3 bg-gray-100"><p class="text-xs text-gray-700">Backup cancelled by you\./)
    for (const red of ["bg-red-50", "text-destructive", "text-red-700"]) expect(cancelled).not.toContain(red)
    state.jobs = [ended("Failed")]
    const failed = render(createElement(FloatingProgress))
    expect(failed).toContain("text-destructive")
    expect(failed).toContain('<p class="text-xs text-red-700">Sign in again.</p>')
  })

  it("shows a grey icon on the first backup step of setup", () => {
    const icon = (status: string, isSuccessful = false, isComplete = true) => renderToStaticMarkup(createElement(JobStateIcon, { job: { status, isComplete, isSuccessful } }))
    expect(icon("Cancelled")).toContain("h-4 w-4 text-gray-500")
    expect(icon("Failed")).toContain("h-4 w-4 text-red-600")
    expect(icon("Completed", true)).toContain("text-green-600")
    expect(icon("Running", false, false)).toContain("animate-spin")
  })
})

describe("a backup the user cancelled, in the restore wizard", () => {
  const backup = (status: string) => ({ id: "backup-1", timestamp: "2026-10-16T02:00:00Z", type: "manual" as const, status, totalPolicies: 2, scope: null, size: 1, duration: 4, changes: null, comparedWith: null })
  const items = (status: string) => render(createElement(RestoreWizard, {
    tenant: { name: "Contoso", credentials: { tenantId: "tenant", appId: "app", clientSecret: "" }, storageAccountName: "tvlocal-tenant" },
    backups: [backup(status)], initialBackupId: "backup-1", community: false, canCopyToTenants: false, copyCandidates: [],
  }))

  it("names the cancellation in a grey note on the Items step, and still says items may be missing", () => {
    const cancelled = items("Cancelled")
    expect(cancelled).toContain("Choose what to restore")
    expect(cancelled).toMatch(/bg-gray-100[^"]*text-gray-800"><svg[\s\S]*?<\/svg>Cancelled: this backup was cancelled before it finished, so some items may be missing from it\.<\/p>/)
    expect(cancelled).not.toContain("bg-amber-50")
    expect(items("Failed")).toContain("This backup did not complete fully, so some items may be missing from it.")
  })
})
