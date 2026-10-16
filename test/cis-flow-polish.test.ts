import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { assessPolicySet, handleFramework, setFrameworkExportSaver, setInternalCisBenchmarksEnabled, type ExportFile } from "../src/main/frameworks/service"
import { setNativeFrameworkAuthorization } from "../src/main/frameworks/native"
import { loadWorkspace, recordAssessment, setFrameworkStore } from "../src/main/frameworks/workspaces"
import { clearSettingNames } from "../src/portal/lib/drift/setting-names"
import { benchmarkTitle, cisExportFileName, knownBenchmarkName, omittedSettingValues, optionDisplayName, readableDiffEntry, referenceDisplayName, settingDisplayName } from "../src/shared/frameworks/cis-display"
import { localDate, type CisException } from "../src/shared/frameworks/cis-exceptions"
import { MAX_SETTING_LEAVES, summarizeSetting } from "../src/shared/frameworks/setting-summary"
import { workspaceExportCSV } from "../src/shared/compliance/export"
import { deploymentImpactText, deploymentReferenceLabel } from "../src/renderer/features/cis-remediation/CisRemediationHistory"
import { clearCisCatalogs, rememberCisCatalog } from "../src/renderer/lib/cis-catalog-cache"
import { clearCisSettingNames, loadCisSettingNames, MAX_NAME_ATTEMPTS, MAX_NAMED_DEFINITIONS } from "../src/renderer/lib/cis-setting-names"
import type { SettingNames } from "../src/shared/intune/drift"
import type { BaselinePolicy } from "../src/shared/frameworks/policies"
import { diffConfigurations } from "../src/main/features/change-sets/model"
import { typeForFolder, type Item } from "../src/shared/intune/registry"
import { prepareGeneratedFile, prepareSaveFile, SAVE_FILE_LIMIT } from "../src/main/save-file"
import { changeSetCreator } from "../src/renderer/features/shared/ChangeSetFlow"

