/**
 * Copy to Tenants was called Sync before. Runs, change sets and plan findings stored by an
 * earlier version keep the text they were written with; this rewrites the generated parts of
 * that text for display, so the stored records stay as they are.
 */
const LEGACY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Sync (\d+ polic(?:y|ies) from )/, "Copy $1"],
  [/^Already in sync, nothing to write\.$/, "Already up to date, nothing to write."],
  [/, (\d+) already in sync\b/, ", $1 already up to date"],
  [/, which an earlier Sync wrote "/, ', which an earlier copy wrote "'],
  [/ This Sync creates a new policy\.$/, " This copy creates a new policy."],
  [/^An earlier sync of "(.*)" to this tenant has an unconfirmed result\. Syncing again may create a second copy\. Retry that sync first so TenuVault can check\.$/, 'An earlier copy of "$1" to this tenant has an unconfirmed result. Copying again may create a second policy. Retry that copy first so TenuVault can check.'],
]

export function copyWording(text: string): string {
  return LEGACY.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
}
