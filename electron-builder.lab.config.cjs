const { readFileSync } = require("node:fs")
const release = require("./electron-builder.config.cjs")
const version = JSON.parse(readFileSync("out-lab/main/version.json", "utf8"))
if (typeof version !== "string" || !/^\d+\.\d+\.\d+-lab\.\d{12}$/.test(version)) {
  throw new Error("Lab packaging requires a version from the dedicated lab build.")
}

// Keep lab artifacts unpacked and unsigned. The lab has no publish configuration.
module.exports = {
  publish: null,
  appId: "com.tenuvault.desktop.lab",
  productName: "TenuVault Lab",
  directories: { ...release.directories, output: "dist-lab" },
  files: ["out-lab/**/*", "package.json", "resources/tray*.png"],
  extraMetadata: { main: "out-lab/main/index.js", version },
  extraResources: release.extraResources,
  asarUnpack: release.asarUnpack,
  electronFuses: release.electronFuses,
  mac: { identity: null, notarize: false },
  win: { signAndEditExecutable: false, extraResources: release.win.extraResources },
  beforePack: () => {
    if (process.env.TENUVAULT_RELEASE_BUILD === "1" || !readFileSync("out-lab/main/index.js", "utf8").includes("com.tenuvault.desktop.lab")) {
      throw new Error("Lab packaging requires a dedicated lab bundle.")
    }
  },
}
