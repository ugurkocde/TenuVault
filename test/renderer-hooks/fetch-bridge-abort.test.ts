import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/renderer/lib/disclaimer", () => ({
  // The disclaimer dialog stays open until the admin answers.
  requestAcknowledgement: vi.fn(() => new Promise<boolean>(() => {})),
}))

import { installFetchBridge } from "../../src/renderer/lib/fetch-bridge"
import type { ApiResponse, TenuVaultBridge } from "../../src/shared/ipc"

const originalFetch = window.fetch

afterEach(() => {
  window.fetch = originalFetch
})

function pendingBridge() {
  let resolveApi: ((response: ApiResponse) => void) | undefined
  const api = vi.fn(() => new Promise<ApiResponse>((resolve) => { resolveApi = resolve }))
  installFetchBridge({ api } as unknown as TenuVaultBridge)
  return { api, resolveApi: () => resolveApi?.({ status: 200, statusText: "OK", headers: {}, body: new Uint8Array() }) }
}

describe("renderer fetch bridge abort handling", () => {
  it("rejects an in-flight API fetch with AbortError when the caller aborts", async () => {
    const { api } = pendingBridge()
    const controller = new AbortController()
    const pending = window.fetch("/api/list-backup-contents", { method: "POST", body: "{}", signal: controller.signal })
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("does not call the bridge for an already aborted signal", async () => {
    const { api } = pendingBridge()
    const controller = new AbortController()
    controller.abort()
    await expect(window.fetch("/api/list-backup-contents", { method: "POST", body: "{}", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(api).not.toHaveBeenCalled()
  })

  it("rejects when aborted while the disclaimer acknowledgement is waiting", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ acknowledgement: { version: 1, tenantIds: ["11111111-1111-1111-1111-111111111111"] } }))
    const api = vi.fn(async (): Promise<ApiResponse> => ({ status: 428, statusText: "Acknowledgement Required", headers: {}, body }))
    installFetchBridge({ api } as unknown as TenuVaultBridge)
    const controller = new AbortController()
    const pending = window.fetch("/api/restore-backup", { method: "POST", body: "{}", signal: controller.signal })
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("still resolves an API fetch that is never aborted", async () => {
    const { api, resolveApi } = pendingBridge()
    const pending = window.fetch("/api/list-backups", { method: "POST", body: "{}" })
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    resolveApi()
    await expect(pending).resolves.toMatchObject({ status: 200 })
  })
})
