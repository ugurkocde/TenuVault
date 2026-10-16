/** Export formats the renderer may save through the native dialog, by file extension. */
const FORMATS = {
  csv: { label: "CSV", encoding: "utf8" },
  json: { label: "JSON", encoding: "utf8" },
  txt: { label: "Text", encoding: "utf8" },
  pdf: { label: "PDF", encoding: "base64" },
} as const

export type SaveFileFormat = keyof typeof FORMATS

/** Largest export accepted, in characters of the data sent over IPC. */
export const SAVE_FILE_LIMIT = 25_000_000

export interface PreparedFile {
  /** Sanitized file name with its extension. */
  name: string
  extension: SaveFileFormat
  label: string
  content: Buffer
}

/**
 * Checks an export sent by the renderer before the Save dialog opens: the extension picks the
 * format (CSV, JSON and text as UTF-8, PDF as base64 only), the size is capped and the file name
 * is reduced to safe characters. Throws on anything else.
 */
export function prepareSaveFile(data: unknown, fileName: unknown, encoding: unknown = "utf8"): PreparedFile {
  if (typeof data !== "string" || data.length > SAVE_FILE_LIMIT) throw new Error("The export could not be prepared.")
  return prepareFile(data, fileName, encoding)
}

/**
 * The same checks for an export the main process built itself, such as a framework export of a
 * saved workspace. It never crossed IPC, so the renderer size cap does not apply: a workspace may
 * hold more than that cap, and its export must stay possible before older assessments are removed.
 */
export function prepareGeneratedFile(data: string, fileName: string, encoding: "utf8" | "base64"): PreparedFile {
  return prepareFile(data, fileName, encoding)
}

function prepareFile(data: unknown, fileName: unknown, encoding: unknown): PreparedFile {
  if (typeof data !== "string") throw new Error("The export could not be prepared.")
  const raw = typeof fileName === "string" ? fileName : ""
  const extension = raw.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  if (!extension || !(extension in FORMATS)) throw new Error("This file type cannot be saved.")
  const format = FORMATS[extension as SaveFileFormat]
  if (encoding !== format.encoding) throw new Error("The export could not be prepared.")
  if (format.encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("The export could not be prepared.")
  const content = Buffer.from(data, format.encoding)
  if (extension === "pdf" && content.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("The export could not be prepared.")
  // Letters and digits of any script stay, so a tenant such as Müller keeps its name.
  const cleaned = raw.slice(0, -extension.length - 1).replace(/[^\p{L}\p{N}_ .()-]/gu, "_").trim().slice(0, 120).replace(/[. ]+$/, "")
  // Windows refuses device names as file names, with any extension and with superscript digits.
  const base = !cleaned ? "TenuVault export" : /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i.test(cleaned) ? `_${cleaned}` : cleaned
  return { name: `${base}.${extension}`, extension: extension as SaveFileFormat, label: format.label, content }
}
