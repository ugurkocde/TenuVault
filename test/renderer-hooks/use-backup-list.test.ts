import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBackupLists, useBackupList, type BackupList } from "../../src/renderer/lib/backup-list"
import type { Tenant } from "../../src/portal/contexts/TenantContext"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type HookResult = BackupList & { refresh: (options?: { force?: boolean }) => Promise<void> }

function renderHook(run: () => HookResult): { result: { current: HookResult }; unmount: () => void } {
  const result = { current: undefined as unknown as HookResult }
  const container = document.createElement("div")
  document.body.appendChild(container)
  let root: Root
  function Probe() {
    result.current = run()
    return null
  }
  act(() => {
    root = createRoot(container)
    root.render(createElement(Probe))
  })
  return {
    result,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function tenantWith(tenantId: string): Tenant {
  return {
    credentials: { tenantId, appId: "app-id", clientSecret: "secret" },
    resources: { storageAccountName: "storageacct", subscriptionId: "sub-id", resourceGroupName: "rg-name" },
  } as unknown as Tenant
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("useBackupList", () => {
  beforeEach(() => {
    resetBackupLists()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("stays empty for a null tenant and never fetches", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const { result, unmount } = renderHook(() => useBackupList(null))
    await flush()
    expect(result.current.backups).toBeNull()
    expect(result.current.error).toBe("")
    expect(result.current.loading).toBe(false)
    await act(async () => {
      await result.current.refresh()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    unmount()
  })

  it("loads the tenant backups through the list endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ backups: [{ name: "backup-one" }, { name: "backup-two" }] }),
      })),
    )
    const { result, unmount } = renderHook(() => useBackupList(tenantWith("11111111-1111-1111-1111-111111111111")))
    await flush()
    expect(result.current.backups?.map((backup) => (backup as unknown as { name: string }).name)).toEqual(["backup-one", "backup-two"])
    expect(result.current.error).toBe("")
    expect(result.current.loading).toBe(false)
    unmount()
  })

  it("surfaces the endpoint error and keeps backups empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "Backups are unavailable for this tenant." }),
      })),
    )
    const { result, unmount } = renderHook(() => useBackupList(tenantWith("22222222-2222-2222-2222-222222222222")))
    await flush()
    expect(result.current.backups).toBeNull()
    expect(result.current.error).toBe("Backups are unavailable for this tenant.")
    expect(result.current.loading).toBe(false)
    unmount()
  })
})
