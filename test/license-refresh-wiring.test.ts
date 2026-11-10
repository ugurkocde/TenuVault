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

  it("finishes backup failure handling and notification before the trial tally", () => {
    const finished = read("../src/main/index.ts").match(/onFinished: \(job, request\) => \{([\s\S]*?)\n    \},/)?.[1] ?? ""
    expect(finished.indexOf("failedAttempts.finished")).toBeGreaterThanOrEqual(0)
    expect(finished.indexOf("notifyBackupOutcome")).toBeGreaterThan(finished.indexOf("failedAttempts.finished"))
    expect(finished.indexOf("tallyBackup")).toBeGreaterThan(finished.indexOf("notifyBackupOutcome"))
    expect(finished).not.toMatch(/\breturn\b/)
  })
})
