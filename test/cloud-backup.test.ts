import { describe, expect, it } from "vitest"
import {
  cloudSetupCommand,
  cloudStatusBlobName,
  describeCloudSchedule,
  nextRunsInZone,
  parseCloudSetup,
  parseCloudStatus,
} from "../src/shared/cloud-backup"

const TENANT = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
const SETUP_BLOCK = `noise before
--- TenuVault cloud backup setup (paste into TenuVault) ---
tenantId=${TENANT}
subscriptionId=11111111-2222-3333-4444-555555555555
resourceGroup=rg-tenuvault-backups
automationAccount=aa-tenuvault
storageAccount=tvbkp1234567890ab
keyVault=kv-tenuvault-abc123
scheduleName=TenuVaultBackup-aaaaaaaa
frequency=weekly
time=02:30
weekDay=Wednesday
timeZone=Europe/Berlin
tenantKey=aaaaaaaa
linked=true
--- End of TenuVault cloud backup setup ---`

describe("parseCloudSetup", () => {
  it("reads the block the setup script prints", () => {
    expect(parseCloudSetup(SETUP_BLOCK)).toEqual({
      tenantId: TENANT.toLowerCase(),
      subscriptionId: "11111111-2222-3333-4444-555555555555",
      resourceGroup: "rg-tenuvault-backups",
      automationAccount: "aa-tenuvault",
      storageAccount: "tvbkp1234567890ab",
      keyVault: "kv-tenuvault-abc123",
      scheduleName: "TenuVaultBackup-aaaaaaaa",
      frequency: "weekly",
      time: "02:30",
      weekday: 3,
      timeZone: "Europe/Berlin",
      tenantKey: "aaaaaaaa",
      linked: true,
    })
  })

  it("round trips the stored JSON form and refuses half a setup", () => {
    const config = parseCloudSetup(SETUP_BLOCK)!
    const stored = Object.entries(config).map(([k, v]) => `${k}=${String(v)}`).join("\n")
    expect(parseCloudSetup(stored)?.automationAccount).toBe("aa-tenuvault")
    expect(parseCloudSetup("hello world")).toBeNull()
    expect(parseCloudSetup(SETUP_BLOCK.replace(TENANT, "not-a-guid"))).toBeNull()
    expect(parseCloudSetup(SETUP_BLOCK.replace("tvbkp1234567890ab", "Bad Account!"))).toBeNull()
    expect(parseCloudSetup(SETUP_BLOCK.replace("linked=true", "linked=false"))?.linked).toBe(false)
  })

  it("names the status blob per tenant and describes the schedule", () => {
    expect(cloudStatusBlobName(TENANT)).toBe("cloud-backup-status-aaaaaaaa.json")
    const config = parseCloudSetup(SETUP_BLOCK)!
    expect(describeCloudSchedule(config)).toBe("Weekly on Wednesday at 02:30 (Europe/Berlin)")
    expect(describeCloudSchedule({ ...config, linked: false })).toContain("not linked")
  })
})

describe("parseCloudStatus", () => {
  const body = {
    LastRunAt: "2026-10-30T02:02:00.000Z",
    LastStatus: "Success",
    LastMessage: "Backup Success, 42 policies.",
    BackupFolder: "backup-2026-10-30-020000",
    RunbookVersion: "1.0.0",
    Source: "TenuVault Cloud Backup",
    TenantId: TENANT.toLowerCase(),
  }
  it("reads the runbook status for its tenant only", () => {
    expect(parseCloudStatus(body, TENANT)).toMatchObject({ lastStatus: "Success", backupFolder: "backup-2026-10-30-020000" })
    expect(parseCloudStatus(body, "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee")).toBeNull()
    expect(parseCloudStatus({ ...body, Source: "Someone Else" }, TENANT)).toBeNull()
    expect(parseCloudStatus(null, TENANT)).toBeNull()
  })
})

describe("nextRunsInZone", () => {
  it("lists daily runs strictly after now in the named zone", () => {
    // 2026-10-30 12:00 in Berlin is 11:00 UTC (CET).
    const runs = nextRunsInZone({ frequency: "daily", time: "02:00", weekday: 0 }, "Europe/Berlin", new Date("2026-10-30T11:00:00Z"), 3)
    expect(runs.map((run) => run.toISOString())).toEqual([
      "2026-10-31T01:00:00.000Z",
      "2026-11-01T01:00:00.000Z",
      "2026-11-02T01:00:00.000Z",
    ])
  })

  it("follows the clock change instead of a fixed offset", () => {
    // CEST ends 2026-10-25: 02:00 Berlin is 00:00 UTC before, 01:00 UTC after.
    const runs = nextRunsInZone({ frequency: "daily", time: "02:00", weekday: 0 }, "Europe/Berlin", new Date("2026-10-23T10:00:00Z"), 4)
    expect(runs.map((run) => run.toISOString())).toEqual([
      "2026-10-24T00:00:00.000Z",
      "2026-10-25T00:00:00.000Z",
      "2026-10-26T01:00:00.000Z",
      "2026-10-27T01:00:00.000Z",
    ])
  })

  it("picks the configured weekday and rejects bad input", () => {
    // 2026-10-30 is a Friday; the next Wednesdays at 02:30 Berlin follow.
    const runs = nextRunsInZone({ frequency: "weekly", time: "02:30", weekday: 3 }, "Europe/Berlin", new Date("2026-10-30T11:00:00Z"), 2)
    expect(runs.map((run) => run.toISOString())).toEqual(["2026-11-04T01:30:00.000Z", "2026-11-11T01:30:00.000Z"])
    expect(nextRunsInZone({ frequency: "daily", time: "", weekday: 0 }, "Europe/Berlin", new Date(), 3)).toEqual([])
    expect(nextRunsInZone({ frequency: "daily", time: "02:00", weekday: 0 }, "Not/AZone", new Date(), 3)).toEqual([])
  })
})

describe("cloudSetupCommand", () => {
  it("fills in the choices and keeps secrets off the command line", () => {
    const command = cloudSetupCommand({ tenantId: TENANT, storageAccount: "tvbkp1", frequency: "weekly", time: "02:00", weekday: 1, timeZone: "Europe/Berlin", scope: "policies" })
    expect(command).toContain(`-TenantId ${TENANT}`)
    expect(command).toContain("-WeekDay Monday")
    expect(command).toContain("-Scope policies")
    expect(command).toContain("-GrantGraphRoles")
    expect(command.toLowerCase()).not.toContain("recovery")
    expect(command.toLowerCase()).not.toContain("secret")
  })
})
