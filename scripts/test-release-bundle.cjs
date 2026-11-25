const assert = require("node:assert/strict")
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { dirname, join } = require("node:path")
const { checkReleaseBundle, checkPrivilegedRestoreOff } = require("./check-release-bundle.cjs")

const lab = "out-lab"
if (!["main/version.json", "main/index.js", "preload/index.cjs", "renderer/index.html"].every(file => existsSync(join(lab, file)))) {
  console.error("Lab build is missing or incomplete. Run npm run build:lab before npm run test:release-bundle.")
  process.exit(1)
}
checkReleaseBundle("out")
assert.throws(() => checkReleaseBundle("out", "0.6.0-lab.202611241530"), /lab version cannot be used/)
const version = JSON.parse(readFileSync(join(lab, "main/version.json"), "utf8"))
assert.match(version, /^0\.6\.0-lab\.\d{12}$/)
assert.equal(require("../electron-builder.lab.config.cjs").extraMetadata.version, version)
const labMain = readFileSync(join(lab, "main/index.js"), "utf8")
assert.match(labMain, /TV06-TEST-[a-z0-9-]+/i)
checkPrivilegedRestoreOff(labMain, lab)
assert.throws(() => checkReleaseBundle(lab), /Lab build content found/)
const fixture = mkdtempSync(join(tmpdir(), "tv-release-guard-"))
try {
  for (const file of ["main/index.js", "preload/index.cjs", "renderer/index.html"]) {
    const path = join(fixture, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "")
  }
  checkReleaseBundle(fixture)
  writeFileSync(join(fixture, "main/index.js"), 'const restorePack = "entra-app-metadata"')
  assert.throws(() => checkReleaseBundle(fixture), /Privileged Entra restore path found/)
  writeFileSync(join(fixture, "main/index.js"), "")
  writeFileSync(join(fixture, "renderer/index.html"), "expanded-entra-lab-scope")
  assert.throws(() => checkReleaseBundle(fixture), /Expanded Entra scope found/)
  for (const marker of ["__TV_LAB_BUILD__", "TENUVAULT_LAB_LICENSE_ORIGIN", "TENUVAULT_LAB_LICENSE_PUBLIC_KEY", "TV06-TEST-run-12f51c29-1e42-4e15-8079-68fb1f05535e", "tv06-test-RUN-12F51C29-1E42-4E15-8079-68FB1F05535E", "Lab build", version]) {
    writeFileSync(join(fixture, "renderer/index.html"), marker)
    assert.throws(() => checkReleaseBundle(fixture), /Lab build content found/)
  }
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
console.log("Release grep passed and rejected the built lab bundle and injected lab markers.")
