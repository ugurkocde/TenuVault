const { readdirSync, readFileSync } = require("node:fs")
const { join } = require("node:path")
const { runInNewContext } = require("node:vm")

const labMarkers = /__TV_LAB_|TENUVAULT_LAB_|com\.tenuvault\.desktop\.lab|TenuVault Lab|Lab build/
const labFixture = /TV06-TEST-[a-z0-9-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const labVersion = /\b\d+\.\d+\.\d+-lab\b/i
// The backup schemas and setup tooling share scope names with restore. These markers belong
// only to the privileged restore adapters, temporary consent and cleanup.
const privilegedRestoreMarkers = /entra-app-metadata|entra-privileged|function directory9bIO\b|class AppMetadataAccess\b|Application restore uses a broad permission\./
const sourceFile = /\.(?:[cm]?js|json|html|map|css)$/

function checkPrivilegedRestoreOff(contents, path) {
  if (privilegedRestoreMarkers.test(contents)) throw new Error(`Privileged Entra restore path found in bundle: ${path}`)
}

function checkReleaseBundle(root, version = require("../package.json").version) {
  if (labVersion.test(version)) throw new Error("A lab version cannot be used for a release build.")
  const main = readFileSync(join(root, "main/index.js"), "utf8")
  for (const required of ["preload/index.cjs", "renderer/index.html"]) readFileSync(join(root, required))
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !sourceFile.test(entry.name)) continue
    const path = join(entry.parentPath, entry.name)
    const contents = readFileSync(path, "utf8")
    checkPrivilegedRestoreOff(contents, path)
    // Dispatch checks and the stable pack snapshot in test/final-scope.test.ts enforce the stable scope.
    if (contents.includes("expanded-entra-lab-scope")) throw new Error(`Expanded Entra scope found in release bundle: ${path}`)
    if (labMarkers.test(contents) || labFixture.test(contents) || labVersion.test(contents)) throw new Error(`Lab build content found in release bundle: ${path}`)
  }
  if (process.env.TENUVAULT_RELEASE_BUILD === "1") {
    const { checkLicensePublicKey, ROTATION_LICENSE_PUBLIC_KEYS } = require("./license-public-key.ts")
    if (!main.includes('const LICENSE_API_BASE = "https://www.tenuvault.com";')) {
      throw new Error("The release bundle must contain the production license origin.")
    }
    const serialized = main.match(/^const LICENSE_PUBLIC_KEYS = JSON\.parse\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\);$/m)?.[1]
    const keys = serialized ? JSON.parse(runInNewContext(serialized)) : null
    if (!Array.isArray(keys) || keys.length !== ROTATION_LICENSE_PUBLIC_KEYS.length + 1 ||
        ROTATION_LICENSE_PUBLIC_KEYS.some((key, index) => key !== keys[index + 1])) {
      throw new Error("The release bundle must contain the expected license verification keys.")
    }
    checkLicensePublicKey(keys[0], true)
  }
}

module.exports = { checkReleaseBundle, checkPrivilegedRestoreOff }

if (require.main === module) {
  checkReleaseBundle(process.argv[2] ?? "out")
  console.log("Release bundle contains no lab build markers or privileged Entra restore paths.")
}
