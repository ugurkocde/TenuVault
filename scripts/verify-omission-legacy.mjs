import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"

const require = createRequire(import.meta.url)
const { extractFile } = require("@electron/asar")
const JSZip = require("jszip")
const archive = process.argv[2]
if (!archive) throw new Error("Pass app.asar from the signed TenuVault 0.5.3 release")

const main = extractFile(archive, "out/main/index.js").toString()
const packaged = JSON.parse(extractFile(archive, "package.json"))
assert.equal(packaged.version, "0.5.3")
const functions = [
  "validPolicyPath", "typeForFolder", "checkRestoreManifest", "incompleteReason", "backupManifest",
  "manifestStatus", "stoppedEarly", "compareBackups", "itemsOf", "coveredFolders", "sameItem",
  "reviewArchive", "inspectDirectory",
]
const code = functions.map((name) => {
  const source = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, "m").exec(main)
  assert(source, `Missing packaged function ${name}`)
  return source[0]
}).join("\n")
const folder = "DeviceConfigurations"
const type = { folder }
const strings = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
const old = runInNewContext(`${code}\n({ validPolicyPath, checkRestoreManifest, compareBackups, reviewArchive })`, {
  INTUNE_TYPES: [type],
  LEGACY_FOLDERS: [folder],
  TYPE_BY_FOLDER: new Map([[folder.toLowerCase(), type]]),
  strings$3: strings,
  metadataStrings: strings,
  MAX: 128 * 1024 * 1024,
  MAX_BACKUP_ARCHIVE_FILES: 10000,
  JSZip,
})

const backupId = "backup-2026-11-20-180000"
const file = "Omitted.json"
const projected = `.omitted/${folder}/${file}`
const eligible = `${folder}/Eligible.json`
const policy = { file, hash: "projection-hash", rawHash: "raw-hash", omitted: [{ path: "/omaSettings/0/value", reason: "encrypted-oma" }] }
const metadata = {
  BackupFolder: backupId, Status: "Success", Failures: 0, OmissionVersion: 1, ActualSkippedTypes: [], SkippedTypes: [folder],
  Items: { [`${folder}/omitted`]: policy, [`${folder}/eligible`]: { file: "Eligible.json", hash: "other-hash" } },
}
const before = { ...metadata, SkippedTypes: [], Items: { ...metadata.Items, [`${folder}/omitted`]: { file, hash: "old-unfiltered-hash" } } }
const blobNames = new Set([`${backupId}/${projected}`, `${backupId}/${eligible}`])
assert.equal(old.validPolicyPath(`${backupId}/${projected}`, backupId), false)
assert.equal(old.validPolicyPath(`${backupId}/${folder}/${file}`, backupId), true)
assert.equal(blobNames.has(`${backupId}/${folder}/${file}`), false)
const listed = [...blobNames].filter((path) => old.validPolicyPath(path, backupId))
assert.match(old.checkRestoreManifest(metadata, backupId, listed, true).error, /1 file\(s\).* missing/)
assert.equal(old.checkRestoreManifest(metadata, backupId, listed, false).ok, true)
assert.equal(old.compareBackups(before, metadata).length, 0)
assert.equal(old.compareBackups(metadata, before).length, 0)
const zip = new JSZip()
zip.file(projected, '{"id":"omitted"}')
await assert.rejects(old.reviewArchive(await zip.generateAsync({ type: "nodebuffer" })), /unsupported file/)
console.log("0.5.3 packaged guards rejected the projected path, full restore and ZIP. Both comparison directions excluded the affected type.")
