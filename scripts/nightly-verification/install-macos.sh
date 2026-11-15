#!/usr/bin/env bash
# Installs a published macOS nightly as users get it and verifies its signature and notarization.
#
#   install-macos.sh <folder with the release's dmg and zip> [install folder, default /Applications]
#
# For this Mac's architecture: the disk image is mounted (its license agreement accepted), the app
# is copied to the install folder as a user drags it, and the code signature, the Developer ID
# authority, the stapled notarization ticket and Gatekeeper's assessment are checked. The update
# zip gets the same signature and staple checks. The installed executable is written to
# GITHUB_OUTPUT as `app` (or printed without GitHub Actions).
set -euo pipefail
downloads="$1"
target="${2:-/Applications}"
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "::error::Unsupported architecture $(uname -m)"; exit 1 ;;
esac
dmg=$(ls "$downloads"/*-mac-"$arch".dmg)
zip=$(ls "$downloads"/*-mac-"$arch".zip)
work=$(mktemp -d)

verify() {
  local app="$1"
  codesign --verify --deep --strict --verbose=2 "$app"
  local details
  details=$(codesign -dv --verbose=4 "$app" 2>&1)
  if ! grep -q '^Authority=Developer ID Application: ' <<< "$details"; then
    echo "::error::$app is not signed with a Developer ID Application certificate"; exit 1
  fi
  grep -E '^(Authority=Developer ID Application|TeamIdentifier)' <<< "$details"
  xcrun stapler validate "$app"
  local assessment
  assessment=$(spctl --assess --type execute --verbose=4 "$app" 2>&1) || { echo "$assessment"; echo "::error::Gatekeeper rejects $app"; exit 1; }
  echo "$assessment"
  if ! grep -q 'source=Notarized Developer ID' <<< "$assessment"; then
    echo "::error::Gatekeeper does not see $app as notarized"; exit 1
  fi
}

mkdir -p "$work/mount"
# The disk image shows the license agreement first; accept it as a user does.
printf "Y\n" | PAGER=cat hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$work/mount" "$dmg" > /dev/null
mkdir -p "$target"
rm -rf "$target/TenuVault.app"
ditto "$work/mount/TenuVault.app" "$target/TenuVault.app"
hdiutil detach "$work/mount" -quiet
echo "Installed $(basename "$dmg") to $target/TenuVault.app"
verify "$target/TenuVault.app"

mkdir -p "$work/zip"
ditto -x -k "$zip" "$work/zip"
verify "$work/zip/TenuVault.app"
rm -rf "$work"

app="$target/TenuVault.app/Contents/MacOS/TenuVault"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "app=$app" >> "$GITHUB_OUTPUT"; else echo "$app"; fi
