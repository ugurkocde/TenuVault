import assert from "node:assert/strict"
import test from "node:test"
import { caskFromAssets, dmgName, renderCask } from "./homebrew-cask.mjs"

const ARM = "a".repeat(64)
const INTEL = "b".repeat(64)
const assets = [
  { name: dmgName("1.2.3", "arm64"), digest: `sha256:${ARM}` },
  { name: dmgName("1.2.3", "x64"), digest: `sha256:${INTEL}` },
  { name: "TenuVault-1.2.3-win-x64.exe", digest: `sha256:${"c".repeat(64)}` },
]

test("the cask installs the release's disk image for each Mac architecture", () => {
  const cask = caskFromAssets("1.2.3", assets)
  assert.match(cask, /^cask "tenuvault" do$/m)
  assert.match(cask, /^  version "1\.2\.3"$/m)
  assert.match(cask, new RegExp(`arm:   "${ARM}"`))
  assert.match(cask, new RegExp(`intel: "${INTEL}"`))
  assert.match(cask, /releases\/download\/v#\{version\}\/TenuVault-#\{version\}-mac-#\{arch\}\.dmg/)
  assert.match(cask, /^  app "TenuVault\.app"$/m)
  assert.match(cask, /^  auto_updates true$/m)
})

test("the asset names match what the Release workflow publishes", () => {
  assert.equal(dmgName("1.2.3", "arm64"), "TenuVault-1.2.3-mac-arm64.dmg")
  assert.equal(dmgName("1.2.3", "x64"), "TenuVault-1.2.3-mac-x64.dmg")
})

test("a missing disk image digest stops the update", () => {
  assert.throws(() => caskFromAssets("1.2.3", assets.slice(1)), /no SHA-256 digest for TenuVault-1\.2\.3-mac-arm64\.dmg/)
})

test("only stable versions and real checksums are written", () => {
  assert.throws(() => renderCask({ version: "1.2.3-nightly.20261112", arm64: ARM, x64: INTEL }), /Not a stable version/)
  assert.throws(() => renderCask({ version: "1.2.3", arm64: "nope", x64: INTEL }), /Not a SHA-256 checksum/)
})
