import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The renderer and service tests mock the bridge, so nothing else notices when the
// channel name drifts between the preload script and the main process. The page call
// would then reject, be swallowed by design, and silently stop refreshing on open.
describe("license refresh wiring", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

  it("registers the channel the preload bridge invokes, backed by refreshAll", () => {
    const preload = read("../src/preload/index.ts")
    const main = read("../src/main/index.ts")
    const invoked = preload.match(/refresh: \(\) => invoke\("([^"]+)"\)/)?.[1]
    expect(invoked).toBe("license:refresh")
    expect(main).toContain(`handleTrusted("${invoked}", () => withStatus(() => license.refreshAll()))`)
  })

  it("declares the method on the shared bridge type", () => {
    expect(read("../src/shared/ipc.ts")).toContain("refresh: () => Promise<LicenseStatus>")
  })
})
