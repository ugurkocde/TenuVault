/**
 * Copy to Tenants was called Sync before. Runs, change sets and plan findings stored by an
 * earlier version keep the text they were written with; these rewrite the generated parts of
 * that text for display, so the stored records stay as they are. Tenant and policy names inside
 * the text are carried over verbatim.
 */

/** A run, change set or rollback title the earlier version generated: only its prefix changes. */
export function copyTitle(title: string): string {
  return title.replace(/^(Rollback of )?Sync (\d+ polic(?:y|ies) from )/, "$1Copy $2")
}

// Generated messages; a stored error may join several, so each whole sentence matches anywhere.
// A name group is lazy and anchored by the fixed text after it, so a name with quotes still matches.
const MESSAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Already in sync, nothing to write\.$/, "Already up to date, nothing to write."],
  [/^(\d+ of \d+ targets? planned), (\d+) already in sync((?:, \d+ blocked by findings)?(?:; \d+ could not be planned)?\.)$/, "$1, $2 already up to date$3"],
  [/(".*?", which an earlier )Sync( wrote ".*?" to, no longer exists in this tenant\. This )Sync( creates a new policy\.)/g, "$1copy$2copy$3"],
  [/An earlier sync of (".*?") to this tenant has an unconfirmed result\. Syncing again may create a second copy\. Retry that sync first so TenuVault can check\./g, "An earlier copy of $1 to this tenant has an unconfirmed result. Copying again may create a second policy. Retry that copy first so TenuVault can check."],
  [/The Sync links this plan relied on for (".*?") were not recorded\. Plan again\./g, "The copy links this plan relied on for $1 were not recorded. Plan again."],
  [/Another Sync (wrote|linked) (".*?") (to this tenant after this plan, so applying it would create a second policy|to a different policy in this tenant after this plan)\. Plan again\./g, "Another copy $1 $2 $3. Plan again."],
]

/** A summary, finding, warning or error the earlier version generated. */
export function copyMessage(text: string): string {
  return MESSAGES.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
}

/** The title of a change set, rewritten only when Copy to Tenants created it (rollbacks keep that origin). */
export function changeSetTitle(changeSet: { title: string; origin?: { workflow: string } | null }): string {
  return changeSet.origin?.workflow === "sync" ? copyTitle(changeSet.title) : changeSet.title
}
