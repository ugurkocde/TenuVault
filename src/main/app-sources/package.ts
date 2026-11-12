import { inflateRawSync } from "node:zlib"
import { DOMParser } from "@xmldom/xmldom"
export interface PackageReader {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
}

async function readAt(file: PackageReader, length: number, position: number): Promise<Buffer> {
  const data = Buffer.alloc(length)
  for (let at = 0; at < length;) { const r = await file.read(data, at, length - at, position + at); if (!r.bytesRead) throw new Error("The package is truncated."); at += r.bytesRead }
  return data
}

/** Inspect the ZIP directory without buffering or extracting the installer. ZIP64 is deferred. */
export async function inspectIntunewin(file: PackageReader, size: number): Promise<void> {
  if (size < 22 || size > 2 * 1024 ** 3) throw new Error("Choose an .intunewin package smaller than 2 GiB.")
  const tailSize = Math.min(size, 65_557)
  const tail = await readAt(file, tailSize, size - tailSize)
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break }
  }
  if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error("This is not a supported .intunewin ZIP package.")
  const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16)
  if (!count || count > 10_000 || length > 4 * 1024 ** 2 || offset + length > size - tail.length + end) throw new Error("The package directory is invalid or uses unsupported ZIP64 packaging.")
  const directory = await readAt(file, length, offset)
  const seen = new Set<string>()
  let position = 0, metadata = false, content = false
  for (let i = 0; i < count; i++) {
    if (position + 46 > length || directory.readUInt32LE(position) !== 0x02014b50) throw new Error("The package directory is damaged.")
    const names = directory.readUInt16LE(position + 28), extra = directory.readUInt16LE(position + 30), comment = directory.readUInt16LE(position + 32)
    const next = position + 46 + names + extra + comment
    if (next > length) throw new Error("The package directory is damaged.")
    const name = directory.subarray(position + 46, position + 46 + names).toString("utf8").replaceAll("\\", "/")
    if (name.includes("\0") || name.includes(":") || name.startsWith("/") || name.split("/").includes("..")) throw new Error("The package contains an unsafe entry name.")
    const segments = name.split("/").filter(Boolean)
    if (segments.some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || seen.has(name.toLowerCase())) throw new Error("The package contains duplicate or unsupported entry names.")
    seen.add(name.toLowerCase())
    if (name.toLowerCase() === "intunewinpackage/metadata/detection.xml") {
      const compressed = directory.readUInt32LE(position + 20), expanded = directory.readUInt32LE(position + 24), local = directory.readUInt32LE(position + 42), method = directory.readUInt16LE(position + 10)
      if (compressed > 1024 ** 2 || expanded > 1024 ** 2 || local + 30 > size || directory.readUInt16LE(position + 8) & 1) throw new Error("The package metadata is too large or encrypted.")
      const header = await readAt(file, 30, local)
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("The package metadata header is invalid.")
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
      if (start + compressed > offset) throw new Error("The package metadata is invalid.")
      const bytes = await readAt(file, compressed, start)
      const xmlBytes = method === 0 ? bytes : method === 8 ? inflateRawSync(bytes, { maxOutputLength: 1024 ** 2 }) : null
      if (!xmlBytes || xmlBytes.length !== expanded) throw new Error("The package metadata compression is unsupported.")
      const xml = xmlBytes.toString("utf8")
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD and entity declarations are not allowed in package metadata.")
      const document = new DOMParser({ onError: () => { throw new Error("The package metadata XML is invalid.") } }).parseFromString(xml, "application/xml")
      if (document.documentElement?.nodeName !== "ApplicationInfo" || document.getElementsByTagName("EncryptionInfo").length !== 1) throw new Error("The package metadata is not an Intune package description.")
      metadata = true
    }
    content ||= /^intunewinpackage\/contents\/[^/]+\.intunewin$/i.test(name)
    position = next
  }
  if (position !== length || !metadata || !content) throw new Error("Choose an .intunewin package made with the Microsoft Content Prep Tool.")
}
