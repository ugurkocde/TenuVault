import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const appInfo = vi.hoisted(() => vi.fn())
const licenseStatus = vi.hoisted(() => vi.fn(async () => ({ marker: "initial" })))
const licenseChanged = vi.hoisted(() => ({ current: null as ((status: unknown) => void) | null }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { info: appInfo },
    license: {
      status: licenseStatus,
      onChanged: (callback: (status: unknown) => void) => {
        licenseChanged.current = callback
        return () => { licenseChanged.current = null }
      },
    },
  },
}))

import { refreshInternalCisBenchmarks, resetInternalCisBenchmarks, useInternalCisBenchmarks } from "../../src/renderer/lib/internal-cis"
import { LicenseProvider, useLicense } from "../../src/renderer/lib/license"

const roots: Root[] = []
const containers: HTMLDivElement[] = []

function renderHook(): { result: { current: boolean; licenseStatus: unknown }; unmount: () => void } {
  const result: { current: boolean; licenseStatus: unknown } = { current: false, licenseStatus: null }
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  let root: Root
  function Probe() {
    result.current = useInternalCisBenchmarks()
    result.licenseStatus = useLicense().status
    return null
  }
  act(() => {
    root = createRoot(container)
    roots.push(root)
    root.render(createElement(LicenseProvider, null, createElement(Probe)))
  })
  return { result, unmount: () => act(() => root.unmount()) }
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

beforeEach(() => {
  resetInternalCisBenchmarks()
  licenseChanged.current = null
  appInfo.mockReset()
  licenseStatus.mockClear()
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  resetInternalCisBenchmarks()
})

describe("useInternalCisBenchmarks", () => {
  it("enables and disables without remounting when the license changes", async () => {
    let internal = false
    appInfo.mockImplementation(async () => ({ version: "0", platform: "darwin", trayIconLoaded: false, internalCisBenchmarks: internal }))
    const hook = renderHook()
    await flush()
    expect(hook.result.current).toBe(false)

    internal = true
    await act(async () => { licenseChanged.current?.({ marker: "granted" }); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(hook.result.current).toBe(true)
    expect(hook.result.licenseStatus).toEqual({ marker: "granted" })

    internal = false
    await act(async () => { licenseChanged.current?.({ marker: "revoked" }); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(hook.result.licenseStatus).toEqual({ marker: "revoked" })
    expect(hook.result.current).toBe(false)
    hook.unmount()
  })

  it("returns fresh authorization for local actions and fails closed on errors", async () => {
    appInfo.mockResolvedValue({ version: "0", platform: "darwin", trayIconLoaded: false, internalCisBenchmarks: true })
    const hook = renderHook()
    await flush()
    expect(hook.result.current).toBe(true)

    appInfo.mockResolvedValue({ version: "0", platform: "darwin", trayIconLoaded: false, internalCisBenchmarks: false })
    let fresh = true
    await act(async () => { fresh = await refreshInternalCisBenchmarks() })
    expect(fresh).toBe(false)
    await flush()
    expect(hook.result.current).toBe(false)

    appInfo.mockRejectedValue(new Error("bridge unavailable"))
    await act(async () => { fresh = await refreshInternalCisBenchmarks() })
    expect(fresh).toBe(false)
    hook.unmount()
  })

  it("does not let a superseded revocation response fail open", async () => {
    appInfo.mockResolvedValue({ version: "0", platform: "darwin", trayIconLoaded: false, internalCisBenchmarks: true })
    await expect(refreshInternalCisBenchmarks()).resolves.toBe(true)

    const releases: Array<(value: unknown) => void> = []
    appInfo.mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    const first = refreshInternalCisBenchmarks()
    const second = refreshInternalCisBenchmarks()
    releases[0]!({ version: "0", platform: "darwin", trayIconLoaded: false, internalCisBenchmarks: false })
    await expect(first).resolves.toBe(false)
    releases[1]!({ version: "0", platform: "darwin", trayIconLoaded: false, internalCisBenchmarks: false })
    await expect(second).resolves.toBe(false)
  })

  it("does not let an older successful response replace a newer revocation", async () => {
    let releaseFirst!: (value: unknown) => void
    const first = new Promise((resolve) => { releaseFirst = resolve })
    appInfo
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ version: "0", platform: "darwin", trayIconLoaded: false, internalCisBenchmarks: false })

    const stale = refreshInternalCisBenchmarks()
    await expect(refreshInternalCisBenchmarks()).resolves.toBe(false)
    releaseFirst({ version: "0", platform: "darwin", trayIconLoaded: false, internalCisBenchmarks: true })
    await expect(stale).resolves.toBe(false)
  })
})
