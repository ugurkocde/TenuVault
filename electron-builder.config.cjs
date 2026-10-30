/**
 * electron-builder configuration.
 *
 * Code signing turns on when the matching environment variables are present, so local
 * and pull request builds produce unsigned installers and release builds are signed:
 *   Windows: Azure Trusted Signing (AZURE_TRUSTED_SIGNING_* plus Azure credentials).
 *   macOS:   Developer ID certificate (CSC_LINK / CSC_KEY_PASSWORD) and notarization
 *            (APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER).
 *
 * @type {import("electron-builder").Configuration}
 */
const env = process.env

const azureSignOptions = env.AZURE_TRUSTED_SIGNING_ENDPOINT
  ? {
      publisherName: env.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME,
      endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT,
      codeSigningAccountName: env.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME,
      certificateProfileName: env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
    }
  : undefined

module.exports = {
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // Deliberately enabled: the packaged renderer is served with loadFile, and
    // disabling this fuse leaves the packaged app unable to boot (the welcome
    // screen never renders, proven by the packaged smoke test in CI). Turn it
    // off only together with moving the renderer to a custom protocol.
    grantFileProtocolExtraPrivileges: true,
  },
  appId: "com.tenuvault.desktop",
  productName: "TenuVault",
  copyright: "Copyright (c) Ugurlabs UG (haftungsbeschränkt)",
  directories: {
    output: "dist",
    buildResources: "build",
  },
  files: ["out/**/*", "package.json", "resources/tray*.png"],
  extraResources: [
    { from: "resources/framework-NOTICES.txt", to: "framework-NOTICES.txt" },
    { from: "resources/licenses", to: "licenses" },
    { from: "EULA.txt", to: "EULA.txt" },
  ],
  // Native modules cannot load from inside the asar archive.
  asarUnpack: ["**/*.node", "**/*.dll"],
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",

  win: {
    target: [
      { target: "nsis", arch: ["x64", "arm64"] },
      // MSI for deployment through Intune or Configuration Manager.
      { target: "msi", arch: ["x64"] },
    ],
    ...(azureSignOptions ? { azureSignOptions } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    // End user license agreement for official builds, shown before installation.
    license: "EULA.txt",
  },
  msi: {
    perMachine: true,
    oneClick: true,
    createDesktopShortcut: true,
  },

  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.business",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    // Unsigned local builds skip signing instead of failing.
    identity: env.CSC_LINK || env.CSC_NAME ? undefined : null,
    notarize: Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER),
  },
  // The window matches build/background.png (660x400; background@2x.png makes it sharp on Retina).
  // Icon positions are centres and must match scripts/render-dmg-background.py.
  dmg: {
    // Shown as the license agreement when the disk image is opened.
    license: "EULA.txt",
    title: "${productName} ${version}",
    window: { width: 660, height: 400 },
    iconSize: 128,
    contents: [
      { x: 180, y: 215, type: "file" },
      { x: 480, y: 215, type: "link", path: "/Applications" },
    ],
  },

  // Releases and the auto-update feed live in this repository's GitHub releases: stable builds
  // write latest.yml, nightly builds (TENUVAULT_RELEASE_CHANNEL=nightly) write nightly.yml.
  publish: {
    provider: "github",
    owner: "ugurkocde",
    repo: "TenuVault",
    releaseType: env.TENUVAULT_RELEASE_CHANNEL === "nightly" ? "prerelease" : "release",
    channel: env.TENUVAULT_RELEASE_CHANNEL === "nightly" ? "nightly" : "latest",
  },
}
