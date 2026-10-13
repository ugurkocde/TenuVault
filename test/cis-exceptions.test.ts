import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { exceptionKey, isActive, validateExceptions, validateNewException, type CisException } from "../src/shared/frameworks/cis-exceptions"
import { cisReadiness } from "../src/shared/frameworks/cis-readiness"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"
import { handleFramework, setInternalCisBenchmarksEnabled, assessPolicySet } from "../src/main/frameworks/service"
import { loadWorkspace, recordAssessment, saveWorkspace, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { parsePolicies } from "../src/shared/frameworks/policies"
import { generateCisReadinessPDF } from "../src/shared/compliance/report-pdf"
import { cisReadinessCsv, cisReadinessJson } from "../src/renderer/features/shared/governance-export"
import { inflateSync } from "node:zlib"

const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (name: string, description: string, settingId = "fakebook_setting_alpha") => JSON.stringify({
  name, platforms: "windows10", technologies: "mdm", description,
  settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: settingId, choiceSettingValue: { value: "fake-on" } } }],
})
const tenantId = "11111111-1111-1111-1111-111111111111"
const kitFiles: KitFile[] = [
  { path: "Level 1/Fakebook Alpha 9.9.9.json", content: policy("Fakebook Alpha", "Covers 7.1.1 and 7.1.2") },
  { path: "Level 1/Fakebook Beta 9.9.9.json", content: policy("Fakebook Beta", "Covers 7.1.2", "fakebook_setting_beta") },
  { path: "Level 2/Fakebook Gamma 9.9.9.json", content: policy("Fakebook Gamma", "Covers 7.2.1", "fakebook_setting_gamma") },
]

function memoryStore() {
  const data = new Map<string, string>()
  setFrameworkStore({ get: k => data.get(k) ?? null, set: (k, v) => { data.set(k, v) }, delete: k => { data.delete(k) } })
  return data
}

function assessed() {
  const converted = convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })
  const policies = converted.packs.flatMap(pack => pack.policies)
  const current = parsePolicies(JSON.parse(policy("Tenant Alpha", "tenant", "fakebook_setting_alpha"))).map((item, index) => ({ ...item, id: `33333333-3333-3333-3333-33333333333${index}` }))
  const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "fakebook-os 9.9.9", policies, current, runId: "run-1", assessedAt: "2026-10-13T00:00:00.000Z" })
  return { policies, assessment }
}

function makeException(overrides: Partial<CisException> = {}): CisException {
  return {
    id: "exc-1", benchmark: "fakebook-os", version: "9.9.9", level: 1,
    policyName: "Fakebook Beta", settingId: "fakebook_setting_beta",
    owner: "Ada Lovelace", reason: "Accepted risk for lab devices", expiresOn: "2027-01-01", createdAt: "2026-10-13T00:00:00.000Z",
    ...overrides,
  }
}

function futureDate(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1")
  const parts: string[] = []
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { parts.push(inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1")) } catch { parts.push(match[1]!) }
  }
  const shown = parts.join("\n").match(/\((?:\\.|[^\\()])*\)\s*Tj/g) ?? []
  return shown.map(chunk => chunk.replace(/\)\s*Tj$/, "").slice(1).replace(/\\([()\\])/g, "$1")).join(" ").replace(/\s+/g, " ")
}

beforeEach(() => { setInternalCisBenchmarksEnabled(null) })
afterEach(() => { setInternalCisBenchmarksEnabled(null); vi.unstubAllGlobals() })

