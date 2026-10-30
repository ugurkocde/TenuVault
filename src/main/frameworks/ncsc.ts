import { createHash } from "node:crypto"
import { NCSC_COMMIT, NCSC_REPOSITORY } from "../../shared/frameworks/catalog"
import { parsePolicies, type BaselinePolicy } from "../../shared/frameworks/policies"
import { readBytesCapped } from "../../shared/capped-body"

/**
 * UK NCSC Device Security Guidance configuration packs, loaded for comparison only.
 * Crown Copyright, Apache License 2.0. TenuVault fetches a fixed file list at a pinned
 * commit, checks each file against its reviewed SHA-256 and never accepts a source URL
 * from the renderer.
 */

const RAW = `https://raw.githubusercontent.com/ukncsc/Device-Security-Guidance-Configuration-Packs/${NCSC_COMMIT}/`
const FOLDER = "Microsoft/Windows/MDM/Configurations/SettingsCatalog/"
const MAX_FILE_BYTES = 1_000_000

export const NCSC_REFERENCE = "UK NCSC Device Security Guidance 2025 Windows Settings Catalog · 681e075"
export const NCSC_LICENSE = "Apache-2.0 · Crown Copyright · UK National Cyber Security Centre"
export const NCSC_LICENSE_URL = `${NCSC_REPOSITORY}/blob/${NCSC_COMMIT}/LICENSE`
const MODIFICATIONS = "Decoded from UTF-16; export metadata, IDs, assignments and scope tags removed for comparison"

/** The Settings Catalog exports at NCSC_COMMIT and the SHA-256 of their raw bytes, reviewed on 2026-09-30. */
export const NCSC_SETTINGS_CATALOG: Readonly<Record<string, string>> = {
  "2025-NCSC-ASR.json": "bd962026a1ad1bdb3f0c6de41f7836fb14a49b93e8eef3976e8202e6e29f6db4",
  "2025-NCSC-App-Control-for-Business.json": "82ec2b8eabbbf72414348d86d6589504bc049ec8d667d94ebaeff08b1a887700",
  "2025-NCSC-BitLocker.json": "e4c793fe2160a95646da7ba043473d25336babce15de632a3a0e3f1f2f260a0c",
  "2025-NCSC-Defender-Antivirus.json": "289a052bf1778d1e50a616127a7b9b1f85224601fba0c9858835229931c9c9db",
  "2025-NCSC-Defender.json": "049a13610f9984b5452da1b6e2d6f070d38dae86cf4528ab7e5a13f145509aed",
  "2025-NCSC-Device-Control.json": "4374b5a31ae149248293f20d3640f4560dfb3b33c45f54fda642c2ed57e9b7b6",
  "2025-NCSC-Edge.json": "b2e9a94ecd98ba9e13b2e8f7de9803f974fa80cb172bfea2cf965f3de40f09e6",
  "2025-NCSC-General.json": "5ceb5de8549b8edd30d29a14729226e4bd869d00358a3af806ad0a3c1a00b2b7",
  "2025-NCSC-Windows-Security-Experience.json": "e6b5f091679efb1f3edecf6ae414ccb503be3ebb445aba76737804ccacebf0ea",
}

/** NCSC content that is in the repository but outside what this comparison assesses, with the reason. */
export const NCSC_NOT_ASSESSED: ReadonlyArray<{ content: string; reason: string }> = [
  { content: "Windows endpoint security exports (Account Protection, Application Control)", reason: "Legacy endpoint security intent format; policy-pack comparison reads Settings Catalog policies only." },
  { content: "Windows Surface DFCI device configuration export", reason: "Legacy device configuration profile; not a Settings Catalog policy." },
  { content: "Windows AppLocker XML", reason: "Rule XML for custom configuration, not an Intune policy export." },
  { content: "Apple iOS and macOS guidance", reason: "Published as configuration profiles, scripts and CSV or Markdown, not in Intune policy format." },
  { content: "Android and ChromeOS guidance", reason: "Published as CSV and Markdown only, not in Intune policy format." },
]

export class NcscSourceError extends Error {}

/** Text of a pack file: UTF-16LE or UTF-8, with or without a byte order mark. Other encodings are rejected. */
export function decodePackFile(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) throw new NcscSourceError("Unsupported NCSC file encoding.")
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8"
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { throw new NcscSourceError("An NCSC file could not be decoded.") }
}

/** Source declaration retained with each loaded policy and in exports; it is not a signature. */
export function ncscProvenance(file: string, sha256: string) {
  return { schemaVersion: 1, publisher: "UK National Cyber Security Centre", source: `${NCSC_REPOSITORY}/blob/${NCSC_COMMIT}/${FOLDER}${encodeURIComponent(file)}`,
    commit: NCSC_COMMIT, version: "2025", profile: "Windows Settings Catalog", license: "Apache-2.0", copyright: "Crown Copyright",
    sha256, modifications: MODIFICATIONS, verification: "SHA-256 of the pinned source file checked at load; retained exports are not signed" }
}

/**
 * Parses one downloaded pack file. The bytes must match the reviewed hash for that file name,
 * so a changed or substituted upstream file fails the load instead of changing the comparison.
 */
export function parseNcscFile(file: string, bytes: Uint8Array): BaselinePolicy[] {
  const expected = NCSC_SETTINGS_CATALOG[file]
  if (!expected) throw new NcscSourceError("Unexpected NCSC pack file.")
  if (bytes.byteLength > MAX_FILE_BYTES) throw new NcscSourceError("An NCSC pack file exceeds the size limit.")
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (sha256 !== expected) throw new NcscSourceError(`${file} does not match the pinned NCSC source. No pack was loaded.`)
  let json: unknown
  try { json = JSON.parse(decodePackFile(bytes)) }
  catch (error) { throw error instanceof NcscSourceError ? error : new NcscSourceError(`${file} is not valid JSON.`) }
  return parsePolicies(json).map(policy => ({ ...policy, provenance: ncscProvenance(file, sha256) }))
}

export interface NcscPack { policies: BaselinePolicy[]; reference: string; source: string; license: string; licenseUrl: string; notAssessed: typeof NCSC_NOT_ASSESSED }

/** Downloads the pinned Windows Settings Catalog pack. Fails as a whole when any file cannot be fetched, verified or parsed. */
export async function loadNcsc(fetcher: typeof fetch = fetch): Promise<NcscPack> {
  const files = Object.keys(NCSC_SETTINGS_CATALOG)
  const policies: BaselinePolicy[] = []
  for (let i = 0; i < files.length; i += 4) {
    const chunk = await Promise.all(files.slice(i, i + 4).map(async file => {
      const response = await fetcher(`${RAW}${FOLDER}${encodeURIComponent(file)}`, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new NcscSourceError(`Request failed (${response.status}) for ${file}. No pack was loaded.`)
      // Capped while reading: a declared length can be absent or understated.
      const bytes = await readBytesCapped(response, MAX_FILE_BYTES)
      if (bytes === null) throw new NcscSourceError("An NCSC pack file exceeds the size limit.")
      return parseNcscFile(file, bytes)
    }))
    policies.push(...chunk.flat())
  }
  return { policies, reference: NCSC_REFERENCE, source: `${NCSC_REPOSITORY}/tree/${NCSC_COMMIT}`, license: NCSC_LICENSE, licenseUrl: NCSC_LICENSE_URL, notAssessed: NCSC_NOT_ASSESSED }
}