const tenantId = "11111111-1111-1111-1111-111111111111"
const appId = "22222222-2222-2222-2222-222222222222"
const ENCRYPTION = "device_vendor_msft_policy_config_lanmanworkstation_requireencryption"
const names: SettingNames = { settings: { [ENCRYPTION]: "Require Encryption" }, options: { [`${ENCRYPTION}_0`]: "Disabled", [`${ENCRYPTION}_1`]: "Enabled" } }
const choice = (value: string) => ({ "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: ENCRYPTION, choiceSettingValue: { value: `${ENCRYPTION}_${value}`, children: [] } })

describe("CIS labels instead of raw values", () => {
  it("names settings and choices from the setting definitions, and falls back to the raw value without a label", () => {
    expect(settingDisplayName(ENCRYPTION, names)).toBe("Require Encryption")
    expect(settingDisplayName("device_vendor_msft_policy_config_other_setting", names)).toBe("Other setting")
    expect(optionDisplayName(`${ENCRYPTION}_1`, ENCRYPTION, names)).toBe("Enabled")
    expect(optionDisplayName(`${ENCRYPTION}_785`, ENCRYPTION, names)).toBe("785")
    expect(summarizeSetting(choice("1"), names)).toEqual(["Require Encryption: Selected option: Enabled"])
    // Without names the summary is unchanged.
    expect(summarizeSetting(choice("1"))).toEqual(["lanmanworkstation_requireencryption: Selected option: 1"])
  })

  it("reads a deployment difference as setting name with option labels", () => {
    const entry = { path: `settings.${ENCRYPTION}.settingInstance.choiceSettingValue.value`, change: "changed" as const, before: `${ENCRYPTION}_0`, after: `${ENCRYPTION}_1` }
    expect(readableDiffEntry(entry, names)).toEqual({ label: "Require Encryption", before: "Disabled", after: "Enabled" })
    // Without names it still drops the definition id from the label and the values.
    expect(readableDiffEntry(entry)).toEqual({ label: "Lanmanworkstation: Require encryption", before: "0", after: "1" })
    // A child choice inside a group is named by the setting its option belongs to.
    const child = `${ENCRYPTION}_child`
    expect(readableDiffEntry({ path: `settings.${ENCRYPTION}.settingInstance.groupSettingCollectionValue[0].children[1].choiceSettingValue.value`, before: `${child}_0`, after: `${child}_1` }, { settings: { [child]: "Child setting" }, options: { [`${child}_1`]: "On" } })).toEqual({ label: "Child setting", before: "0", after: "On" })
    // A whole added setting shows its summary; other paths keep their path.
    expect(readableDiffEntry({ path: `settings.${ENCRYPTION}`, after: JSON.stringify({ settingInstance: choice("1") }) }, names)).toEqual({ label: "Require Encryption", after: "Require Encryption: Selected option: Enabled" })
    expect(readableDiffEntry({ path: "description", before: "a", after: "b" }, names)).toEqual({ label: "description", before: "a", after: "b" })
  })
})

describe("benchmark names before and after the catalog loads", () => {
  afterEach(() => clearCisCatalogs())

  it("names known delivered benchmarks the same with and without the catalog", () => {
    expect(knownBenchmarkName("intune-windows11")).toBe("Microsoft Intune for Windows 11")
    expect(knownBenchmarkName("constructor")).toBeNull()
    expect(benchmarkTitle("mac-os-26")).toBe("CIS Apple macOS 26")
    expect(referenceDisplayName("office-intune-bk 1.1.0 Level 1")).toBe("Microsoft Intune for Office 1.1.0 Level 1")
    const references = ["intune-windows11 5.0.0 Level 1", "mac-os-26 1.0.0 Level 2", "intune-for-defender 1.0.0 Level 1", "office-intune-bk 1.1.0 Level 1", "microsoft-intune-edge 1.0.0 Level 2"]
    const before = references.map(reference => deploymentReferenceLabel(reference, tenantId))
    rememberCisCatalog(tenantId, [
      { id: "intune-windows11", name: "Microsoft Intune for Windows 11", version: "5.0.0", levels: [1, 2] },
      { id: "mac-os-26", name: "CIS Apple macOS 26", version: "1.0.0", levels: [1, 2] },
      { id: "intune-for-defender", name: "Microsoft Defender Antivirus", version: "1.0.0", levels: [1, 2] },
      { id: "office-intune-bk", name: "Microsoft Intune for Office", version: "1.1.0", levels: [1, 2] },
      { id: "microsoft-intune-edge", name: "Microsoft Intune for Edge", version: "1.0.0", levels: [1, 2] },
    ])
    expect(references.map(reference => deploymentReferenceLabel(reference, tenantId))).toEqual(before)
    expect(before).toEqual(["Microsoft Intune for Windows 11 5.0.0 Level 1", "CIS Apple macOS 26 1.0.0 Level 2", "Microsoft Defender Antivirus 1.0.0 Level 1", "Microsoft Intune for Office 1.1.0 Level 1", "Microsoft Intune for Edge 1.0.0 Level 2"])
  })

  it("states what a planned deployment does to new and existing policies", () => {
    const item = (action: "create" | "update", assignedExposure: boolean) => ({ policyIndex: 0, policyName: "P", action, targetId: null, targetName: null, findingKeys: [], assignedExposure, assignmentCount: assignedExposure ? 2 : 0 })
    expect(deploymentImpactText([item("create", false)])).toBe("Creates 1 new policy with no assignments: it takes no effect until an administrator assigns it in Intune. Assignments are never copied or changed by this flow.")
    expect(deploymentImpactText([item("create", false), item("update", true), item("update", false)])).toBe("Creates 1 new policy with no assignments: it takes no effect until an administrator assigns it in Intune. Updates 2 existing tenant policies in place for the Different findings. 1 of them is assigned and keeps its assignments, so the change reaches those devices after apply. Assignments are never copied or changed by this flow.")
  })
})

describe("CIS export files", () => {
  it("names a file for its benchmark, content, tenant and day, without a run id or a spaced hyphen", () => {
    expect(cisExportFileName({ reference: "intune-windows11 5.0.0 Level 1", part: "findings", tenantName: "Contoso", date: "2026-10-16T10:00:00Z", extension: "csv" })).toBe("CIS Microsoft Intune for Windows 11 5.0.0 L1 findings (Contoso) 2026-10-16.csv")
    expect(cisExportFileName({ reference: "mac-os-26 1.0.0 Level 2", benchmarkName: "CIS Apple macOS 26", part: "readiness", tenantName: "Fabrikam - EU / Lab", date: "2026-10-16", extension: "json" })).toBe("CIS Apple macOS 26 1.0.0 L2 readiness (Fabrikam EU Lab) 2026-10-16.json")
    expect(cisExportFileName({ reference: "", part: "saved assessments", tenantName: null, date: "2026-10-16", extension: "json" })).toBe("CIS Benchmarks saved assessments 2026-10-16.json")
  })
})

describe("CIS main process actions", () => {
  let data: Map<string, string>
  let writes: number
  const policy: BaselinePolicy = { name: "Synthetic policy", platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark: "intune-windows11", version: "5.0.0", level: "Level 1", sourceFile: "s.json" }, settings: [{ settingInstance: choice("1") }, { settingInstance: { ...choice("1"), settingDefinitionId: "synthetic_other", choiceSettingValue: { value: "synthetic_other_1", children: [] } } }] }
  beforeEach(() => {
    data = new Map()
    writes = 0
    setFrameworkStore({ get: key => data.get(key) ?? null, set: (key, value) => { writes += 1; data.set(key, value) }, delete: key => { data.delete(key) } })
    setInternalCisBenchmarksEnabled(true)
    setNativeFrameworkAuthorization(async () => "pro")
  })
  afterEach(() => { setInternalCisBenchmarksEnabled(null); vi.unstubAllGlobals(); clearSettingNames() })
  const record = () => {
    const assessment = assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "intune-windows11 5.0.0 Level 1", policies: [policy], current: [], runId: "run-polish", assessedAt: "2026-10-10T12:00:00.000Z" })
    recordAssessment(assessment, [policy])
    return assessment
  }

  it("exports findings CSV with its header on line 1 and a readable file name", async () => {
    record()
    const { file } = await handleFramework({ action: "workspace-csv", frameworkId: "cis-benchmarks", tenantId, tenantName: "Contoso", runId: "run-polish" }) as { file: ExportFile }
    expect(file.name).toBe(`CIS Microsoft Intune for Windows 11 5.0.0 L1 findings (Contoso) ${localDate()}.csv`)
    const lines = file.data.replace(/^﻿/, "").split("\r\n")
    expect(lines[0]).toBe("Pack policy,Setting,Status,Recommended,Observed policies,Observed values,Assignment evidence,Tenant,Profile,Assessed,Exported,Run")
    expect(lines[1]).toContain(`Synthetic policy,${ENCRYPTION},Missing,`)
    expect(lines[1]).toContain("Contoso (11111111-1111-1111-1111-111111111111),intune-windows11 5.0.0 Level 1,2026-10-10T12:00:00.000Z,")
    expect(lines).toHaveLength(3)
    const json = await handleFramework({ action: "workspace-json", frameworkId: "cis-benchmarks", tenantId, tenantName: "Contoso" }) as { file: ExportFile }
    expect(json.file.name).toBe(`CIS Benchmarks saved assessments (Contoso) ${localDate()}.json`)
    // Other frameworks keep the report header above the table.
    const saved = loadWorkspace(tenantId, "cis-benchmarks").history[0]!
    expect(workspaceExportCSV(saved, { exportedAt: "2026-10-16T10:00:00Z", tenantName: "Contoso" }).split("\r\n")[0]).toBe("Report,TenuVault policy pack assessment")
  })

  it("excludes several findings in one save and reports each refused one", async () => {
    record()
    writes = 0
    const expiresOn = localDate(new Date(Date.now() + 86_400_000 * 30))
    const item = (settingId: string) => ({ benchmark: "intune-windows11", version: "5.0.0", level: 1, policyName: "Synthetic policy", settingId })
    const answer = await handleFramework({ action: "workspace-cis-exception-add-batch", frameworkId: "cis-benchmarks", tenantId, owner: "Owner", reason: "Accepted", expiresOn, items: [item(ENCRYPTION), item("not_in_assessment"), item(ENCRYPTION), item("synthetic_other")] }) as { workspace: { exceptions?: CisException[] }; results: Array<{ ok: boolean; error?: string }> }
    expect(answer.results.map(result => result.ok)).toEqual([true, false, false, true])
    expect(answer.results[1]!.error).toBe("No saved assessment finding matches this exception. Run an assessment for this benchmark first.")
    expect(answer.results[2]!.error).toBe("An active exception already exists for this finding.")
    expect(answer.workspace.exceptions?.map(exception => exception.settingId)).toEqual([ENCRYPTION, "synthetic_other"])
    expect(writes).toBe(1)
    // Nothing accepted, nothing written.
    writes = 0
    const none = await handleFramework({ action: "workspace-cis-exception-add-batch", frameworkId: "cis-benchmarks", tenantId, owner: "Owner", reason: "Accepted", expiresOn, items: [item(ENCRYPTION)] }) as { results: Array<{ ok: boolean }> }
    expect(none.results.map(result => result.ok)).toEqual([false])
    expect(writes).toBe(0)
    await expect(handleFramework({ action: "workspace-cis-exception-add-batch", frameworkId: "cis-benchmarks", tenantId, owner: "Owner", reason: "Accepted", expiresOn, items: [] })).rejects.toMatchObject({ status: 400 })
  })

  it("reads setting names from the public setting definitions with the tenant token", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "token" })
      const body = JSON.parse(String(init?.body)) as { requests: Array<{ id: string; url: string }> }
      calls.push({ url, body })
      return Response.json({ responses: body.requests.map(request => request.url.endsWith(ENCRYPTION)
        ? { id: request.id, status: 200, body: { displayName: "Require Encryption", options: [{ itemId: `${ENCRYPTION}_0`, displayName: "Disabled" }, { itemId: `${ENCRYPTION}_1`, displayName: "Enabled" }] } }
        : { id: request.id, status: 404 }) })
    }))
    const result = await handleFramework({ action: "cis-setting-names", frameworkId: "cis-benchmarks", tenantId, appId, ids: [ENCRYPTION, "unknown_setting", 7, "bad id with spaces"] }) as SettingNames
    expect(result).toEqual(names)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/beta/$batch")
    expect((calls[0]!.body as { requests: Array<{ method: string; url: string }> }).requests).toEqual([
      { id: "0", method: "GET", url: `/deviceManagement/configurationSettings/${ENCRYPTION}` },
      { id: "1", method: "GET", url: "/deviceManagement/configurationSettings/unknown_setting" },
    ])
    await expect(handleFramework({ action: "cis-setting-names", frameworkId: "ncsc-dsg", tenantId, appId, ids: [ENCRYPTION] })).rejects.toMatchObject({ status: 400 })
    setInternalCisBenchmarksEnabled(false)
    await expect(handleFramework({ action: "cis-setting-names", frameworkId: "cis-benchmarks", tenantId, appId, ids: [ENCRYPTION] })).rejects.toMatchObject({ status: 403 })
  })
})

