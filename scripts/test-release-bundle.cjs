const assert = require("node:assert/strict")
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { dirname, join } = require("node:path")
const { checkReleaseBundle } = require("./check-release-bundle.cjs")

checkReleaseBundle("out")
const lab = "out-lab"
assert.match(readFileSync(join(lab, "main/index.js"), "utf8"), /TV06-TEST-[a-z0-9-]+/i)
assert.throws(() => checkReleaseBundle(lab), /Lab build content found/)
const fixture = mkdtempSync(join(tmpdir(), "tv-release-guard-"))
try {
  for (const file of ["main/index.js", "preload/index.cjs", "renderer/index.html"]) {
    const path = join(fixture, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "")
  }
  checkReleaseBundle(fixture)
  for (const marker of ["__TV_LAB_BUILD__", "TENUVAULT_LAB_LICENSE_ORIGIN", "TENUVAULT_LAB_LICENSE_PUBLIC_KEY", "TV06-TEST-run-12f51c29-1e42-4e15-8079-68fb1f05535e", "tv06-test-RUN-12F51C29-1E42-4E15-8079-68FB1F05535E", "Lab build"]) {
    writeFileSync(join(fixture, "renderer/index.html"), marker)
    assert.throws(() => checkReleaseBundle(fixture), /Lab build content found/)
  }
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
console.log("Release grep passed and rejected the built lab bundle and injected lab markers.")
