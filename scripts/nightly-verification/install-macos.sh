#!/usr/bin/env bash
# Installs a published macOS nightly as users get it and verifies its signature and notarization.
#
#   install-macos.sh <folder with the release's dmg and zip files> [install folder, default /Applications] [--require-all]
#
# For this Mac's architecture: the disk image is mounted (its license agreement accepted), the app
# is copied to the install folder as a user drags it, and the app is checked before anything runs
# it: the code signature, a Developer ID Application authority of TenuVault's team
# (EXPECTED_TEAM_ID), the stapled notarization ticket and Gatekeeper's assessment. The update zip
# gets the same checks. The other architecture's disk image and zip, when they are in the folder,
# get the same checks without being installed; with --require-all a missing one fails. The
# installed executable is written to GITHUB_OUTPUT as `app` (or printed without GitHub Actions).
set -euo pipefail

# The Apple Developer Team of TenuVault's Developer ID Application certificate (RELEASING.md,
# signing secrets). An app signed by any other team is refused.
EXPECTED_TEAM_ID=D259ULY2B4

downloads="$1"
target="${2:-/Applications}"
require_all="${3:-}"
case "$(uname -m)" in
  arm64) arch=arm64; other=x64 ;;
  x86_64) arch=x64; other=arm64 ;;
  *) echo "::error::Unsupported architecture $(uname -m)"; exit 1 ;;
esac
work=$(mktemp -d)
trap 'hdiutil detach "$work/mount" -quiet 2>/dev/null || true; rm -rf "$work"' EXIT

verify() {
  local app="$1"
  codesign --verify --deep --strict "$app"
  local details
  details=$(codesign -dv --verbose=4 "$app" 2>&1)
  if ! grep -q '^Authority=Developer ID Application: ' <<< "$details"; then
    echo "::error::$app is not signed with a Developer ID Application certificate"; exit 1
  fi
  local team
  team=$(sed -n 's/^TeamIdentifier=//p' <<< "$details")
  if [ "$team" != "$EXPECTED_TEAM_ID" ]; then
    echo "::error::$app is signed by team ${team:-none}, not TenuVault's $EXPECTED_TEAM_ID"; exit 1
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

mount() {
  mkdir -p "$work/mount"
  # The disk image shows the license agreement first; accept it as a user does.
  printf "Y\n" | PAGER=cat hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$work/mount" "$1" > /dev/null
}

verify_zip() {
  rm -rf "$work/zip"
  mkdir -p "$work/zip"
  ditto -x -k "$1" "$work/zip"
  verify "$work/zip/TenuVault.app"
  echo "Verified $(basename "$1")"
}

# Every published file must be there before anything is checked or installed.
if [ "$require_all" = --require-all ]; then
  for kind in dmg zip; do
    if ! ls "$downloads"/*-mac-"$other"."$kind" > /dev/null 2>&1; then
      echo "::error::The release has no $other $kind, which every release publishes."; exit 1
    fi
  done
fi
dmg=$(ls "$downloads"/*-mac-"$arch".dmg)
zip=$(ls "$downloads"/*-mac-"$arch".zip)

# The disk image's app is checked before it is copied, the copy again before anything runs it.
mount "$dmg"
verify "$work/mount/TenuVault.app"
mkdir -p "$target"
rm -rf "$target/TenuVault.app"
ditto "$work/mount/TenuVault.app" "$target/TenuVault.app"
hdiutil detach "$work/mount" -quiet
echo "Installed $(basename "$dmg") to $target/TenuVault.app"
verify "$target/TenuVault.app"
verify_zip "$zip"

# The other architecture's downloads, signature checks only.
for file in "$downloads"/*-mac-"$other".dmg; do
  [ -e "$file" ] || continue
  mount "$file"
  verify "$work/mount/TenuVault.app"
  hdiutil detach "$work/mount" -quiet
  echo "Verified $(basename "$file")"
done
for file in "$downloads"/*-mac-"$other".zip; do
  [ -e "$file" ] || continue
  verify_zip "$file"
done

app="$target/TenuVault.app/Contents/MacOS/TenuVault"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "app=$app" >> "$GITHUB_OUTPUT"; else echo "$app"; fi