describe("setting names in the renderer", () => {
  afterEach(() => { clearCisSettingNames(); vi.unstubAllGlobals() })
  const tenant = { tenantId, appId }

  it("shares a lookup in flight, asks again for ids without a name a bounded number of times, and splits large requests", async () => {
    const asked: string[][] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids
      asked.push(ids)
      if (asked.length === 1) await gate
      return Response.json({ settings: Object.fromEntries(ids.filter(id => id === ENCRYPTION).map(id => [id, "Require Encryption"])), options: {} })
    }))
    const first = loadCisSettingNames(tenant, [ENCRYPTION, "unknown_setting"])
    const second = loadCisSettingNames(tenant, [ENCRYPTION])
    release()
    // The second caller waits for the first lookup and gets its names.
    expect((await second).settings[ENCRYPTION]).toBe("Require Encryption")
    expect((await first).settings[ENCRYPTION]).toBe("Require Encryption")
    expect(asked).toEqual([[ENCRYPTION, "unknown_setting"]])
    // A named id is never asked again; an unnamed one only up to the limit.
    for (let round = 0; round < MAX_NAME_ATTEMPTS + 2; round += 1) await loadCisSettingNames(tenant, [ENCRYPTION, "unknown_setting"])
    expect(asked.filter(ids => ids.includes("unknown_setting"))).toHaveLength(MAX_NAME_ATTEMPTS)
    expect(asked.some(ids => ids.includes(ENCRYPTION) && asked.indexOf(ids) > 0)).toBe(false)
    // More ids than one request holds go out in follow-up requests.
    asked.length = 0
    const many = Array.from({ length: MAX_NAMED_DEFINITIONS + 3 }, (_, index) => `synthetic_setting_${index}`)
    await loadCisSettingNames(tenant, many)
    expect(asked.map(ids => ids.length)).toEqual([MAX_NAMED_DEFINITIONS, 3])
  })

  it("rejects only when no lookup succeeded, and asks a failed id again", async () => {
    let fail = true
    vi.stubGlobal("fetch", vi.fn(async () => fail ? Response.json({ error: "Graph unavailable" }, { status: 502 }) : Response.json(names)))
    await expect(loadCisSettingNames(tenant, [ENCRYPTION])).rejects.toThrow("Graph unavailable")
    fail = false
    expect((await loadCisSettingNames(tenant, [ENCRYPTION])).options[`${ENCRYPTION}_1`]).toBe("Enabled")
  })
})

