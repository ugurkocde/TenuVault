import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { computeCoverage, extractRecommendationIds, parseBreakoutWorkbook, parseDenominatorList, type BreakoutRow } from "../src/shared/frameworks/cis-coverage"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"

const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (name: string, description: string) => JSON.stringify({
  name, platforms: "windows10", technologies: "mdm", description,
  settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: "fakebook_setting_alpha", choiceSettingValue: { value: "fake-on" } } }],
})
const kitFiles: KitFile[] = [
  { path: "Level 1/Fakebook Alpha 9.9.9.json", content: policy("Fakebook Alpha", "Included:\n7.1.1\n7.9.9\nKit 9.9.9 exported 2024.1.15") },
  { path: "Level 2/Fakebook Beta 9.9.9.json", content: policy("Fakebook Beta", "Included:\n7.2.1") },
]
const converted = () => convertKit(kitFiles, { id: "fakebook-os", version: "9.9.9" })

const breakoutRows: BreakoutRow[] = [
  { identifier: "7.1.1", level: 1, buildKitName: "Fakebook Alpha" },
  { identifier: "7.1.2", level: 1, buildKitName: "Fakebook Alpha" },
  { identifier: "7.1.3", level: 1, buildKitName: "Manual" },
  { identifier: "7.2.1", level: 2, buildKitName: "Fakebook Beta" },
]

async function syntheticWorkbook(): Promise<Uint8Array> {
  const strings = ["Section #", "Recommendation #", "Profile", "Title", "GRID", "Build Kit Name",
    "7", "7.1.1", "Level 1 (L1)", "Invented title one", "FAKE-0001", "Fakebook Alpha",
    "7.1.2", "Invented title two", "FAKE-0002", "7.2.1", "Level 2 (L2)", "Fakebook Beta"]
  const index = (value: string) => strings.indexOf(value)
  const cell = (ref: string, value: string) => `<c r="${ref}" t="s"><v>${index(value)}</v></c>`
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
    + `<row r="1">${cell("A1", "Section #")}${cell("B1", "Recommendation #")}${cell("C1", "Profile")}${cell("D1", "Title")}${cell("E1", "GRID")}${cell("F1", "Build Kit Name")}</row>`
    + `<row r="2">${cell("A2", "7")}${cell("B2", "7.1.1")}${cell("C2", "Level 1 (L1)")}${cell("D2", "Invented title one")}${cell("E2", "FAKE-0001")}${cell("F2", "Fakebook Alpha")}</row>`
    + `<row r="3">${cell("A3", "7")}${cell("B3", "7.1.2")}${cell("C3", "Level 1 (L1)")}${cell("D3", "Invented title two")}${cell("E3", "FAKE-0002")}${cell("F3", "Fakebook Alpha")}</row>`
    + `<row r="4">${cell("A4", "7")}${cell("B4", "7.2.1")}${cell("C4", "Level 2 (L2)")}${cell("D4", "Invented title one")}${cell("E4", "FAKE-0001")}${cell("F4", "Fakebook Beta")}</row>`
    + `</sheetData></worksheet>`
  const shared = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">`
    + strings.map(value => `<si><t>${value}</t></si>`).join("") + `</sst>`
  const zip = new JSZip()
  zip.file("xl/sharedStrings.xml", shared)
  zip.file("xl/worksheets/sheet1.xml", sheet)
  return zip.generateAsync({ type: "uint8array" })
}

describe("recommendation identifier extraction", () => {
  it("extracts distinct dotted-decimal identifiers, sorted", () => {
    expect(extractRecommendationIds("Covers 7.1.1 and 7.1.2, again 7.1.1, plus 8.3", { kitVersion: "9.9.9" })).toEqual(["7.1.1", "7.1.2", "8.3"])
  })

  it("excludes the kit version token and export timestamps", () => {
    expect(extractRecommendationIds("Kit 9.9.9 exported 2024.1.15, covers 7.1.1", { kitVersion: "9.9.9" })).toEqual(["7.1.1"])
    expect(extractRecommendationIds("Kit 9.9.9 covers 7.1.1")).toEqual(["7.1.1", "9.9.9"])
  })

  it("never takes part of a prefixed version or a longer token as an identifier", () => {
    expect(extractRecommendationIds("Converted from the synthetic benchmark v9.9.9.\n\nSettings only.", { kitVersion: "9.9.9" })).toEqual([])
    expect(extractRecommendationIds("Build 7.1.1a and rule L2.3.4, covers 7.1.2.", { kitVersion: "9.9.9" })).toEqual(["7.1.2"])
    expect(extractRecommendationIds("(7.1.1), 7.1.3: and 8.2.", { kitVersion: "9.9.9" })).toEqual(["7.1.1", "7.1.3", "8.2"])
  })
})

