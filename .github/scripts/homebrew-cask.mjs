// Renders the Homebrew cask for a stable release: `brew install ugurkocde/UgurLabs/tenuvault`.
// The checksums come from the digests GitHub recorded for the release's disk images.
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { assetDigest } from "./store-blob.mjs"

export const dmgName = (version, arch) => `TenuVault-${version}-mac-${arch}.dmg`

export function renderCask({ version, arm64, x64 }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a stable version: ${version}`)
  for (const sha of [arm64, x64]) if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error(`Not a SHA-256 checksum: ${sha}`)
  return `# Updated by the Release workflow of ugurkocde/TenuVault on every stable release.
cask "tenuvault" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${arm64}",
         intel: "${x64}"

  url "https://github.com/ugurkocde/TenuVault/releases/download/v#{version}/TenuVault-#{version}-mac-#{arch}.dmg",
      verified: "github.com/ugurkocde/TenuVault/"
  name "TenuVault"
  desc "Back up and restore Microsoft Intune configuration"
  homepage "https://www.tenuvault.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TenuVault.app"
end
`
}

export function caskFromAssets(version, assets) {
  return renderCask({
    version,
    arm64: assetDigest(assets, dmgName(version, "arm64")),
    x64: assetDigest(assets, dmgName(version, "x64")),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, assetsPath] = process.argv.slice(2)
  process.stdout.write(caskFromAssets(version, JSON.parse(readFileSync(assetsPath, "utf8"))))
}
