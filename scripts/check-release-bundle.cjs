const { readdirSync, readFileSync } = require("node:fs")
const { join } = require("node:path")

const labMarkers = /__TV_LAB_|TENUVAULT_LAB_|TV06-TEST-[a-z0-9-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|com\.tenuvault\.desktop\.lab|TenuVault Lab|Lab build/
const sourceFile = /\.(?:[cm]?js|json|html|map|css)$/

function checkReleaseBundle(root) {
  const main = readFileSync(join(root, "main/index.js"), "utf8")
  for (const required of ["preload/index.cjs", "renderer/index.html"]) readFileSync(join(root, required))
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !sourceFile.test(entry.name)) continue
    const path = join(entry.parentPath, entry.name)
    if (labMarkers.test(readFileSync(path, "utf8"))) throw new Error(`Lab build content found in release bundle: ${path}`)
  }
  if (process.env.TENUVAULT_RELEASE_BUILD === "1") {
    const { checkLicensePublicKey, ROTATION_LICENSE_PUBLIC_KEYS } = require("./license-public-key.ts")
    if (!main.includes('const LICENSE_API_BASE = "https://www.tenuvault.com";')) {
      throw new Error("The release bundle must contain the production license origin.")
    }
    const keys = JSON.parse(main.match(/^const LICENSE_PUBLIC_KEYS = (\[.*\]);$/m)?.[1] ?? "null")
    if (!Array.isArray(keys) || keys.length !== ROTATION_LICENSE_PUBLIC_KEYS.length + 1 ||
        ROTATION_LICENSE_PUBLIC_KEYS.some((key, index) => key !== keys[index + 1])) {
      throw new Error("The release bundle must contain the expected license verification keys.")
    }
    checkLicensePublicKey(keys[0], true)
  }
}

module.exports = { checkReleaseBundle }

if (require.main === module) {
  checkReleaseBundle(process.argv[2] ?? "out")
  console.log("Release bundle contains no lab build markers.")
}