describe("breakout workbook parsing", () => {
  it("extracts only identifier, profile level and build kit name from sheet XML in a zip", async () => {
    const rows = await parseBreakoutWorkbook(await syntheticWorkbook())
    expect(rows).toEqual([
      { identifier: "7.1.1", level: 1, buildKitName: "Fakebook Alpha" },
      { identifier: "7.1.2", level: 1, buildKitName: "Fakebook Alpha" },
      { identifier: "7.2.1", level: 2, buildKitName: "Fakebook Beta" },
    ])
    expect(JSON.stringify(rows)).not.toContain("Invented title")
    expect(JSON.stringify(rows)).not.toContain("FAKE-0001")
  })

  it("rejects a workbook without the expected columns", async () => {
    const zip = new JSZip()
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Other</t></is></c></row></sheetData></worksheet>`)
    await expect(parseBreakoutWorkbook(await zip.generateAsync({ type: "uint8array" }))).rejects.toThrowError(/no sheet/)
  })
})

describe("denominator list parsing", () => {
  it("accepts identifier, level and automated entries", () => {
    expect(parseDenominatorList(JSON.stringify([{ identifier: "7.1.1", level: 1, automated: true }]))).toEqual([{ identifier: "7.1.1", level: 1, automated: true }])
  })

  it("rejects malformed entries", () => {
    expect(() => parseDenominatorList(JSON.stringify([{ identifier: "7.1.1", level: 3, automated: true }]))).toThrowError(/entry 1/)
    expect(() => parseDenominatorList("{}")).toThrowError(/array/)
  })
})

describe("coverage computation", () => {
  it("computes the authoritative ratio, extra identifiers and the discrepancy class", () => {
    const result = converted()
    const report = computeCoverage({
      benchmark: "fakebook-os", version: "9.9.9", packs: result.packs, breakout: breakoutRows,
      denominator: parseDenominatorList(JSON.stringify([
        { identifier: "7.1.1", level: 1, automated: true },
        { identifier: "7.1.2", level: 1, automated: true },
        { identifier: "7.1.3", level: 1, automated: false },
        { identifier: "7.2.1", level: 2, automated: true },
        { identifier: "7.2.2", level: 2, automated: true },
      ])),
    })
    const level1 = report.levels.find(level => level.level === 1)!
    expect(level1.denominatorSource).toBe("authoritative")
    expect(level1.denominator).toBe(2)
    expect(level1.numerator).toBe(1)
    expect(level1.coverage).toBe(0.5)
    expect(level1.numeratorIds).toEqual(["7.1.1"])
    expect(level1.notInDenominatorIds).toEqual(["7.9.9"])
    expect(level1.mappedNotEnumeratedIds).toEqual(["7.1.2"])
    const level2 = report.levels.find(level => level.level === 2)!
    expect(level2.denominator).toBe(2)
    expect(level2.numerator).toBe(1)
    expect(level2.coverage).toBe(0.5)
  })

  it("uses the breakout manual bucket as an illustrative proxy without a denominator list", () => {
    const result = converted()
    const report = computeCoverage({ benchmark: "fakebook-os", version: "9.9.9", packs: result.packs, breakout: breakoutRows })
    const level1 = report.levels.find(level => level.level === 1)!
    expect(level1.denominatorSource).toBe("breakout-proxy")
    expect(level1.proxy).toEqual({ total: 3, manual: 1, automatedProxy: 2 })
    expect(level1.denominator).toBe(2)
    expect(level1.numerator).toBe(1)
    expect(level1.coverage).toBe(0.5)
    expect(level1.mappedNotEnumeratedIds).toEqual(["7.1.2"])
  })

  it("labels the ratio not computable without a denominator or a breakout", () => {
    const result = converted()
    const report = computeCoverage({ benchmark: "fakebook-os", version: "9.9.9", packs: result.packs })
    const level1 = report.levels.find(level => level.level === 1)!
    expect(level1.denominatorSource).toBe("none")
    expect(level1.denominator).toBeNull()
    expect(level1.coverage).toBeNull()
    expect(level1.enumeratedIds).toEqual(["7.1.1", "7.9.9"])
    expect(level1.numerator).toBe(2)
  })
})
