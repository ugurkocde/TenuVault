# Reliability and verification scope

Updated 27 September 2026. This describes the implementation and its limits, not a
claim that every workflow has been exercised against a live tenant. See the
[README](../README.md), [framework assessment guide](frameworks.md),
[restore reliability guide](restore-reliability.md) and [recovery readiness guide](disaster-recovery.md).

## Restore behavior

- **Copy** creates a separate object, normally with a `[Restored]` prefix. Unsupported
  types remain blocked with a recovery explanation. Copies do not silently replace originals.
- **Replace in place** updates a supported existing object, skips an unchanged object,
  or recreates a missing object where creation is supported. Defaults that cannot be
  recreated can still reach supported replacement. Legacy unverified Azure snapshots
  cannot replace or revert live objects.
- **Assignments** require an explicit selection. Assignment replacement is unavailable
  for Autopilot profiles, Apple user enrollment profiles, terms and conditions and
  Intune roles. Split supported and unsupported types into separate operations.
- **Cross-tenant copies** are unassigned, reset scope tags and require target dependency
  mappings. Supported reviewed app/category mappings are checked in the target tenant;
  unresolved dependencies block creation. Installers and Apple credentials remain manual.
- A required follow-up failure is **partial**, retaining the created object ID. A scoped
  repair resumes eligible failed steps without repeating the successful create. Replacement
  repair rechecks live state. Unknown write outcomes require reconciliation, not blind replay.
- Retry targets come from failed/partial results. Successful and unchanged items are preserved.
  Read retries, explicit throttling and token refresh are bounded; ambiguous writes are journaled.

## Backups, history and scheduling

Local inventory failures remain visible and prevent destructive retention. Retention
runs only after complete backups. Legacy metadata is shown only when actually available;
missing duration, status and trigger remain unknown. Dashboard health uses successful
backups and the configured schedule; bulk completion refreshes health and history.

Audit exports and statistics cover the full query range. Events use immutable blobs.
Failed writes remain in the encrypted retry queue and are surfaced as pending; unreadable
history or queue counts are unavailable, not empty. Retry batches preserve concurrent events.

New Azure snapshots are plain JSON, protected by Azure encryption at rest and the storage
account's role assignments, so other machines read them without a recovery key. The recovery
key is needed only for backups on a device and for older Azure backups made before this change.
See [Encryption and recovery key](../docs-site/src/content/docs/security/encryption.md).
ZIP import requires a complete manifest-bearing export and review before encrypted local
storage. It preserves source identity, detects duplicates and makes no tenant changes.

Schedules execute in the app. Optional Windows tasks and macOS user agents relaunch it
while the user is logged in; this is not a logged-off service and does not promise to wake
sleeping hardware. See [background scheduling](background-backups.md).

## OpenIntuneBaseline and frameworks

The OpenIntuneBaseline section loads OIB packs from the resolved `main` commit, compares
and validates them read-only, and deploys selected policies. Deployments back up first
(optional for create-only runs, always enforced for in-place updates and drift fixes),
create policies unassigned or for a pilot group, and update outdated policies in place
without changing assignments. Runs retain created IDs and the previous version of updated
policies, so undo is scoped to what the run changed. It is distinct from Settings Catalog
framework gap analysis.
Frameworks report configuration and assignment evidence separately; device applicability,
enforcement and organizational compliance are not established by a matching policy.

## Current validation and known limits

Unit and integration fixtures cover payload construction, retries, partial outcomes,
recovery, encryption, paging, invalid selections and tenant isolation. CI runs typecheck,
build, smoke tests and Windows/macOS packaging for each PR. Test counts change with the
commit and are not a whole-product assurance claim. Consult that commit's CI results.

Live checks in this issue pass used read-only Lokka Graph **beta** calls for response
shapes, required fields, paging and errors. No live restore, enrollment, role-membership,
installer-upload or Apple-token changes were performed. Interactive authentication,
Conditional Access, OS login/restart behavior and production licensing configuration
require separate environment-specific verification.

Open operational limitations include [production licensing verification (#30)](https://github.com/ugurkocde/tenuvault-desktop/issues/30),
[release secret migration (#33)](https://github.com/ugurkocde/tenuvault-desktop/issues/33)
and the [security hardening tracker (#36)](https://github.com/ugurkocde/tenuvault-desktop/issues/36).
See [all open issues](https://github.com/ugurkocde/tenuvault-desktop/issues) for remaining defects.

## Historical verification

The review recorded in commit `42488bc29b8777e12bbe8e9a30c3fd358f5f877e`
(before this 26–27 September 2026 issue pass) described a temporary Lokka relay,
three unassigned lab policies, live copy creation and a Windows mini-PC smoke run.
It excluded real interactive sign-in/licensing, Azure data-plane access and native
tray/login behavior. Those are historical fixture results, not verification of the
current commit or every supported policy family. Earlier copy-only descriptions were
superseded by replacement and cross-tenant workflows.
