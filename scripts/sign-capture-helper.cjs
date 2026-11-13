const { join } = require("node:path")

// extraResources copies the standalone helper outside app.asar. Sign that exact
// packaged copy for each Windows architecture before the installers are assembled.
module.exports = async function signCaptureHelper(context) {
  if (context.electronPlatformName !== "win32" || !context.packager.platformSpecificBuildOptions.azureSignOptions) return
  const helper = join(context.appOutDir, "resources", "app-backup", "TenuVault.Capture.exe")
  if (!await context.packager.signIf(helper)) throw new Error("The packaged Windows capture helper was not signed.")
}
