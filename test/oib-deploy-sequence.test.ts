import { describe, expect, it } from "vitest"
import { batchFolders, batchFor, deployToTenant, type BackupRequest, type DeployBatch } from "../src/renderer/components/oib/deploy-sequence"
import type { OibCatalog, OibRun } from "../src/shared/oib/types"

const batch = (platform: DeployBatch["platform"], folders = ["configurationPolicies"]): DeployBatch => ({ platform, commit: "a".repeat(40), reference: platform, items: folders.map(folder => ({ source: `${platform}/${folder}.json`, mode: "create", folder })) })
const run = (platform: DeployBatch["platform"], backupFolder?: string): OibRun => ({ runId: platform, tenantId: "t", createdAt: "", kind: "deploy", platform, reference: platform, ...(backupFolder ? { backupFolder } : {}), created: [], updated: [], failed: [] })
const batches = [batch("windows"), batch("macos"), batch("byod")]
const NEW: BackupRequest = { mode: "new" }

describe("deploying several platforms to one tenant", () => {
  it("backs up with the first batch and reuses that backup for batches it covers", async () => {
    const sent: Array<[string, BackupRequest]> = []
    const outcomes = await deployToTenant(batches, { backup: NEW, storage: true }, async (b, backup) => { sent.push([b.platform, backup]); return run(b.platform, backup.mode === "new" ? "backup-1" : undefined) })
    expect(sent).toEqual([["windows", NEW], ["macos", { mode: "reuse", folder: "backup-1" }], ["byod", { mode: "reuse", folder: "backup-1" }]])
    expect(outcomes.every(o => o.run)).toBe(true)
  })

  it("backs up again for a batch that writes folders the first backup did not cover", async () => {
    const sent: BackupRequest[] = []
    await deployToTenant([batch("windows"), batch("byod", ["managedAppPolicies"])], { backup: NEW, storage: true }, async (b, backup) => { sent.push(backup); return run(b.platform, backup.mode === "new" ? `backup-${b.platform}` : undefined) })
    expect(sent).toEqual([NEW, NEW])
  })

  it("uses a chosen recent backup for every batch", async () => {
    const reuse: BackupRequest = { mode: "reuse", folder: "recent" }
    const sent: BackupRequest[] = []
    await deployToTenant(batches, { backup: reuse, storage: true }, async (b, backup) => { sent.push(backup); return run(b.platform, "recent") })
    expect(sent).toEqual([reuse, reuse, reuse])
  })

  it("stops the tenant's remaining batches when the backup fails", async () => {
    const sent: string[] = []
    const outcomes = await deployToTenant(batches, { backup: NEW, storage: true }, async (b) => { sent.push(b.platform); throw Object.assign(new Error("The backup failed, so nothing was changed."), { code: "backup" }) })
    expect(sent).toEqual(["windows"])
    expect(outcomes.map(o => o.error)).toEqual(["The backup failed, so nothing was changed.", expect.stringContaining("Skipped"), expect.stringContaining("Skipped")])
    expect(outcomes.every(o => o.backupFailed)).toBe(true)
  })

  it("stops when the backup is not confirmed or there is no backup storage", async () => {
    const sent: string[] = []
    const unconfirmed = await deployToTenant(batches, { backup: NEW, storage: true }, async (b) => { sent.push(b.platform); return run(b.platform) })
    expect(sent).toEqual(["windows"])
    expect(unconfirmed.slice(1).every(o => o.error?.startsWith("Skipped"))).toBe(true)
    const noStorage = await deployToTenant(batches, { backup: NEW, storage: false }, async () => { throw new Error("not sent") })
    expect(noStorage.every(o => o.error?.includes("no backup storage") || o.error?.startsWith("Skipped"))).toBe(true)
  })

  it("continues after a batch refused before its backup for another reason", async () => {
    const sent: string[] = []
    const outcomes = await deployToTenant(batches, { backup: NEW, storage: true }, async (b) => {
      sent.push(b.platform)
      // The wording mentions a backup, but only the code marks a backup failure.
      if (b.platform === "windows") throw Object.assign(new Error("The filter Backup pilot is not a Windows filter. Nothing was changed."), { status: 400 })
      return run(b.platform, `backup-${b.platform}`)
    })
    expect(sent).toEqual(["windows", "macos", "byod"])
    expect(outcomes.map(o => !!o.run)).toEqual([false, true, true])
    expect(outcomes[0]!.backupFailed).toBeUndefined()
  })

  it("stops when a request with a backup got no answer, since the backup's outcome is unknown", async () => {
    const sent: string[] = []
    const outcomes = await deployToTenant(batches, { backup: NEW, storage: true }, async (b) => { sent.push(b.platform); throw new TypeError("Failed to fetch") })
    expect(sent).toEqual(["windows"])
    expect(outcomes.slice(1).every(o => o.error?.includes("got no answer") && o.backupFailed)).toBe(true)
  })

  it("continues after a failed batch when no backup was asked for", async () => {
    const sent: Array<[string, BackupRequest]> = []
    const outcomes = await deployToTenant(batches, { backup: { mode: "none" }, storage: false }, async (b, backup) => {
      sent.push([b.platform, backup])
      if (b.platform === "windows") throw new Error("GitHub request failed")
      return run(b.platform)
    })
    expect(sent.map(s => s[1].mode)).toEqual(["none", "none", "none"])
    expect(outcomes.map(o => !!o.run)).toEqual([false, true, true])
  })
})

describe("batches from a loaded pack", () => {
  it("fills names and folders, and reports folders only when all are known", () => {
    const catalog = { platform: "windows", commit: "c", reference: "r", policies: [{ source: "a.json", name: "A", folder: "configurationPolicies" }, { source: "b.json", name: "B", folder: "deviceCompliancePolicies" }] } as unknown as OibCatalog
    const built = batchFor(catalog, [{ source: "b.json", mode: "create" }, { source: "a.json", mode: "update", targetId: "x", targetName: "Old A" }])
    expect(built.items).toEqual([{ source: "b.json", mode: "create", name: "B", folder: "deviceCompliancePolicies" }, { source: "a.json", mode: "update", targetId: "x", targetName: "Old A", name: "A", folder: "configurationPolicies" }])
    expect(batchFolders([built])).toEqual(["configurationPolicies", "deviceCompliancePolicies"])
    expect(batchFolders([{ ...built, items: [{ source: "z.json", mode: "create" }] }])).toEqual([])
  })
})