describe("review round 1 of the flow polish", () => {
  const type = typeForFolder("ConfigurationPolicies")!
  const GROUP = "device_vendor_msft_policy_config_securityoptions"
  const TIMEOUT = `${GROUP}_lockscreentimeout`
  const MODE = `${GROUP}_lockscreenmode`
  const groupSetting = (timeout: number, mode: string) => ({ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance", settingDefinitionId: GROUP, groupSettingCollectionValue: [{ children: [
    { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: TIMEOUT, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value: timeout } },
    { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: MODE, choiceSettingValue: { value: `${MODE}_${mode}`, children: [] } },
  ] }] } })
  const policy = (settings: object[]): Item => ({ name: "Security", description: "", platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings } as unknown as Item)
  const groupNames: SettingNames = { settings: { [GROUP]: "Security options", [TIMEOUT]: "Lock screen timeout", [MODE]: "Lock screen mode", [ENCRYPTION]: "Require Encryption" }, options: { [`${MODE}_1`]: "Locked", [`${ENCRYPTION}_1`]: "Enabled" } }

  it("names a changed child of a group by its own setting, from the engine's diff", () => {
    const { entries } = diffConfigurations(type, policy([groupSetting(30, "1")]), policy([groupSetting(60, "1")]))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.definitionId).toBe(TIMEOUT)
    expect(readableDiffEntry(entries[0]!, groupNames)).toEqual({ label: "Lock screen timeout", before: "30", after: "60" })
  })

  it("lists a new policy and an added setting by their settings, whatever their size", () => {
    const created = diffConfigurations(type, null, policy([groupSetting(30, "1"), { settingInstance: choice("1") }])).entries
    expect(created).toHaveLength(1)
    expect(created[0]!.path).toBe("(object)")
    expect(created[0]!.after!.length).toBeLessThanOrEqual(163)
    expect(readableDiffEntry(created[0]!, groupNames)).toEqual({ label: "Policy settings", afterValues: { shown: ["Lock screen timeout: 30", "Lock screen mode: Locked", "Require Encryption: Enabled"], total: 3 } })
    const added = diffConfigurations(type, policy([groupSetting(30, "1")]), policy([groupSetting(30, "1"), { settingInstance: choice("1") }])).entries
    expect(added.map(entry => readableDiffEntry(entry, groupNames))).toEqual([{ label: "Require Encryption", afterValues: { shown: ["Require Encryption: Enabled"], total: 1 } }])
  })

  it("names the creator only when the first kept revision is the creation", () => {
    expect(changeSetCreator({ createdAt: "2026-10-15T11:00:00Z", history: [{ at: "2026-10-15T11:00:00Z", actor: "Ada Admin", reason: "Created a change set for review" }] })).toBe("Ada Admin")
    expect(changeSetCreator({ createdAt: "2026-10-15T11:00:00Z", history: [{ at: "2026-10-16T09:00:00Z", actor: "Later Operator", reason: "Applied" }] })).toBeNull()
    expect(changeSetCreator({ createdAt: "2026-10-15T11:00:00Z", history: [] })).toBeNull()
  })

  it("keeps letters of any script in file names", () => {
    expect(cisExportFileName({ reference: "intune-windows11 5.0.0 Level 1", part: "findings", tenantName: "Müller & Söhne", date: "2026-10-16", extension: "csv" })).toBe("CIS Microsoft Intune for Windows 11 5.0.0 L1 findings (Müller Söhne) 2026-10-16.csv")
    expect(prepareSaveFile("x", "CIS findings (Müller Söhne) 2026-10-16.csv").name).toBe("CIS findings (Müller Söhne) 2026-10-16.csv")
  })

  it("saves a workspace export larger than the renderer save limit from the main process", async () => {
    const data = new Map<string, string>()
    setFrameworkStore({ get: key => data.get(key) ?? null, set: (key, value) => { data.set(key, value) }, delete: key => { data.delete(key) } })
    setInternalCisBenchmarksEnabled(true)
    setNativeFrameworkAuthorization(async () => "pro")
    const pack: BaselinePolicy = { name: "Large policy", platforms: "windows10", technologies: "mdm", description: "Synthetic", provenance: { schemaVersion: 1, benchmark: "intune-windows11", version: "5.0.0", level: "Level 1", sourceFile: "l.json" }, settings: [{ settingInstance: choice("1") }] }
    // Two large observed values: a workspace below the 32,000,000 character limit whose export is above the 25,000,000 save limit.
    const big = (index: number) => ({ policyId: `00000000-0000-0000-0000-00000000000${index}`, policyName: `Tenant ${index}`, value: { ...choice("0"), note: "x".repeat(13_000_000) } })
    const assessment = { ...assessPolicySet({ tenantId, frameworkId: "cis-benchmarks", reference: "intune-windows11 5.0.0 Level 1", policies: [pack], current: [], runId: "run-large", assessedAt: "2026-10-10T12:00:00.000Z" }) }
    assessment.findings = assessment.findings.map(finding => ({ ...finding, status: "Different" as const, observed: [big(1), big(2)] as never }))
    recordAssessment(assessment, [pack])
    const saved: Array<{ name: string; size: number }> = []
    setFrameworkExportSaver(async file => { const prepared = prepareGeneratedFile(file.data, file.name, file.encoding); saved.push({ name: prepared.name, size: prepared.content.length }); return { saved: true, path: `/tmp/${prepared.name}` } })
    try {
      const answer = await handleFramework({ action: "workspace-json", frameworkId: "cis-benchmarks", tenantId, tenantName: "Contoso", save: "dialog" }) as { name: string; saved: boolean; path?: string; file?: unknown }
      expect(answer).toMatchObject({ saved: true, name: `CIS Benchmarks saved assessments (Contoso) ${localDate()}.json` })
      expect(answer.file).toBeUndefined()
      expect(saved[0]!.size).toBeGreaterThan(SAVE_FILE_LIMIT)
      // The renderer save path would have refused it.
      expect(() => prepareSaveFile("x".repeat(SAVE_FILE_LIMIT + 1), saved[0]!.name)).toThrow("The export could not be prepared.")
    } finally {
      setFrameworkExportSaver(null)
      setInternalCisBenchmarksEnabled(null)
    }
  }, 30_000)
})

