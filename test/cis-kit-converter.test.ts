import { describe, expect, it } from "vitest"
import { classifyKitFile, convertKit, kitFileVersion, stripBom, type KitFile } from "../src/shared/frameworks/cis-kit"

const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (name: string, ids: string[], value = "fake-on") => JSON.stringify({
  name, platforms: "windows10", technologies: "mdm", description: "Synthetic fixture policy",
  settings: ids.map((settingDefinitionId, index) => ({ id: String(index), settingInstance: { "@odata.type": type, settingDefinitionId, choiceSettingValue: { value } } })),
})
const kit = (files: KitFile[], version?: string) => convertKit(files, { id: "fakebook-os", ...(version ? { version } : {}) })

describe("build kit conversion", () => {
  it("parses UTF-8 exports with a byte order mark", () => {
    expect(stripBom("\uFEFF{}")).toBe("{}")
    const result = kit([{ path: "Level 1/Fakebook Alpha 9.9.9.json", content: "\uFEFF" + policy("Fakebook Alpha", ["fakebook_setting_alpha"]) }])
    expect(result.packs).toHaveLength(1)
    expect(result.packs[0]?.policies[0]?.name).toBe("Fakebook Alpha")
  })

  it("classifies Level folders and L1 or L2 file name markers", () => {
    expect(classifyKitFile("Settings Catalog/Level 1/Fakebook Alpha.json")).toBe(1)
    expect(classifyKitFile("Settings Catalog/Level 2/Fakebook Beta.json")).toBe(2)
    expect(classifyKitFile("Policies/Fakebook (L1) Alpha.json")).toBe(1)
    expect(classifyKitFile("Policies/Fakebook (L2) Beta.json")).toBe(2)
    expect(classifyKitFile("Fakebook Benchmark L1+L2 v9.9.9.json")).toBe("combined")
    expect(classifyKitFile("Policies/Fakebook General.json")).toBe("unknown")
  })

  it("groups Device and User split files by their L1 or L2 marker", () => {
    const result = kit([
      { path: "Device-L1/Fakebook Device.json", content: policy("Fakebook Device", ["fakebook_setting_device"]) },
      { path: "User-L1/Fakebook User.json", content: policy("Fakebook User", ["fakebook_setting_user"]) },
      { path: "User-L2/Fakebook User Extra.json", content: policy("Fakebook User Extra", ["fakebook_setting_extra"]) },
    ], "9.9.9")
    expect(result.summary.levels).toEqual([{ level: 1, policies: 2, settings: 2 }, { level: 2, policies: 1, settings: 1 }])
    expect(result.packs[0]?.policies.map(item => item.provenance?.scope)).toEqual(["device", "user"])
  })

  it("stamps benchmark, version, level and source file provenance on every policy", () => {
    const result = kit([{ path: "Level 2/Fakebook Beta 9.9.9.json", content: policy("Fakebook Beta", ["fakebook_setting_beta"]) }])
    expect(result.packs[0]?.policies[0]?.provenance).toMatchObject({ benchmark: "fakebook-os", version: "9.9.9", level: "Level 2", sourceFile: "Fakebook Beta 9.9.9.json" })
    expect(kitFileVersion("Fakebook Beta 9.9.9.json")).toBe("9.9.9")
    expect(result.packs[0]?.reference).toContain("Level 2")
  })

  it("derives Level 2 only settings from an L1 and a combined L1+L2 pair", () => {
    const level1 = policy("Fakebook Combined", ["fakebook_setting_alpha", "fakebook_setting_beta"])
    const combined = JSON.stringify({ name: "Fakebook Combined", platforms: "windows10", technologies: "mdm", description: "Synthetic fixture policy",
      settings: [
        { settingInstance: { "@odata.type": type, settingDefinitionId: "fakebook_setting_alpha", choiceSettingValue: { value: "fake-stricter" } } },
        { settingInstance: { "@odata.type": type, settingDefinitionId: "fakebook_setting_beta", choiceSettingValue: { value: "fake-on" } } },
        { settingInstance: { "@odata.type": type, settingDefinitionId: "fakebook_setting_gamma", choiceSettingValue: { value: "fake-on" } } },
      ] })
    const result = kit([
      { path: "Fakebook Benchmark L1 v9.9.9.json", content: level1 },
      { path: "Fakebook Benchmark L1+L2 v9.9.9.json", content: combined },
    ])
    const derived = result.packs.find(pack => pack.level === 2)?.policies[0]
    expect(derived?.settings.map(setting => (setting.settingInstance as { settingDefinitionId: string }).settingDefinitionId)).toEqual(["fakebook_setting_alpha", "fakebook_setting_gamma"])
    expect(derived?.name).toContain("derived")
    expect(derived?.provenance).toMatchObject({ level: "Level 2", sourceFile: "Fakebook Benchmark L1+L2 v9.9.9.json" })
    expect(String(derived?.provenance?.derivation)).toContain("combined")
  })

  it("fails loudly when a combined file has no matching Level 1 file", () => {
    expect(() => kit([{ path: "Fakebook Benchmark L1+L2 v9.9.9.json", content: policy("Fakebook Combined", ["fakebook_setting_alpha"]) }]))
      .toThrowError(/L1\+L2 v9\.9\.9\.json.*Level 1/)
  })

  it("fails loudly, naming the file, when the level cannot be determined", () => {
    expect(() => kit([{ path: "Policies/Fakebook General 9.9.9.json", content: policy("Fakebook General", ["fakebook_setting_alpha"]) }]))
      .toThrowError(/Fakebook General 9\.9\.9\.json.*cannot be determined/)
  })

  it("reports PDFs and spreadsheets as skipped instead of dropping them", () => {
    const result = kit([
      { path: "Level 1/Fakebook Alpha 9.9.9.json", content: policy("Fakebook Alpha", ["fakebook_setting_alpha"]) },
      { path: "Fakebook Readme.pdf", content: "" },
      { path: "Fakebook Breakout.xlsx", content: "" },
      { path: "Fakebook Notes.txt", content: "" },
    ])
    expect(result.skipped.map(item => item.path)).toEqual(["Fakebook Readme.pdf", "Fakebook Breakout.xlsx", "Fakebook Notes.txt"])
    expect(result.summary.skipped[0]?.reason).toContain("PDF")
    expect(result.summary.skipped[1]?.reason).toContain("Spreadsheet")
  })

  it("rejects a JSON file that is not a Settings Catalog export, naming the file", () => {
    expect(() => kit([{ path: "Level 1/Fakebook Broken 9.9.9.json", content: JSON.stringify({ displayName: "Fakebook Broken" }) }]))
      .toThrowError(/Fakebook Broken 9\.9\.9\.json.*not a Settings Catalog export/)
    expect(() => kit([{ path: "Level 1/Fakebook Broken 9.9.9.json", content: "not json" }]))
      .toThrowError(/Fakebook Broken 9\.9\.9\.json/)
  })
})
