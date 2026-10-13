import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { readKitZip, suggestedKitBenchmark } from "../src/shared/frameworks/cis-kit"

describe("suggestedKitBenchmark", () => {
  it("derives id and version from folder paths", () => {
    expect(suggestedKitBenchmark(["FakebookOSv9.9.9/Settings Catalog/Level 1/x 9.9.9.json"])).toEqual({ id: "fakebook-os", version: "9.9.9" })
    expect(suggestedKitBenchmark(["FakebookOSv9.9.9/Settings Catalog/Level 1/a.json", "FakebookOSv9.9.9/Settings Catalog/Level 2/b.json"])).toEqual({ id: "fakebook-os", version: "9.9.9" })
  })

  it("derives id and version from a zip file name path", () => {
    expect(suggestedKitBenchmark(["FakebookOSv9.9.9.zip"])).toEqual({ id: "fakebook-os", version: "9.9.9" })
  })

  it("derives id from spaced names", () => {
    expect(suggestedKitBenchmark(["Fakebook OS v9.9.9/Level 1/x.json"])).toEqual({ id: "fakebook-os", version: "9.9.9" })
    expect(suggestedKitBenchmark(["Fakebook OS 9.9.9.zip"])).toEqual({ id: "fakebook-os", version: "9.9.9" })
  })

  it("returns an empty id when nothing usable can be derived", () => {
    expect(suggestedKitBenchmark([])).toEqual({ id: "" })
    expect(suggestedKitBenchmark([""])).toEqual({ id: "" })
    expect(suggestedKitBenchmark(["---.zip"])).toEqual({ id: "" })
  })
})

describe("readKitZip", () => {
  it("returns every non-directory entry as text", async () => {
    const zip = new JSZip()
    zip.folder("FakebookOSv9.9.9/Level 1")
    zip.file("FakebookOSv9.9.9/Level 1/x 9.9.9.json", "{\"name\":\"Fakebook\"}")
    zip.file("FakebookOSv9.9.9/notes.txt", "hello")
    const data = await zip.generateAsync({ type: "uint8array" })
    const files = await readKitZip(data)
    expect(files.map(file => file.path).sort()).toEqual(["FakebookOSv9.9.9/Level 1/x 9.9.9.json", "FakebookOSv9.9.9/notes.txt"])
    expect(files.find(file => file.path.endsWith("notes.txt"))?.content).toBe("hello")
  })

  it("rejects an oversized entry", async () => {
    const zip = new JSZip()
    zip.file("big.json", "x".repeat(8 * 1024 * 1024 + 1))
    const data = await zip.generateAsync({ type: "uint8array" })
    await expect(readKitZip(data)).rejects.toThrowError(/larger than 8 MB/)
  })
})