describe("review round 2 of the flow polish", () => {
  const type = typeForFolder("ConfigurationPolicies")!
  const simple = (index: number) => ({ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: `synthetic_value_${index}`, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue", value: index } } })
  const created = (count: number) => diffConfigurations(type, null, { name: "Large", description: "", platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings: Array.from({ length: count }, (_, index) => simple(index)) } as unknown as Item).entries

  it("records every value of a 41 value policy, and says how many a longer one left out", () => {
    const small = created(41)
    expect(small[0]!.afterSettings).toHaveLength(41)
    expect(small[0]!.afterSettingsTotal).toBe(41)
    expect(omittedSettingValues(small)).toBe(0)
    expect(readableDiffEntry(small[0]!, names).afterValues).toMatchObject({ total: 41 })
    expect(readableDiffEntry(small[0]!, names).afterValues!.shown).toHaveLength(41)
    const large = created(MAX_SETTING_LEAVES + 1)
    expect(large[0]!.afterSettings).toHaveLength(MAX_SETTING_LEAVES)
    expect(large[0]!.afterSettingsTotal).toBe(MAX_SETTING_LEAVES + 1)
    expect(omittedSettingValues(large)).toBe(1)
  })

  it("looks up an option label with the whole option id of a long definition", () => {
    const id = `device_vendor_msft_policy_config_${"verylongsettingname".repeat(10)}`
    const option = `${id}_1`
    expect(option.length).toBeGreaterThan(160)
    const entries = diffConfigurations(type, null, { name: "Long", description: "", platforms: "windows10", technologies: "mdm", roleScopeTagIds: ["0"], settings: [{ settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: id, choiceSettingValue: { value: option, children: [] } } }] } as unknown as Item).entries
    expect(readableDiffEntry(entries[0]!, { settings: { [id]: "Long setting" }, options: { [option]: "Enabled" } }).afterValues!.shown).toEqual(["Long setting: Enabled"])
  })

  it("never saves a Windows device name or a trailing dot or space", () => {
    for (const name of ["CON", "con", "PRN", "AUX", "NUL", "COM1", "COM0", "LPT9", "COM\u00b9", "lpt\u00b2", "nul.backup"]) expect(prepareSaveFile("x", `${name}.csv`).name).toBe(`_${name}.csv`)
    expect(prepareSaveFile("x", "report. .csv").name).toBe("report.csv")
    expect(prepareSaveFile("x", "CONTOSO.csv").name).toBe("CONTOSO.csv")
    expect(prepareSaveFile("x", "COM10.csv").name).toBe("COM10.csv")
  })
})
