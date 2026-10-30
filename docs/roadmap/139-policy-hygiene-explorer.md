# Policy conflict and hygiene explorer (#139)

## What it does

Governance > Conflicts and hygiene (`/portal/governance/hygiene`), route `POST /api/hygiene`.
A scan reads the latest complete backup (status `Success`; without one, the newest backup
that completed with warnings, marked partial) through the app's own routes
(`/api/list-backups`, `/api/list-backup-contents`, `/api/restore-preview`), so local and Azure
storage behave the same. The findings describe the tenant at the backup's collection date,
which is shown with every scan and finding.

Rules (`src/main/features/hygiene/rules.ts`, pure):

| Rule ID | Detects | Classification |
| --- | --- | --- |
| `conflicting-setting` | Same Settings Catalog setting (top level choice or simple value, same platform) with different values | Definite when both policies include the same target (all devices, all users or the same group) with no filter and neither has exclusions; otherwise possible overlap |
| `duplicate-profile` | Objects of the same type with identical content apart from name, description, assignments and scope tags | Definite |
| `unassigned-policy` | Assignable policies with no assignments (default enrollment configurations and default branding left out) | Definite |
| `missing-filter` | Assignment filter IDs not among the collected filters | Definite, only when filters were collected |
| `missing-scope-tag` | Scope tag IDs other than Default (0) not among the collected scope tags | Definite, only when scope tags were collected |
| `missing-group` | Groups Graph reports as not existing (404) | Definite; 401 or 403 leaves every group unknown |
| `deprecated-setting` | Settings Catalog settings (any nesting level) that the current Settings Catalog marks deprecated, obsolete or "[to be deprecated]", or whose definition ID is no longer in the catalog | Definite for catalog wording (medium; low for to be deprecated); possible for an ID absent from a completely read catalog. Only when the catalog read succeeded in the same scan, otherwise unknown. Signal verified in `docs/roadmap/lokka-verification-deprecated-settings.md` |

Semantics that are preserved:

- A policy that includes a group another policy excludes is intentional targeting and never a
  conflict. Different groups, filters, exclusions or user versus device targeting only make an
  overlap possible.
- Types left out of the backup scope, skipped for permissions, failed or with unreadable files
  are listed as not collected and are not inspected. References into them are listed as
  checks that could not be made, never as findings and never as fine.
- Group membership, filter evaluation and device state are not collected. The app does not
  request Group.Read.All, so group existence is normally unknown.
- Evidence holds setting definition IDs, short display values (secret values are never shown)
  and SHA-256 hashes. Backup content is not copied into records.
- Deprecated findings have two dates: the backup's collection date (the policy content) and
  the scan's Settings Catalog check date (the catalog wording). The check date is stored on
  the scan record, not in finding evidence, so a rescan alone never reopens a reviewed
  finding. When the catalog cannot be read, the rule is unknown and earlier deprecated
  findings are not resolved by that scan.

Records (domain `hygiene-findings`, per tenant, ListedRecord fields plus history): one `scan`
record per scan (backup, collection date, coverage, unknowns, group resolution, catalog check) and one
`finding` record per fingerprint. A rescan updates the evidence; an acknowledged or false
positive finding whose evidence changed returns to open. A finding not detected in a scan that
covered its types becomes `resolved` ("Not detected"). Acknowledge takes an optional note;
false positive requires a reason; both keep the evidence and history. Nothing here changes or
deletes a policy.

## Plan boundary

- Community: existing drift comparison and basic validation elsewhere; this tab shows the
  locked preview. Stored findings from an earlier plan stay readable (`list`, `get`).
- Pro: `scan`, `acknowledge`, `mark-false-positive`, `reopen`.
- MSP: `portfolio-summary` (fleet summary with per customer counts and the open definite
  queue), reading only stored records of each named target tenant.

## Limits

- Conflicts are checked for Settings Catalog and endpoint security policies only. Collections
  (lists, grouped rules such as elevation rules) are left out because Intune merges them.
- Graph has no deprecation flag. Only the verified catalog wording counts (name says
  deprecated or obsolete, description says this policy or setting is deprecated, or starts
  "[to be deprecated]"); descriptions that mention a deprecated technology are never flagged.
  Deprecated does not prove a setting no longer applies, and no replacement is suggested.
  Legacy device configurations and Administrative Templates are not covered by this rule.
- Duplicates compare the collected JSON; intentional duplicates (staged migrations) need a
  false positive reason.
- Group checks are capped at 300 groups per scan.
- Scan records are not pruned; very long histories count towards the 2000 record limit.

## Graph calls

`GET groups/{id}?$select=id` (beta), verified with Lokka: 200 returns `{ id }`, a non existing
ID returns 404 `Request_ResourceNotFound`. Delegated reads need a group read scope the app
does not have, so 401 or 403 stops the checks and leaves groups unknown. Assignment target
shapes (`allDevicesAssignmentTarget`, `allLicensedUsersAssignmentTarget`,
`groupAssignmentTarget`, `exclusionGroupAssignmentTarget` with
`deviceAndAppManagementAssignmentFilterId` and `...FilterType`), Settings Catalog setting
instances and `roleScopeTags` (only `0` is built in) were verified with Lokka GETs.

`GET deviceManagement/configurationSettings?$select=id,displayName,description` (beta, no
`$top`: the service truncates with `$top` and returns every definition in one response
without it), verified with Lokka in `docs/roadmap/lokka-verification-deprecated-settings.md`,
including create-time catalog validation and the wording tiers the rule uses. The read needs
`DeviceManagementConfiguration.Read.All`; the setup script already grants the ReadWrite
variant, so no consent change. Any catalog read failure, including an empty answer, leaves
the deprecated settings check unknown for that scan.

## Manual verification

1. Pro tenant with at least one complete backup. Open Governance > Conflicts and hygiene and
   choose Scan latest backup. The scan shows the backup, collection date, types collected and
   not collected (Apps when the backup scope leaves them out) and group checks as unknown.
2. Create two test Settings Catalog policies with the same setting at different values,
   assign both to All devices, back up, scan: a definite conflict lists both values. Add a
   filter to one assignment, back up, scan: it becomes possible overlap.
3. Assign policy A to group G and policy B to All devices excluding G: no conflict finding.
4. Leave a policy unassigned and duplicate a profile: both appear as definite findings.
5. Mark a finding as false positive without a reason (refused), then with a reason. Change
   the policy, back up and scan: the finding reopens with the earlier review in its history.
6. Switch the tenant to Community: findings stay listed read-only; the scan button is gone
   and the API answers 402 for `scan`.
7. MSP with two licensed tenants: Load fleet summary shows each tenant separately; a tenant
   never scanned shows "Never scanned" and unknown counts.
8. Confirm no policy changed in Intune after these steps (the audit log shows no writes).
9. Deprecated settings: use a tenant whose backup contains a policy with a setting the
   catalog names deprecated (the lab's OIB Edge security policy qualifies). Scan: the scan
   summary shows the Settings Catalog check date and definition count, a definite
   "Deprecated settings" finding names the setting and its policies, and Governance >
   Overview needs attention lists the affected policies with a link that opens the hygiene
   tab filtered to the rule. Remove the setting from the policy in Intune, back up, scan:
   the finding is resolved.
10. Scan while signed out of the tenant (or with a token that cannot read the catalog): the
    scan shows the catalog as not checked, deprecated settings as a check that could not be
    made, and a previously open deprecated finding stays open.
