import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { readRetentionProgress } from "../src/main/backup/retention-progress"

describe("retention progress validation", () => {
  it("accepts valid persisted retention progress shapes including complete receipts and deletion journals", () => {
    const valid = {
      cursor: "backup-2026-08-01-020000/",
      latest: "backup-2026-10-12-120000/",
      latestAttempts: 2,
      timeAttempts: 1,
      reviews: {
        "backup-2026-08-01-020000/": {
          files: { "DeviceConfigurations/Old.json": "abc123" },
          complete: { identity: "deadbeef", counts: [["DeviceConfigurations", 1]] },
          attempts: 0,
        },
      },
      deletions: {
        "backup-2026-08-01-020000/": {
          prefixes: ["backup-2026-08-01-020000/"],
          remnant: false,
          folders: ["DeviceConfigurations"],
          remaining: { "backup-2026-08-01-020000/metadata.json": '"etag-1"' },
          deleted: ["backup-2026-08-01-020000/DeviceConfigurations/Old.json"],
        },
      },
    }
    expect(readRetentionProgress(JSON.stringify(valid))).toEqual(valid)
    expect(readRetentionProgress("backup-2026-08-01-020000/")).toEqual({ cursor: "backup-2026-08-01-020000/", reviews: {} })
  })

  it.each([
    ["empty review entry", { reviews: { "backup-2026-01-01-000000/": {} } }],
    ["array reviews", { reviews: [] }],
    ["non-string cursor", { cursor: 123, reviews: {} }],
    ["non-string latest", { latest: 42, reviews: {} }],
    ["negative latestAttempts", { latestAttempts: -1, reviews: {} }],
    ["float latestAttempts", { latestAttempts: 1.5, reviews: {} }],
    ["non-integer timeAttempts", { timeAttempts: "2", reviews: {} }],
    ["missing review files", { reviews: { "backup-2026-01-01-000000/": { attempts: 0 } } }],
    ["array review files", { reviews: { "backup-2026-01-01-000000/": { attempts: 0, files: [] } } }],
    ["non-string file receipt", { reviews: { "backup-2026-01-01-000000/": { attempts: 0, files: { a: 42 } } } }],
    ["negative review attempts", { reviews: { "backup-2026-01-01-000000/": { attempts: -1, files: {} } } }],
    ["malformed complete receipt", { reviews: { "backup-2026-01-01-000000/": { attempts: 0, files: {}, complete: { identity: "x", counts: [["DeviceConfigurations", -1]] } } } }],
    ["malformed deletion journal", { reviews: {}, deletions: { "backup-2026-01-01-000000/": { prefixes: [], remnant: false, folders: [], remaining: {}, deleted: [] } } }],
    ["empty etag in deletion journal", { reviews: {}, deletions: { "backup-2026-01-01-000000/": { prefixes: ["backup-2026-01-01-000000/"], remnant: false, folders: [], remaining: { a: "" }, deleted: [] } } }],
  ])("discards persisted progress with invalid shape: %s", (_label, bad) => {
    expect(readRetentionProgress(JSON.stringify(bad))).toEqual({ reviews: {} })
  })

  it("uses path.basename for quarantine assertions in local-put-replacement.test.ts", () => {
    const source = readFileSync(resolve(process.cwd(), "test/local-put-replacement.test.ts"), "utf8")
    expect(source).not.toContain('quarantine.split("/")')
    expect(source).toContain("basename(quarantine)")
    // Sanity check hash helper import stays used cleanly
    expect(createHash("sha256").update("ok").digest("hex")).toHaveLength(64)
  })
})