describe("CIS exception validation", () => {
  it("accepts a valid list and trims text fields", () => {
    const result = validateExceptions([{ ...makeException(), owner: "  Ada Lovelace  " }])
    expect(result[0]?.owner).toBe("Ada Lovelace")
    expect(validateExceptions([])).toEqual([])
  })

  it("rejects invalid stored data", () => {
    expect(() => validateExceptions("nope")).toThrow()
    expect(() => validateExceptions([{ ...makeException(), level: 3 }])).toThrow()
    expect(() => validateExceptions([{ ...makeException(), owner: "" }])).toThrow()
    expect(() => validateExceptions([{ ...makeException(), owner: "x".repeat(101) }])).toThrow()
    expect(() => validateExceptions([{ ...makeException(), reason: "x".repeat(501) }])).toThrow()
    expect(() => validateExceptions([{ ...makeException(), expiresOn: "2027-13-01" }])).toThrow()
    expect(() => validateExceptions([{ ...makeException(), expiresOn: "01/01/2027" }])).toThrow()
    expect(() => validateExceptions([{ ...makeException(), createdAt: "not-a-date" }])).toThrow()
    expect(() => validateExceptions([makeException(), makeException()])).toThrow()
  })

  it("validates one new exception input", () => {
    expect(validateNewException({ benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_1", owner: "Ada", reason: "Risk accepted", expiresOn: "2027-01-01" }))
      .toMatchObject({ policyName: "Fakebook Beta", settingId: "fakebook_1" })
    expect(() => validateNewException({ benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "", settingId: "fakebook_1", owner: "Ada", reason: "r", expiresOn: "2027-01-01" })).toThrow()
    expect(() => validateNewException({ benchmark: "fakebook-os", version: "9.9.9", level: 2, policyName: "P", settingId: "fakebook_1", owner: "Ada", reason: "r", expiresOn: "2027-02-30" })).toThrow()
  })

  it("strips control characters including newlines from text fields", () => {
    const stored = validateExceptions([{ ...makeException(), owner: "Ada\nLovelace\r\nInjected: fake", reason: "Line one\nLine two\tEnd" }])
    expect(stored[0]?.owner).not.toContain("\n")
    expect(stored[0]?.owner).not.toContain("\r")
    expect(stored[0]?.reason).not.toContain("\n")
    expect(stored[0]?.reason).not.toContain("\t")
    const fresh = validateNewException({ benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_1", owner: "Ada\nLovelace", reason: "Risk\naccepted", expiresOn: "2027-01-01" })
    expect(fresh.owner).not.toContain("\n")
    expect(fresh.reason).not.toContain("\n")
  })

  it("builds a stable key and treats the expiry date as the last active day", () => {
    expect(exceptionKey("fakebook-os", "9.9.9", 1, "Fakebook Beta", "fakebook_1")).toBe(exceptionKey("fakebook-os", "9.9.9", 1, "Fakebook Beta", "fakebook_1"))
    expect(exceptionKey("fakebook-os", "9.9.9", 1, "Fakebook Beta", "fakebook_1")).not.toBe(exceptionKey("fakebook-os", "9.9.9", 2, "Fakebook Beta", "fakebook_1"))
    expect(isActive(makeException(), "2027-01-01")).toBe(true)
    expect(isActive(makeException(), "2027-01-02")).toBe(false)
    expect(isActive(makeException(), "2026-12-31T10:00:00.000Z")).toBe(true)
  })
})

describe("CIS readiness with exceptions", () => {
  it("counts excepted findings and the adjusted pass rate without changing raw counts", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies, undefined, undefined, [makeException()], "2026-10-13")
    const level1 = summary.levels.find(level => level.level === 1)!
    expect(level1.present).toBe(1)
    expect(level1.missing).toBe(1)
    expect(level1.passRate).toBe(0.5)
    expect(level1.excepted).toBe(1)
    expect(level1.adjustedPassRate).toBe(1)
    expect(level1.exceptions.map(item => item.id)).toEqual(["exc-1"])
    const level2 = summary.levels.find(level => level.level === 2)!
    expect(level2.excepted).toBe(0)
    expect(level2.exceptions).toEqual([])
    expect(level2.adjustedPassRate).toBe(0)
  })

  it("ignores expired, other level and other benchmark exceptions", () => {
    const { policies, assessment } = assessed()
    const expired = cisReadiness(assessment, policies, undefined, undefined, [makeException({ expiresOn: "2026-01-01" })], "2026-10-13")
    expect(expired.levels.find(level => level.level === 1)!.excepted).toBe(0)
    expect(expired.levels.find(level => level.level === 1)!.adjustedPassRate).toBe(0.5)
    const wrongLevel = cisReadiness(assessment, policies, undefined, undefined, [makeException({ level: 2 })], "2026-10-13")
    expect(wrongLevel.levels.find(level => level.level === 1)!.excepted).toBe(0)
    const wrongBenchmark = cisReadiness(assessment, policies, undefined, undefined, [makeException({ benchmark: "other-os" })], "2026-10-13")
    expect(wrongBenchmark.levels.find(level => level.level === 1)!.excepted).toBe(0)
    const noMatch = cisReadiness(assessment, policies, undefined, undefined, [makeException({ settingId: "fakebook_unknown" })], "2026-10-13")
    expect(noMatch.levels.find(level => level.level === 1)!.excepted).toBe(0)
    expect(noMatch.levels.find(level => level.level === 1)!.exceptions).toEqual([])
  })

  it("does not count an exception for a Present finding as excepted", () => {
    const { policies, assessment } = assessed()
    const present = makeException({ id: "exc-present", policyName: "Fakebook Alpha", settingId: "fakebook_setting_alpha" })
    const summary = cisReadiness(assessment, policies, undefined, undefined, [present], "2026-10-13")
    const level1 = summary.levels.find(level => level.level === 1)!
    expect(level1.excepted).toBe(0)
    expect(level1.exceptions).toEqual([])
    expect(level1.adjustedPassRate).toBe(0.5)
  })

  it("reports a null adjusted pass rate when nothing was assessed", () => {
    const { policies } = assessed()
    const empty = { ...assessed().assessment, findings: [] }
    const summary = cisReadiness(empty, policies, undefined, undefined, [makeException()], "2026-10-13")
    expect(summary.levels.find(level => level.level === 1)!.adjustedPassRate).toBeNull()
    expect(summary.levels.find(level => level.level === 1)!.excepted).toBe(0)
  })
})

describe("CIS exceptions in the PDF report", () => {
  it("lists the excepted count and active exception details", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies, undefined, undefined, [makeException()], "2026-10-13")
    const text = pdfText(generateCisReadinessPDF(summary, { exportedAt: "2026-10-13T10:00:00.000Z", tenantName: "Contoso", tenantId, assessedAt: "2026-10-13T00:00:00.000Z", runId: "run-1" }))
    expect(text).toContain("Excepted: 1")
    expect(text).toContain("Adjusted pass rate: 100%")
    expect(text).toContain("Accepted exceptions, Level 1")
    expect(text).toContain("Fakebook Beta")
    expect(text).toContain("fakebook_setting_beta")
    expect(text).toContain("Ada Lovelace")
    expect(text).toContain("2027-01-01")
  })
})

describe("CIS exceptions in governance exports", () => {
  it("includes excepted, adjusted pass rate and active exception details in CSV and JSON", () => {
    const { policies, assessment } = assessed()
    const summary = cisReadiness(assessment, policies, undefined, undefined, [makeException()], "2026-10-13")
    const csv = cisReadinessCsv(summary)
    expect(csv.split("\r\n")[0]).toContain("Excepted")
    expect(csv.split("\r\n")[0]).toContain("Adjusted pass rate")
    expect(csv.split("\r\n")[0]).toContain("Exceptions")
    expect(csv).toContain("Fakebook Beta")
    expect(csv).toContain("fakebook_setting_beta")
    expect(csv).toContain("Ada Lovelace")
    expect(csv).toContain("2027-01-01")
    expect(csv).toContain("Accepted risk for lab devices")
    const json = JSON.parse(cisReadinessJson(summary, "Contoso", "2026-10-13T10:00:00Z")) as { levels: Array<{ level: number; excepted: number; adjustedPassRate: number | null; exceptions: Array<{ policyName: string; settingId: string; owner: string; expiresOn: string; reason: string }> }> }
    const level1 = json.levels.find(level => level.level === 1)!
    expect(level1.excepted).toBe(1)
    expect(level1.adjustedPassRate).toBe(1)
    expect(level1.exceptions).toEqual([{ policyName: "Fakebook Beta", settingId: "fakebook_setting_beta", owner: "Ada Lovelace", expiresOn: "2027-01-01", reason: "Accepted risk for lab devices" }])
  })
})

describe("CIS exception workspace persistence", () => {
  it("round trips exceptions through save and load", () => {
    memoryStore()
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    workspace.exceptions = [makeException()]
    saveWorkspace(workspace)
    expect(loadWorkspace(tenantId, "cis-benchmarks").exceptions).toEqual([makeException()])
  })

  it("fails closed when stored exceptions are invalid", () => {
    const data = memoryStore()
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    workspace.exceptions = [makeException()]
    saveWorkspace(workspace)
    const key = [...data.keys()][0]!
    const stored = JSON.parse(data.get(key)!) as { exceptions: unknown }
    stored.exceptions = [{ ...makeException(), level: 3 }]
    data.set(key, JSON.stringify(stored))
    expect(() => loadWorkspace(tenantId, "cis-benchmarks")).toThrow("The saved workspace cannot be read")
  })
})

describe("CIS exception service actions", () => {
  it("rejects an exception on an empty workspace and adds and removes one after seeding a saved assessment", async () => {
    setInternalCisBenchmarksEnabled(true)
    memoryStore()
    const input = { action: "workspace-cis-exception-add", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_setting_beta", owner: "Ada Lovelace", reason: "Accepted risk", expiresOn: futureDate() }
    await expect(handleFramework(input)).rejects.toMatchObject({ status: 400 })
    expect(loadWorkspace(tenantId, "cis-benchmarks").exceptions ?? []).toEqual([])
    const { policies, assessment } = assessed()
    recordAssessment(assessment, policies)
    const added = await handleFramework(input) as { exceptions?: CisException[] }
    expect(added.exceptions).toHaveLength(1)
    expect(added.exceptions?.[0]).toMatchObject({ benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_setting_beta", owner: "Ada Lovelace" })
    expect(added.exceptions?.[0]?.id).toBeTruthy()
    const id = added.exceptions![0]!.id
    expect(loadWorkspace(tenantId, "cis-benchmarks").exceptions).toHaveLength(1)
    const removed = await handleFramework({ action: "workspace-cis-exception-remove", tenantId, frameworkId: "cis-benchmarks", exceptionId: id }) as { exceptions?: CisException[] }
    expect(removed.exceptions).toEqual([])
    await expect(handleFramework({ action: "workspace-cis-exception-remove", tenantId, frameworkId: "cis-benchmarks", exceptionId: id })).rejects.toMatchObject({ status: 404 })
  })

  it("rejects an exception that does not match any saved assessment finding", async () => {
    setInternalCisBenchmarksEnabled(true)
    memoryStore()
    const { policies, assessment } = assessed()
    recordAssessment(assessment, policies)
    await expect(handleFramework({ action: "workspace-cis-exception-add", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_unknown", owner: "Ada", reason: "Risk", expiresOn: futureDate() })).rejects.toMatchObject({ status: 400 })
    await expect(handleFramework({ action: "workspace-cis-exception-add", tenantId, frameworkId: "cis-benchmarks", benchmark: "other-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_setting_beta", owner: "Ada", reason: "Risk", expiresOn: futureDate() })).rejects.toMatchObject({ status: 400 })
    await expect(handleFramework({ action: "workspace-cis-exception-add", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 2, policyName: "Fakebook Beta", settingId: "fakebook_setting_beta", owner: "Ada", reason: "Risk", expiresOn: futureDate() })).rejects.toMatchObject({ status: 400 })
    expect(loadWorkspace(tenantId, "cis-benchmarks").exceptions ?? []).toEqual([])
  })

  it("rejects adding beyond the exception cap before saving so the workspace still loads", async () => {
    setInternalCisBenchmarksEnabled(true)
    memoryStore()
    const { policies, assessment } = assessed()
    recordAssessment(assessment, policies)
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    workspace.exceptions = Array.from({ length: 500 }, (_, index) => makeException({ id: `exc-${index}` }))
    saveWorkspace(workspace)
    await expect(handleFramework({ action: "workspace-cis-exception-add", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_setting_beta", owner: "Ada", reason: "Risk", expiresOn: futureDate() })).rejects.toMatchObject({ status: 400 })
    expect(loadWorkspace(tenantId, "cis-benchmarks").exceptions).toHaveLength(500)
  })

  it("rejects a duplicate active exception with 409 and allows the same key after expiry", async () => {
    setInternalCisBenchmarksEnabled(true)
    memoryStore()
    const { policies, assessment } = assessed()
    recordAssessment(assessment, policies)
    const input = { action: "workspace-cis-exception-add", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_setting_beta", owner: "Ada", reason: "Risk", expiresOn: futureDate() }
    await handleFramework(input)
    await expect(handleFramework(input)).rejects.toMatchObject({ status: 409 })
    expect(loadWorkspace(tenantId, "cis-benchmarks").exceptions).toHaveLength(1)
    const workspace = loadWorkspace(tenantId, "cis-benchmarks")
    workspace.exceptions = workspace.exceptions!.map(exception => ({ ...exception, expiresOn: "2020-01-01" }))
    saveWorkspace(workspace)
    const added = await handleFramework(input) as { exceptions?: CisException[] }
    expect(added.exceptions).toHaveLength(2)
  })

  it("rejects invalid add input and a past expiry date", async () => {
    setInternalCisBenchmarksEnabled(true)
    memoryStore()
    const base = { action: "workspace-cis-exception-add", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_1", owner: "Ada", reason: "Risk", expiresOn: futureDate() }
    await expect(handleFramework({ ...base, owner: "" })).rejects.toMatchObject({ status: 400 })
    await expect(handleFramework({ ...base, reason: "x".repeat(501) })).rejects.toMatchObject({ status: 400 })
    await expect(handleFramework({ ...base, level: 3 })).rejects.toMatchObject({ status: 400 })
    await expect(handleFramework({ ...base, policyName: "" })).rejects.toMatchObject({ status: 400 })
    await expect(handleFramework({ ...base, expiresOn: "2020-01-01" })).rejects.toMatchObject({ status: 400 })
    await expect(handleFramework({ ...base, expiresOn: "not-a-date" })).rejects.toMatchObject({ status: 400 })
    expect(loadWorkspace(tenantId, "cis-benchmarks").exceptions ?? []).toEqual([])
  })

  it("refuses exception actions for other frameworks and when the flag is off", async () => {
    setInternalCisBenchmarksEnabled(true)
    memoryStore()
    await expect(handleFramework({ action: "workspace-cis-exception-add", tenantId, frameworkId: "custom", benchmark: "b", version: "1", level: 1, policyName: "P", settingId: "fakebook_1", owner: "Ada", reason: "r", expiresOn: futureDate() }))
      .rejects.toMatchObject({ status: 400 })
    setInternalCisBenchmarksEnabled(false)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(handleFramework({ action: "workspace-cis-exception-add", tenantId, frameworkId: "cis-benchmarks", benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "P", settingId: "fakebook_1", owner: "Ada", reason: "r", expiresOn: futureDate() }))
      .rejects.toMatchObject({ status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })
})
