import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { convertKit, kitFileVersion, KitConversionError, readKitZip, suggestedKitBenchmark } from "../src/shared/frameworks/cis-kit"

async function lyingHeaderZip(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("big.json", "x".repeat(9 * 1024 * 1024))
  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  view.setUint32(22, 10, true)
  for (let i = 0; i + 4 <= data.length; i++) if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 10, true)
  return data
}

function rawZip(entries: Array<{ name: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const content = encoder.encode(entry.content)
    const local = new Uint8Array(30 + name.length + content.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint32(18, content.length, true)
    localView.setUint32(22, content.length, true)
    localView.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(content, 30 + name.length)
    const header = new Uint8Array(46 + name.length)
    const centralView = new DataView(header.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint32(20, content.length, true)
    centralView.setUint32(24, content.length, true)
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, offset, true)
    header.set(name, 46)
    chunks.push(local)
    central.push(header)
    offset += local.length
  }
  const centralSize = central.reduce((total, item) => total + item.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  const data = new Uint8Array(offset + centralSize + end.length)
  let at = 0
  for (const chunk of [...chunks, ...central, end]) { data.set(chunk, at); at += chunk.length }
  return data
}

async function duplicateNameZip(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("dup1.json", "{\"name\":\"one\"}")
  zip.file("dup2.json", "{\"name\":\"two\"}")
  const data = await zip.generateAsync({ type: "uint8array", compression: "STORE" })
  const text = new TextDecoder("latin1").decode(data)
  let index = text.indexOf("dup2.json")
  while (index >= 0) { data[index + 3] = "1".charCodeAt(0); index = text.indexOf("dup2.json", index + 1) }
  return data
}

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

  it("finds a version in a mid-path folder segment", () => {
    expect(kitFileVersion("FakebookOS/9.9.9/Level 1/x.json")).toBe("9.9.9")
    expect(kitFileVersion("Kits/Release v9.9.9/Level 1/x.json")).toBe("9.9.9")
    expect(suggestedKitBenchmark(["FakebookOS/9.9.9/Level 1/x.json"])).toEqual({ id: "fakebook-os", version: "9.9.9" })
  })

  it("removes a version token appearing anywhere in the identity name", () => {
    expect(suggestedKitBenchmark(["Fakebook v9.9.9 OS/Level 1/x.json"])).toEqual({ id: "fakebook-os", version: "9.9.9" })
  })

  it("uses the zip file name as a hint when files sit at the archive root", () => {
    expect(suggestedKitBenchmark(["Level 1/x.json", "Level 2/y.json"], "FakebookOSv9.9.9.zip")).toEqual({ id: "fakebook-os", version: "9.9.9" })
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
    expect(files.find(file => file.path.endsWith("x 9.9.9.json"))?.content).toBe("{\"name\":\"Fakebook\"}")
    expect(files.find(file => file.path.endsWith("notes.txt"))?.content).toBe("")
  })

  it("rejects duplicate entry names from the central directory", async () => {
    await expect(readKitZip(await duplicateNameZip())).rejects.toBeInstanceOf(KitConversionError)
    await expect(readKitZip(await duplicateNameZip())).rejects.toThrowError(/dup1\.json/)
  })

  it("rejects duplicates that differ only by a leading dot segment", async () => {
    const data = rawZip([{ name: "same.json", content: "{}" }, { name: "./same.json", content: "{}" }])
    await expect(readKitZip(data)).rejects.toBeInstanceOf(KitConversionError)
    await expect(readKitZip(data)).rejects.toThrowError(/two entries named/)
  })

  it("rejects duplicates that differ only by a doubled separator", async () => {
    const data = rawZip([{ name: "a/b.json", content: "{}" }, { name: "a//b.json", content: "{}" }])
    await expect(readKitZip(data)).rejects.toBeInstanceOf(KitConversionError)
    await expect(readKitZip(data)).rejects.toThrowError(/two entries named/)
  })

  it("rejects duplicates that differ only by a dot segment in the path", async () => {
    const data = rawZip([{ name: "a/b.json", content: "{}" }, { name: "a/./b.json", content: "{}" }])
    await expect(readKitZip(data)).rejects.toBeInstanceOf(KitConversionError)
    await expect(readKitZip(data)).rejects.toThrowError(/two entries named/)
  })

  it("rejects duplicates that differ only by a dot dot segment in the path", async () => {
    const data = rawZip([{ name: "b.json", content: "{}" }, { name: "a/../b.json", content: "{}" }])
    await expect(readKitZip(data)).rejects.toThrowError(/two entries named/)
  })

  it("caps actual inflated bytes when the header understates the size", async () => {
    await expect(readKitZip(await lyingHeaderZip())).rejects.toBeInstanceOf(KitConversionError)
    await expect(readKitZip(await lyingHeaderZip())).rejects.toThrowError(/larger than 8 MB/)
  })

  it("accepts a large non-JSON entry with empty content", async () => {
    const zip = new JSZip()
    zip.file("FakebookOSv9.9.9/Level 1/x 9.9.9.json", "{\"name\":\"Fakebook\"}")
    zip.file("FakebookOSv9.9.9/guide.pdf", "x".repeat(9 * 1024 * 1024))
    const data = await zip.generateAsync({ type: "uint8array" })
    const files = await readKitZip(data)
    expect(files.find(file => file.path.endsWith("guide.pdf"))?.content).toBe("")
    expect(files.find(file => file.path.endsWith(".json"))?.content).toBe("{\"name\":\"Fakebook\"}")
  })

  it("rejects more than 2000 entries", async () => {
    const zip = new JSZip()
    for (let i = 0; i < 2001; i++) zip.file(`f${i}.json`, "{}")
    const data = await zip.generateAsync({ type: "uint8array" })
    await expect(readKitZip(data)).rejects.toThrowError(/too many files/)
  })

  it("throws when no policies could be converted at all", () => {
    expect(() => convertKit([{ path: "Fakebook Guide.pdf", content: "" }], { id: "fakebook-os", version: "9.9.9" })).toThrowError(KitConversionError)
    expect(() => convertKit([], { id: "fakebook-os", version: "9.9.9" })).toThrowError(/no convertible/)
  })

  it("rejects an oversized entry", async () => {
    const zip = new JSZip()
    zip.file("big.json", "x".repeat(8 * 1024 * 1024 + 1))
    const data = await zip.generateAsync({ type: "uint8array" })
    await expect(readKitZip(data)).rejects.toThrowError(/larger than 8 MB/)
  })
})
