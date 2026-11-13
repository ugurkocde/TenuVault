import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { SetupDiagnostics } from "../src/main/setup-diagnostics/service"
import { firstBackupEvent } from "../src/main/setup-diagnostics/hooks"
import { memoryStore } from "./helpers"

// Bootstrap is not unit tested; these checks keep the wiring in src/main/index.ts from drifting.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const main = read("../src/main/index.ts")

describe("setup diagnostics wiring", () => {
  it("records the first backup of every trigger, outside the manual-only notification", () => {
    const finished = main.match(/onFinished: \(job, request\) => \{([\s\S]*?)\n    \},/)?.[1] ?? ""
    expect(finished).toContain("diagnostics.record(firstBackupEvent(job))")
    const manualLine = finished.split("\n").find((line) => line.includes('=== "manual"')) ?? ""
    expect(manualLine).not.toContain("diagnostics")
  })

  it("a tray or scheduled backup job is recorded like a manual one", () => {
    const store = memoryStore()
    const diagnostics = new SetupDiagnostics({ store, freshInstall: true, policy: false, url: null, fetch: fetch, envelope: { appVersion: "0.5.3", os: "win32", channel: "stable" }, firstLaunch: () => ({ osVersion: "10.0", arch: "x64", managedInstall: true }) })
    diagnostics.consent("welcome")
    // The job a tray "Back up all" run finishes with; the engine reports it through the same onFinished.
    diagnostics.record(firstBackupEvent({ status: "Failed", progressMessage: "Backup failed", exception: "x", unreachable: true }))
    diagnostics.record(firstBackupEvent({ status: "Completed", progressMessage: "Backup completed", failures: 0 }))
    const queue = JSON.parse(store.get("setupDiagnostics.state")!).queue as Array<{ name: string; props?: object }>
    expect(queue.filter((event) => event.name === "first_backup").map((event) => event.props)).toEqual([{ result: "failed", errorClass: "network" }, { result: "ok" }])
    diagnostics.stop()
  })

  it("creates diagnostics before the backup engine and scheduler can finish a job", () => {
    expect(main.indexOf("new SetupDiagnostics(")).toBeGreaterThan(0)
    expect(main.indexOf("new SetupDiagnostics(")).toBeLessThan(main.indexOf("new BackupEngine("))
    expect(main.indexOf("new SetupDiagnostics(")).toBeLessThan(main.indexOf("scheduler.start()"))
  })

  it("treats a started-over app store as an existing install", () => {
    expect(main).toContain("onStartOver?.()")
    expect(main).toMatch(/APP_STATE_START_OVER_BUTTON, \(\) => \{ startedOver = true \}\)/)
    expect(main).toContain("const freshInstall = appStore.keys().length === 0 && !startedOver")
  })

  it("rechecks the 30 days when the computer wakes", () => {
    expect(main).toContain('powerMonitor.on("resume", () => diagnostics.checkExpiry())')
  })

  it("registers every channel the preload bridge invokes", () => {
    const preload = read("../src/preload/index.ts")
    for (const channel of ["diagnostics:status", "diagnostics:consent", "diagnostics:decline", "diagnostics:reminderShown", "diagnostics:record"]) {
      expect(preload).toContain(`"${channel}"`)
      expect(main).toContain(`handleTrusted("${channel}"`)
    }
  })
})
