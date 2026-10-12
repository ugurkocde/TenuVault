import { afterEach, describe, expect, it, vi } from "vitest"
import { CommunityLimitError } from "../src/shared/plan-errors"
import { FeatureApiError, featureCall } from "../src/renderer/lib/feature-api"
import { closePlanDialog, planDialogError, showCommunityLimitError, showFeaturePlanError, subscribePlanDialog } from "../src/renderer/lib/plan-dialog"
import { queryClient } from "../src/portal/lib/query-client"
import type { Tenant } from "../src/portal/contexts/TenantContext"

afterEach(() => {
  closePlanDialog()
  queryClient.clear()
  vi.unstubAllGlobals()
})

describe("feature plan dialogs", () => {
  it("opens for a 402 feature error and retains the original message", () => {
    const listener = vi.fn()
    const unsubscribe = subscribePlanDialog(listener)
    const error = new FeatureApiError("The selected action is included in TenuVault Pro and MSP.", 402, "fullRestore")
    expect(showFeaturePlanError(error)).toBe(true)
    expect(planDialogError()).toBe(error)
    expect(listener).toHaveBeenCalledOnce()
    closePlanDialog()
    expect(planDialogError()).toBeNull()
    unsubscribe()
  })

  it.each([new Error("Request failed"), new FeatureApiError("No plan key", 402), new FeatureApiError("Request failed", 500, "fullRestore"), null])("ignores other errors", (error) => {
    expect(showFeaturePlanError(error)).toBe(false)
    expect(planDialogError()).toBeNull()
  })

  it("keeps an existing inline plan note as the explanation", () => {
    expect(showFeaturePlanError(new FeatureApiError("Daily schedule limit", 402, "dailySchedule"), ["dailySchedule"])).toBe(false)
    expect(planDialogError()).toBeNull()
  })

  it("preserves the feature key from an API response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Plan limit", upgrade: "baselineScores" }, { status: 402 })))
    const tenant = { credentials: { tenantId: "tenant" } } as Tenant
    const error = await featureCall("/api/scores", tenant, "summary").catch((failure: unknown) => failure)
    expect(error).toMatchObject({ status: 402, upgrade: "baselineScores", message: "Plan limit" })
    expect(showFeaturePlanError(error)).toBe(true)
  })

  it("opens through the shared query and mutation error paths", async () => {
    const error = new FeatureApiError("Plan limit", 402, "baselineScores")
    await expect(queryClient.fetchQuery({ queryKey: ["plan-test"], retry: false, queryFn: () => Promise.reject(error) })).rejects.toBe(error)
    expect(planDialogError()).toBe(error)
    closePlanDialog()
    const mutation = queryClient.getMutationCache().build(queryClient, { mutationFn: () => Promise.reject(error) })
    await expect(mutation.execute(undefined)).rejects.toBe(error)
    expect(planDialogError()).toBe(error)
  })
})

describe("Community tenant dialog", () => {
  it("opens from the stable code and retains the existing tenant ID", () => {
    const error = new CommunityLimitError("tenant-id", "A message whose wording may change.")
    expect(showCommunityLimitError(error)).toBe(true)
    expect(planDialogError()).toMatchObject({ code: "community_tenant_limit", tenantId: "tenant-id" })
  })

  it("does not classify the English message as a Community limit", () => {
    expect(showCommunityLimitError(new Error("Community covers one tenant"))).toBe(false)
    expect(planDialogError()).toBeNull()
  })
})
