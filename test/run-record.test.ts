import { describe, expect, it } from "vitest"
import { withRunRecord } from "../src/shared/backup-companion"

const id = "backup-2026-11-21-000000"
const early = { BackupFolder: id, TenantId: "tenant", RunId: "run", AuthMode: "delegated", CompanionBackup: "backup-large-2026-11-21-000000", CompletedAt: "2026-11-21T00:05:00.000Z", DurationSeconds: 300 }
const record = { BackupFolder: id, TenantId: "TENANT", RunId: "run", AuthMode: "delegated", RunStatus: "Success" }

describe("withRunRecord", () => {
  it("merges a matching record's final timing and ignores timing of the wrong type", () => {
    expect(withRunRecord(id, early, { ...record, CompletedAt: "2026-11-21T00:45:00.000Z", DurationSeconds: 2700 })).toMatchObject({ RunStatus: "Success", CompletedAt: "2026-11-21T00:45:00.000Z", DurationSeconds: 2700 })
    expect(withRunRecord(id, early, { ...record, CompletedAt: 5, DurationSeconds: "long" })).toMatchObject({ RunStatus: "Success", CompletedAt: "2026-11-21T00:05:00.000Z", DurationSeconds: 300 })
  })

  it.each([["folder", { BackupFolder: "backup-2026-11-20-000000" }], ["run", { RunId: "other" }], ["tenant", { TenantId: "other" }], ["sign-in mode", { AuthMode: "app-only" }], ["status", { RunStatus: undefined }]])("leaves the early manifest when the record's %s differs", (_case, change) => {
    expect(withRunRecord(id, early, { ...record, ...change })).toBe(early)
  })

  it("never replaces a manifest that already names the run status", () => {
    const final = { ...early, RunStatus: "CompletedWithWarnings" }
    expect(withRunRecord(id, final, record)).toBe(final)
  })
})
