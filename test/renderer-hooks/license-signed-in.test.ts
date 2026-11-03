import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const licenseStatus = vi.hoisted(() => vi.fn(async () => ({ marker: "initial", tenants: [] })))
const accounts = vi.hoisted(() => vi.fn(async () => [] as { tenantId: string }[]))
const licenseChanged = vi.hoisted(() => ({ current: null as ((status: unknown) => void) | null }))

vi.mock("../../src/renderer/lib/bridge", () => ({
  bridge: {
    app: { info: async () => ({}) },
    auth: { accounts },
    license: {
      status: licenseStatus,
      onChanged: (callback: (status: unknown) => void) => {
        licenseChanged.current = callback
        return () => { licenseChanged.current = null }
      },
    },
  },
}))

import { LicenseProvider, useLicense } from "../../src/renderer/lib/license"

const roots: Root[] = []

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function renderProvider(): { current: ReadonlySet<string> | undefined } {
  const result: { current: ReadonlySet<string> | undefined } = { current: undefined }
  function Probe() {
    result.current = useLicense().signedInTenantIds
    return null
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")))
  roots.push(root)
  act(() => root.render(createElement(LicenseProvider, null, createElement(Probe))))
  return result
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe("LicenseProvider signed-in tenants", () => {
  it("is unknown until the account store is read, then lists its tenants in lowercase", async () => {
    accounts.mockResolvedValue([{ tenantId: "T-ONE" }])
    const result = renderProvider()
    expect(result.current).toBeUndefined()
    await flush()
    expect([...result.current!]).toEqual(["t-one"])
  })

  it("reads the account store again with every status main sends after a sign-in or sign-out", async () => {
    accounts.mockResolvedValue([])
    const result = renderProvider()
    await flush()
    expect([...result.current!]).toEqual([])
    accounts.mockResolvedValue([{ tenantId: "t-new" }])
    act(() => licenseChanged.current?.({ marker: "after sign-in", tenants: [] }))
    await flush()
    expect([...result.current!]).toEqual(["t-new"])
    expect(accounts).toHaveBeenCalledTimes(2)
  })

  it("counts no tenant as signed in when the account store cannot be read", async () => {
    accounts.mockRejectedValue(new Error("unavailable"))
    const result = renderProvider()
    await flush()
    expect(result.current?.size).toBe(0)
  })
})
