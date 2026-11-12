# App Backup: application, UI, and UX integration

## Revision 9: App Backup is completely free

On 2026-11-12, Ugur explicitly decided that **App Backup is completely free**. This supersedes all earlier App Backup billing, entitlement, Community-slot and pricing assumptions in this document and its review history. Attach, local storage, reconnect, list, export and device checks have no product-license requirement, including for configured tenants outside license coverage and after expiry. Local source operations work while signed out. Future App Backup recovery, upload, worker, batch and scheduling capabilities are also free when implemented; pricing is not an unresolved decision. App Backup routes and commands must use explicit authorization policies without paid feature or Community tenant selection gates. Microsoft authentication/permissions, tenant isolation, requester authorization, approvals, R0 protocol/terms clearance and a fresh signed kill switch still apply where relevant. The kill-switch channel must be available independently of a paid entitlement. Existing backup/restore workflows outside App Backup retain their own access policies.

## Revision 8: authorized first implementation PR

On 2026-11-12, Ugur requested council review of the two recovery-spike fixes and starting the helper/UI implementation in a PR. The approved first slice is local encrypted `.intunewin` attach/list/exact export and reconnect, plus a **read-only recovery device check** and a pure challenge-bound request-validation library. This explicitly permits those foundations before R0. It does not authorize a release or infer legal/terms clearance. No elevated or signed helper, authenticated transport, private-protocol adapter, gateway/CDN call, or recovery-start route is part of product code in this PR. Recovery stays unavailable; stored export stays accessible without entitlement or live sign-in, and, as superseded by revision 9, adding new sources is also free. Catalog manifests live beside encrypted artifacts and TVK2 plus reconnect can rebuild them. Live coverage, source ZIP/folder export, Azure stores, pins, upload, restore integration and full durable job history remain later milestones; this PR does not claim milestone 2a or R0 completion.


Date: 2026-11-12. Revision 7: applies the council reviews of revisions 3 to 6 (rounds 1 to 4) (Claude Opus 5.5, GPT-6.1 Sol, Muse Wonder Full 1.0). Keeps the user's revision 3 decisions (separate App Backup sidebar feature, recovery of existing packages from Intune in scope) and the Community single-app upload decision. Revisions 4 to 7 add no features; they add gates, per-milestone exit criteria and corrections, and moves work later. Planning only, no product implementation or tenant writes.

This plan covers four connected workflows: recover an existing package from Intune, capture during upload, attach existing sources, and restore using a stored installer. It builds on `app-sources-plan-2026-11-11.md`, which stays unchanged as historical input.

## Product decision

Create a tenant-scoped **App Backup** top-level sidebar feature immediately after **Backup & Restore**. Page title: **Win32 app backup**. Description: **Keep installers, source files, and Intune settings together.** User-facing copy inside the feature says "Win32 apps" consistently; the sidebar label stays **App Backup**. Recovering existing content from Intune remains a committed workflow, alongside attaching sources, retaining uploads, exporting to a folder/share, and restoring Win32 apps. It ships as its own gated track (R0, then milestone 3) and does not block the attach/export foundation. Until recovery passes its gates and has measured reach, **Attach source** is the primary action. Source storage and metadata backups remain distinct, connected by immutable references.

The primary promise is: **Keep the installer with the settings needed to restore the app.** Do not promise that metadata-only backups contain installers or that an admin-attached package has been proven identical to Intune's current package.

Input can come from an administrator, TenuVault's documented Graph upload flow, or the enrolled Windows recovery path, demonstrated in the mini PC experiment for two device-targeted apps. Recovery is now explicitly in scope. Its private client protocol has a separate adapter and release gates; documented Graph remains the metadata/upload route. Do not imply that Graph can download committed content or that the lab has validated every targeting scenario. Describe the mechanism honestly: the helper "uses this device's own Intune enrollment to request content, as the Intune Management Extension does." That is acting as the IME client with the device's identity; do not describe it as "no impersonation". No bearer-token acquisition for first-party client IDs and no token-cache scraping are part of this design. The current product docs and registry blocker say "Intune does not let apps download installer files" ([limitations.md:6](docs-site/src/content/docs/restore/limitations.md), [registry.ts:680](src/shared/intune/registry.ts)); any recovery release must update that wording in the same PR, with the R0-approved phrasing.

## Existing integration points

| Surface | Current behavior | Planned change |
| --- | --- | --- |
| `src/renderer/components/DesktopLayout.tsx`, `src/renderer/App.tsx` | Sidebar and desktop routes | Add App Backup immediately after Backup & Restore, with dedicated routes and page |
| `src/portal/app/portal/backup/page.tsx` | URL-selected Backup History, Restore, Schedule tabs | Preserve those tabs; add source-coverage links and a returnable Attach detour (milestone 5) |
| `src/portal/components/backup/restore-wizard.tsx` | Backup, Items, Options, Review, Restore | Add source status, attach-source detour, content summary and phases |
| `src/shared/intune/registry.ts` | Recreation blocked for every app type outside `APPS_WITHOUT_CONTENT` (generic, not Win32-specific) | Keep the default block; a new exact-`win32LobApp` exception, permitted only through a resolved source context |
| `src/shared/intune/restore-plan.ts` and `recovery.ts` | Pure metadata planning/readiness | Add a shared explicit source-capability input, used by every consumer |
| `src/portal/lib/policies/graph-restore.ts`, orchestrated by `src/portal/app/api/restore-backup/route.ts` | Create/update, relationships, assignments (`restore.ts` only holds `validPolicyPath`) | Add a journaled content phase before relationships and assignments |
| `src/renderer/components/BackgroundTasksPanel.tsx` | Presents running work | Present durable app-source jobs from main process |
| `src/renderer/lib/background-task-store.ts` | Renderer-memory tasks | Presentation pattern only; not durable upload execution |
| New recovery service and Windows helper | Lab PowerShell script only | Supported production helper contract, eligibility checks, tenant binding and recovery jobs |
| `src/main/storage/local-blob-store.ts`, `backup/keys.ts`, `backup/archive.ts` | Encrypted local JSON blobs, bounded in-memory archives | Separate streaming source store and portable source export |
| `src/shared/tenant-writes.ts`, `plans.ts`, main API host | Tenant-write acknowledgment and feature enforcement; `tenantWriteTargets` returns `[]` (no acknowledgment) for unlisted routes | Register every new write route explicitly, each with a negative test that fails if the registration is missing; preserve existing gates |
| Backup scope, onboarding, limitations and coverage docs | State that installers are excluded | Explain metadata coverage and separately retained source coverage |

There is no current Apps management page to extend. App Backup becomes the dedicated home for installer protection; keep general-purpose application deployment/catalog management outside its initial scope. Do not put the whole page behind a paid Operations hub gate: stored-source access and Community upload must remain reachable.

## Navigation and screen layout

**Sidebar:** (All tenants when more than one tenant is connected), Dashboard, Tenants, Backup & Restore, **App Backup**, then the existing entries. Use a package/archive icon distinct from policy backup. The entry is visible on Windows, macOS and Linux; actions explain platform requirements individually. Do not label the feature as generally unavailable on a Mac when stored-source browsing/export and upload can work there. Wiring the route also updates the `TenantAccessNotice` route match and `NAV_PLAN_FEATURES` in `DesktopLayout.tsx` (no plan badge on the entry) and `feedbackPageLabel` in `src/shared/feedback`.

**Routes:** `/portal/app-backup` opens **Win32 apps**; `/portal/app-backup/versions` opens **Stored versions**, using the existing `:tabId?` route pattern from `App.tsx` rather than new route trees. An **Activity** view is deferred until recovery or upload jobs exist; until then each source's details show its own short history. App/source deep links retain tenant and return context. Backup & Restore keeps **Backup History | Restore | Schedule** with its existing URLs. It shows installer availability and links to App Backup; there is no duplicate source-management tab or second restore wizard. No `?tab=app-sources` redirect: that URL never shipped, and unknown tabs already fall back safely.

**Win32 apps** lists current or last-known Win32 apps, source coverage and per-app actions (recovery eligibility once milestone 3 ships). **Stored versions** lists immutable captured packages, including those for deleted apps. Recovery-device setup, when recovery ships, is a contextual panel in App Backup, not a separate mandatory onboarding flow for all users.

**Page-shell contract:** mount a new `AppBackupPage` independently of the backup page's `BackupTenant`, `useBackupList` loading/error gates and backup-storage setup checks. Resolve the source catalog by tenant ID plus its registered source-store descriptors, with each store reporting its own access state. Keep catalog ownership keyed to tenant identity; store location is separate, so changing backup storage does not hide a previously used source store. Local read/export needs a selected configured tenant identity and the right recovery keys, but no live Graph sign-in. Azure still needs storage authorization. A missing source-store descriptor gets a source-specific reconnect/setup action, not the backup-history setup error. Live inventory and starting recovery require their own tenant authorization/eligibility checks.

**Wizard return contract (milestone 5, not the foundation):** lift the wizard draft into a tenant/backup-scoped controller above route changes, for example a provider under `DesktopLayout`. Store selected item paths, options, source bindings and return position there; do not persist credentials in renderer state. Re-key/reset deliberately when the tenant or backup changes, rather than when the user visits App Backup. Only Attach uses this return contract in this plan; recovered content is not restorable, so there is no recovery detour from the wizard. Re-run preview/readiness for the affected row and dependents on return. Revalidate review acknowledgments whenever bindings change. Accept only internal, tenant-matching return routes. Use the `@desktop` alias where portal components import desktop feature components.

The Win32 apps view has:

1. Page introduction: “Keep installers, source files, and Intune settings together.” Tenant name and source destination stay visible (recovery-device status once milestone 3 ships).
2. A compact coverage line with the inventory origin and timestamp. **Until a milestone can produce recorded bindings (upload receipts in milestone 4)**, it reads "N of M Win32 apps have a stored installer", with N split by relationship and each part labelled: "selected by an administrator" and, once milestone 3 ships, "recovered at capture time (live app only)". It never says "recorded" or "verified". This copy rule is frozen with the relationship values in milestone 1. **Once both 2b and milestone 4 have shipped**, the headline counts only sources with a relationship of "Recorded for this content version" (an upload receipt matching the inventory's content evidence), and administrator-selected sources move to a second figure. **Denominator, foundation:** the newest readable backup whose covered folders include `Apps` decides, using the existing attempted-folder semantics of `coveredFolders()` in `src/shared/intune/scope.ts` (`Scope.Included` when present, otherwise `LEGACY_FOLDERS`, minus recorded exclusions), so complete pre-`Scope.Included` backups still count; there is no scan back past it for coverage. It counts as complete only when `gaps !== null && gaps.succeeded && gaps.missing.length === 0` for `backupGaps(metadata, ["Apps"])` (`src/main/backup/completeness.ts`), the same check `before-write.ts` uses. This is deliberately strict: `Failures` is one count for the whole backup, so any failure anywhere, or a cancelled run, makes coverage unavailable. Three outcomes: (a) the newest Apps backup is complete: coverage and deleted counts come from it, labelled with its date; (b) it is incomplete: "Source coverage unavailable: the latest backup that included Apps did not complete", with no deleted labels, while the Attach app picker and new live-app links use the newest complete Apps backup, labelled with its date, or are blocked if none exists; (c) no Apps backup at all: Stored versions only, with the empty state "Run a backup that includes Apps to see coverage." In the foundation, "deleted" means "absent from the newest complete Apps backup when it is also the newest Apps backup", and is labelled that way. **Denominator, milestone 3:** an explicit live Graph refresh that reuses the registry's existing `deviceAppManagement/mobileApps` read path and app-type filtering rather than a second read implementation, follows every `@odata.nextLink`, deduplicates by app ID, computes counts from collected items (never `@odata.count`) and treats generic query errors as "coverage unavailable", not ineligibility. Never combine denominators across inventories or claim stale coverage is current. Missing/unreadable inventory yields "Source coverage unavailable", not 0%. Deleted-app sources are counted separately.
3. Primary action **Attach source**, with **Recover from Intune** and **Upload app** added as their milestones ship. **Recover from Intune** appears only for the tenant this device is enrolled in, and stays secondary until milestone 3's measured reach supports promoting it. An unavailable action explains the specific prerequisite. Each uses a focused flow in the page, not nested modals. Never show an unimplemented action as working.
4. Search and filters: All, Missing source, Stored, Needs review, plus version and publisher search. Default All on first visit; retain the user's last filter per tenant. If a shortcut opens Missing, retain that intent and show the newly completed item in a result banner even after it leaves the filter.
5. Table columns: App, Display version, Source, Stored size/date, Actions (a Recovery status column is added in milestone 3). Detailed provenance and relationship to Intune appear in row details. Display version is Intune's free-text label, searchable and naturally sorted as text with a stable name/ID tie-breaker; do not imply semantic-version ordering. App name and version remain visible at narrow widths; move supporting data into row details rather than horizontal clipping.
6. A **Stored versions** link with a deleted-app count (foundation: outcome (a) of the coverage rule only). Sources remain exportable when the app is gone or the account cannot sign in; deletion does not imply the package can still be recovered from Intune.

Row actions in the foundation: **Attach source**, **View source**, **Export**, and an overflow with **Unlink from app** and **Remove stored copy**. **Recover from Intune** (single app) is added in milestone 3. Batch recovery is deferred until its implementation and authorization requirements are met; it is free under revision 9. Upload actions are separate, visibly name Intune, and appear only after that milestone ships. **Restore** appears only in milestone 5, and only for attached or upload-captured `.intunewin` artifacts. Recovered source files get no Restore action in this plan (see the recovered-content restore rule in section D). It opens the existing restore wizard with a metadata backup and stored version preselected; without a suitable snapshot, explain the missing settings instead of inventing a second restore path.

Follow TenuVault's existing coral primary actions, neutral surfaces, spacing, typography, dark theme, and native file pickers. Do not redesign the rest of the app. Use text and icons alongside status colors, keyboard-operable menus, labeled progress, focus restoration, and restrained live-region announcements. Navigation is not blocked by a large upload.

### Muse UX ideas selected for delivery

Only **Storage preflight** and **Close the loop** are part of the foundation. The coverage queue and provenance timeline ship no earlier than milestone 3; restore readiness rehearsal belongs to milestone 5.

- **Coverage queue:** recover eligible missing-source apps or attach an existing package, with Skip and Resume later. Persist progress per tenant and inventory snapshot. Initially order by app name; do not promise device impact or assignment-count ranking without the data. Complete one app, then offer “Next: 5 apps still need a source”. A stopped queue never changes assignments or links automatically.
- **Provenance timeline:** source details show who recovered/attached/uploaded it, when, the recovering device where applicable, the observed content record, referencing backups and any later Intune change. Explain what is known and what remains administrator-selected. Local activity recording works on Community; the existing paid searchable audit viewer retains its gate.
- **Storage preflight:** show source size, operation-specific staging space, retained size, destination and Change location before copying. If a network share cannot report free space reliably, show the uncertainty and retain bounded checks during copying.
- **Restore readiness rehearsal:** after the restore engine ships, offer Check restore readiness from a stored source. It is a read-only capability check for one app, not a test install or a promise that detection/installation will succeed. A free App Backup single-app check uses the shared resolver without calling the currently Pro-gated whole-backup `/api/restore-validate` route.
- **Close the loop:** successful store/upload results show the source location and next useful action, not just a toast. Copy/Export success remains reachable from the job panel after navigation.

## Source state and honest labels

Keep three independent facts, rather than one green “verified” badge:

- **Availability:** Missing / Stored / Storage unavailable / Damaged.
- **Provenance:** Recovered from Intune / Uploaded by TenuVault / Attached by administrator / Packaged from folder.
- **Relationship to a snapshot:** Recorded for this content version / Administrator selected / Recovered at capture time (live app only) / Live content changed / Cannot check Intune.

An integrity check says a stored package is intact and internally valid. It does not prove that it is the package a tenant previously uploaded. `size`, `sizeEncrypted`, setup names, and metadata comparisons are useful diagnostics, not identity proof. A package with equal sizes can still contain different bytes. Do not use size matches to auto-link or enable unattended restore.

“Uploaded by TenuVault” becomes meaningful for a particular app/content record only after service commit, activation/read-back, and a durable receipt associating its tenant, app ID, file/content IDs, and immutable source ID. A display-version string or content-version number alone is insufficient.

“Recovered from Intune” records the service-returned application/policy identity, recovering device, capture time and successful integrity checks. It is evidence of the package recovered at that time, not proof that it belongs to any metadata backup. In this plan, recovery binds only to the live app (live-app scope) and never creates bindings to historic snapshots, so no recovered artifact is ever labelled "Administrator selected" or "Recorded for this content version". Its relationship is shown as "Recovered at capture time". Historic-snapshot association for recovered content belongs to the 6+ recovered-content restore rule.

Folders are not deterministic ZIPs by default. Plaintext ZIP digests compare those exact ZIP bytes; they do not guarantee that packaging the same folder twice produces the same digest.

## D. Recover existing packages from Intune

Recovery is a committed App Backup workflow. It captures installer content that was uploaded before TenuVault was involved, including where the administrator no longer has the original packaging folder. It does not require re-uploading an installer first. In this plan it ships as **Recover source files (Preview)**: it produces exportable source files, not a restorable backup, and has no Restore action.

### Proven scope and production boundary

The 2026-11-11 mini PC experiment recovered PowerShell and AnyDesk package contents through the enrolled device's MDM certificate, without bearer tokens. CMS unwrap, HMAC, decryption, plaintext SHA-256 and source extraction succeeded. Elevation was necessary on that machine. Both packages were already device-targeted. See [the analysis](intunewin-content-recovery-analysis-2026-11-11.md) and [spike evidence](intunewin-content-spike-2026-11-11/README.md). These files, the revision 1 Muse review and `app-sources-plan-2026-11-11.md` are not in the repository yet. R0 requires committing them (redacted of tenant IDs, device names and keys) under `tasks/`, next to this plan, which is committed there too, so reviewers can inspect the lab claims.

That is not yet a production helper or proof of arbitrary app access. New Available assignments, user-only targeting, reliable Graph-to-IME policy-version mapping, endpoint discovery, large-package handling and rebuilt-package restore remain release tests. The recovered service payload is not the byte-identical originally uploaded outer `.intunewin` container.

**Reach.** A Windows device enrolls in exactly one tenant, and the first release recovers only through the Windows PC running TenuVault, only for apps already device-targeted at it. An MSP with many tenants can recover from at most one of them on a given PC, and typically only the subset of apps assigned to the admin's workstation. The UI states this scope and hides Recover for other tenants. Before recovery is described as a core capability anywhere (sidebar copy, docs, marketing), milestone 3 must report measured reach: the share of Win32 apps in a real lab tenant that were recoverable from one enrolled device.

### R0: recovery go or no-go gate (non-shipping track)

No helper productization or recovery UI starts until a written R0 decision record exists and says go. It runs in parallel with the foundation and covers:

- **Terms and support:** a review of Microsoft's product terms for calling the undocumented IME content service with a device identity in a commercial product, and of how the product describes it. Records the approved wording.
- **Licensing:** storing, exporting and copying third-party vendor installers across tenants; matching EULA text and `security/data-flows.md` wording.
- **Breakage plan:** a kill switch for the recovery adapter, and what happens to stored artifacts if Microsoft changes or blocks the protocol. The app has no remote flag mechanism today. Add a signed App Backup enable claim verified with Ed25519, using a channel available without product entitlement (revision 9). An unsigned health response is insufficient. The signed-channel change is an R0 dependency. New recovery jobs fail closed when the flag is off or has not been confirmed within a bounded period (proposed 24 hours), including offline. Stored artifacts remain exportable regardless of the flag.
- **Preview audience:** supported tenant/device conditions and opt-in cohorts, independent of billing plan.
- **Evidence:** the committed lab evidence above, plus a reproducible production-helper test matrix.
- **Minimum requester role:** the Intune RBAC permission required to recover an app's content. Reading app metadata is not enough, because installers can contain embedded license keys or credentials. Default: the permission needed to update that app. R0 specifies how the main process verifies it before minting a ticket, and the check fails closed when the role cannot be determined.
- **Spike with a written verdict:** version mapping, defined below.

A no-go keeps the foundation and upload/restore milestones intact and leaves recovery out; it does not reopen the attach/export scope. A go with a failed version-mapping spike still allows milestone 3 as export-only Preview.

**Recovered-content restore rule (one rule, referenced everywhere).** Recovered source files become restorable, and a **Rebuilt .intunewin** export is offered, only when both (1) the version-mapping criterion below has passed and (2) the production `.intunewin` packaging codec has passed its compatibility gate (the same codec that folder packaging needs). Both belong to milestone 6+, so this plan never offers Restore or a rebuilt export for recovered content. Exporting a rebuilt package and enabling restore use the same gate.

**Version-mapping pass criterion (defined now):** across a fixture set that includes at least one app whose content was updated to a second version, the mapping from IME `ApplicationVersion` to Graph `committedContentVersion` identifies the correct version for every fixture without relying on size or name similarity. If this fails, recovered artifacts keep their live-app-only binding and recovery stays export-only; the label is not loosened later without a new gate.

### User journey

**Select app → Check recovery device → Review destination and access → Recover → Store and export**.

1. List current Win32 apps from the selected tenant, or show the timestamped cached inventory. A fresh authorization/content check is mandatory before starting a recovery job; cached inventory alone never grants access.
2. Detect a usable enrolled Windows device and request elevation for the dedicated helper when needed. For the initial release, this is the Windows computer running TenuVault. macOS/Linux users can still browse, attach, export and upload; using a separate enrolled Windows recovery worker is a later phase.
3. Show per-app eligibility: Ready to check/recover, Recovery device needed, Elevation needed, Content changed, or Access could not be verified. Use “Assignment required” only where positively established; authentication/network/service failures must not be mislabeled as missing targeting. User-only targeting is unsupported until separately validated.
4. Review name, estimated bytes, recovery device, tenant and managed-store destination. Initial recovery uses existing targeting and makes no assignment changes. The first release recovers one app at a time; batch recovery waits for its implementation and authorization requirements.
5. Progress shows Checking access, Downloading, Verifying, Saving source and Complete. Report “Source files recovered and stored”, with View source and Export source files. A download alone is not success.

Recovery itself does not execute the installer or submit an install request. Users do not need to make the app Required as a recovery step. Pre-existing Required assignments still have their own normal Intune enforcement; the recovery UI must not promise that it controls those installations.

### Helper, identity and artifact contract

- Keep the device-certificate operations inside a narrowly scoped, signed/elevated Windows helper, with a versioned authenticated local channel to the main process. The renderer never receives device private keys, package keys, tokens or raw content URLs. Do not elevate the full Electron UI or loosen certificate-key ACLs.
- **Helper threat model (R0 deliverable).** A short written threat model answering: (1) who may call the helper: only the signed TenuVault main process of the same user session, authenticated per connection (for example a per-launch secret delivered over an ACL-restricted named pipe); any other local caller is refused; (2) elevation model: per-job UAC elevation versus an installed service, with the chosen one justified; (3) signing and update: the helper is signed with the same publisher identity as the app (the current Trusted Signing config in `electron-builder.config.cjs` covers only the app and must be extended), ships and updates with the app version, and refuses a mismatched app version; (4) certificate selection when a device holds several MDM certificates: choose by the enrollment matching the selected tenant ID, and fail rather than guess; (5) EDR: test against Microsoft Defender for Endpoint at minimum, and document expected alerts. An over-permissive channel would make the helper a confused deputy that downloads tenant app content for any local process. The threat model also states the limit honestly: requester authorization stops TenuVault from being that confused deputy, but does not protect against the device's own local administrators or code running as the same user, which can already reach the enrollment. Per-job UAC is the real barrier against same-user code.
- **Requester authorization.** Device enrollment and certificate possession prove the device's identity, not the admin's authority. Every recovery request carries the requesting admin's signed-in principal and is authorized by a fresh check, with that admin's token, that they hold the R0 minimum role for the selected app in that tenant (read access alone is refused), performed by the main process no more than a few minutes before the job starts and re-checked on resume. The helper accepts only job tickets minted by the main process that bind tenant, app ID, expected content identity, requester and expiry; tickets are single-use. Certificate access never substitutes for requester authorization. Negative tests: an admin in the right tenant with read-only access to the selected app, an admin who cannot read it, a replayed ticket, an expired ticket, and an unauthorized local caller.
- Require an explicitly selected tenant and a recovery device enrolled in that same tenant. Bind every job and result to tenant, device, app, requester and expected policy identity. Reject tenant mismatch and unsupported app types before capture. Discover the real endpoint; no hardcoded lab endpoint or caller-supplied arbitrary network destination in the product.
- Prefer the certificate-only device-scoped path proven in the lab. Do not silently add token-cache scraping, first-party application-token acquisition or access-bypass attempts as fallbacks. Unavailable access produces a useful reason and an attach-source alternative.
- Treat IME `ApplicationVersion` and Graph `committedContentVersion` as different identifiers. Capture both with their evidence; verify the mapping before calling a recovered artifact an exact match for a Graph snapshot. Re-read content identity around capture and reject/retry a changing target rather than attaching new bytes to old metadata.
- Store a durable recovery receipt with tenant/device/app identity, policy/content evidence, capture time, immutable source ID and artifact hashes. Bind the artifact to the live app only; never to an older backup.
- **Artifact format (decided):** after verification, store the plaintext source ZIP in TenuVault's own encrypted source store as artifact kind `recoveredSource`. Discard the service payload and its package-encryption keys; do not retain long-lived service package keys. Any future restore of recovered content is a rebuild-and-upload through the documented Graph flow, under the recovered-content restore rule. Device private keys remain on the enrolled device. Sensitive package metadata travels only over the trusted helper/main channel and is never logged.
- Reuse the streaming source store, space checks, cancellation, recovery-key handling and retention reservations.
- Export verified source ZIP/folder as **Recovered source files**. **Rebuilt .intunewin** follows the recovered-content restore rule above. Do not offer “Original .intunewin” for a recovery artifact that never contained the original outer file.
- Isolate the private protocol behind an adapter with explicit supported-version/health checks and the R0 kill switch. Unknown response/profile behavior fails safely without publishing a usable source. Ship recovery as Preview until the production-contract tests pass; attach/export remain available independently if the recovery adapter is unavailable or disabled.

### Apps without an existing usable assignment

The first recovery release does not modify assignments. It reports that access cannot be established and offers Attach source or recovery-device guidance.

A later opt-in **Temporarily make available to the recovery device** flow may target a pre-provisioned group containing only that device, after the Available device-group experiment is validated. Show the exact app/group/member scope and obtain the existing tenant-write review/approval before changes. Add only an Available assignment; never create a Required assignment or replace the app's full assignment collection to enable recovery. Creating groups/memberships is a separate permission/setup decision.

Before any write, journal the intended assignment and ownership evidence; retain the returned assignment ID. On success, cancel, error and restart, reconcile and remove only the assignment this job created. If its create outcome is ambiguous or somebody changed it, stop in needsReconciliation rather than guessing ownership or deleting another administrator's work. Show cleanup-pending in the source details and job panel until verified. Approval and licensing are rechecked when resuming; recovery-complete is distinct from cleanup-complete. Failed cleanup cannot be hidden by a success toast.

### Recovery delivery and validation

The first production recovery slice uses this-device Windows elevation, existing device targeting and local storage. Validate safe endpoint/certificate selection, same-tenant checks, policy mapping, interrupted download/capture, rotated certificates, disk limits and a known-source fixture in addition to the successful lab examples. Separately validate unsupported user-only and unassigned cases with useful outcomes.

After those gates: add the Available assignment flow; then an enrolled Windows worker for Mac/Linux orchestration and scheduled incremental capture. A remote worker needs an authenticated tenant-bound connection, trusted storage transfer and job authorization, not exported enrollment credentials or arbitrary remote shell access. Scheduling is explicit and opt-in. Changed-content detection must use validated content evidence rather than display version or size alone.

App Backup recovery, workers and batch features are free under revision 9. R0 decides release readiness and requester authorization, not paid access. Export of content already stored is preserved on every plan. No sidebar-wide paywall is introduced by this plan.

## B. Attach existing sources

Flow: **Choose app and version → Choose source → Inspect → Store copy**. The first attach release accepts existing `.intunewin` files only, including files picked from a share. Folder packaging is a later slice with its own compatibility gate; recovery produces a `recoveredSource` ZIP, a different artifact kind.

Input: an existing `.intunewin`, picked locally or through the OS's file/share picker. Attach always stores a managed copy. A remembered share path is provenance, not a live dependency. There is no automatic upload to Intune or continuous share synchronization.

The opening text says: “Store a copy of this installer in TenuVault. Choose the app version it belongs to.” The action label is **Store source**. The result says where it was stored and offers **View source** and **Export**.

Inspection shows package name, setup file, bytes, publisher/version hints when present, encryption/integrity result, and the chosen app/backup version. Optional “Compare details” lists matches and differences. A valid package with insufficient identity evidence remains administrator-selected. Malformed or corrupt packages are rejected, not downgraded to a warning.

Do not execute the installer, detection scripts, or package scripts during inspection. Unusual command lines are review items rather than incorrectly rejected for not naming a simple relative executable.

**Later: Packaged from folder (not in the first attach release).** Select the setup file and show the included file list/size before packaging. Snapshot input before using it, so files changing on a share cannot produce an inconsistent capture. Ships only after its codec compatibility gate.

Historical backups are immutable. Attaching a source to an old backup creates a separate supplemental binding to that backup item and the evidence actually recorded for it. It must not silently relink every version of the app. Keep who selected it and when. Live-app links pin sources until explicitly removed, even when backups expire or the app is deleted. In the foundation a live-app link binds to the app ID from the newest complete Apps backup (outcome (a) or (b) in the coverage rule).

**Binding schema:** `(tenantId, sourceStoreId, backupId, itemPath, appId, snapshotSha256)` identifies the historical target. `snapshotSha256` is a new field, computed over the decrypted snapshot JSON canonicalized with RFC 8785 (JCS), with a golden fixture frozen in milestone 1, not over stored bytes, which change on re-encryption or key rotation. Each binding also holds immutable `sourceId`, artifact digest, actor/time, schema version, observed content evidence and provenance. A live-app binding uses a separate explicit scope, never a wildcard across all backups.

**Backup-time content evidence is new work, not existing coverage.** For each Win32 snapshot, capture the committed content-version ID and file records (file IDs, names, sizes, manifest bytes/digest and read time). Keep them in a sidecar referenced by the backup manifest rather than adding private upload fields to the Graph snapshot. Read the app content reference before and after file capture, and require both reads to match the content reference in the saved settings snapshot; the sidecar is bound to that snapshot's `snapshotSha256`. On any disagreement (for example an app update between the settings read and the file read), retry within bounds or label the evidence inconsistent. An unavailable content-metadata read records that limitation without falsifying metadata-backup success. A source binding created later remains supplemental; it does not rewrite the saved manifest.

Pre-feature backups lack that file evidence. They can be targeted by backup/item/app/snapshot hash, but the UI explicitly says “Installer association selected by administrator; this backup did not record file details.” Do not fetch today's file record and present it as historic proof. This schema and the upload receipt are versioned together in milestone 1.

## A. Capture during upload

Flow: **Source → App settings → Review → Upload → Result**.

Accept an existing `.intunewin` first. Folder packaging follows the codec compatibility gate. For new apps, collect required name, publisher, install/uninstall commands, architecture, requirements, install context, detection, and return codes. Offer “Use settings from an existing app” to reduce typing while requiring review of source-sensitive settings.

MSI extraction can prefill fields where the platform supports it. Show editable suggestions, never imply that prefilling proves an install will work. Packaging/decryption must have Windows, macOS, and Linux fixtures before cross-platform claims. The installer itself still targets Windows.

Persist the source before the first remote write. “Keep a source copy” is the defining behavior of this feature, on by default. A source-store failure stops the upload with a retry/change-location action; do not finish an upload and claim the installer was protected.

Review shows the exact tenant, new app name, source version/size, commands and detection summary, and saved-source destination. Initial new apps are created **unassigned**. Result: “App uploaded to Intune. Source stored in TenuVault.” Actions: **Open in Intune**, **View source**, **Export**. “Uploaded” does not mean “installed on devices.”

For later **Update installer** support, show that the existing app's assigned devices may receive the changed package. Do not describe replacement as a storage-only change. Capture previous content identity, reject conflicting concurrent updates, and treat cancellation after activation as a changed remote app. Cloning as a new unassigned app is a separate choice. Supersedence authoring is outside the first release.

## C. Restore with installer

Keep the current five wizard steps. Extend them rather than introducing a competing restore wizard.

- **Items:** show source status beside each Win32 row. Missing rows offer **Attach source** even while their restore checkbox is disabled, plus **Attach** guidance; Recover is not offered here, because recovered content is not restorable in this plan. Do not suggest downloading a deleted app or today's installer as proof of an old backup's source. The detour preserves all selections and returns to that row after completion.
- **Options:** bind source selection to each exact backed-up content record. Reuse a recorded receipt where available; allow an explicitly reviewed administrator-selected replacement. Default to creating an unassigned copy. Existing assignment and replace gates still apply.
- **Review:** list app/settings date, selected installer, provenance, match limitations, destination tenant, upload size, dependencies and assignments. For administrator-selected sources say: “This source was selected by an administrator. TenuVault cannot prove it is the installer originally uploaded with these settings.” Acknowledge this specific substitution before the write; prevent stale acknowledgments after source/tenant changes.
- **Restore:** show per-app phases: Preparing source, Creating app, Uploading installer, Intune validating content, Applying settings/relationships, Applying reviewed assignments, Complete. Bytes transferred are not a completion signal. Errors name the failed phase and preserve retry context.
- **Result:** report app recreated and source content committed. Installation on a device is a separate fact. A failed dependency blocks its dependents; unrelated apps may continue. Show failed, blocked, skipped, and succeeded separately.

The main process re-resolves and validates the selected source and approvals immediately before execution. A UI label never grants restorable capability. Preview, readiness, drift recreate, restore execution, and cross-tenant copy all consume the same typed source resolution. Only exact `@odata.type === "#microsoft.graph.win32LobApp"` receives this capability. The `Apps` folder also includes mobile and macOS content types, which remain blocked as today.

### Source-aware capability call sites

The resolver is an I/O service outside the pure plan builder. It returns an immutable descriptor with tenant/store/source IDs, artifact digest, binding evidence, supported app type and allowed operation; no streams, renderer-provided capabilities, credentials or keys. The trusted executor revalidates it. Missing/unsupported resolution keeps creation blocked. Existing metadata-only updates continue with truthful outcome labels.

| Consumer | Required treatment |
| --- | --- |
| `src/portal/app/api/restore-preview/route.ts`: `restoreCapabilities` and `recoveryReadiness` | Resolve per backup item; refresh after Attach; distinguish settings-only and settings-plus-installer |
| `src/portal/lib/policies/restore-validation.ts`, which calls `buildRestorePlan`, `restoreBlocker` and `buildUpdatePlan` (defined in `restore-plan.ts`) | Use the same source descriptor; validate metadata and artifact separately; absent resolution must not report full recovery ready |
| `src/portal/lib/policies/graph-restore.ts`: create, update, `matches`, complete, approval pause/resume | Revalidate source; dispatch durable content job; distinguish metadata/content equivalence; journal typed continuation |
| `src/portal/app/api/restore-backup/route.ts` (restore execution entry point) | Resolve the source per item in the route handler before calling the executor; reject renderer-supplied capability |
| `src/portal/app/api/revert-policy/route.ts` (drift revert/restore execution) | Settings-only revert stays the default and says the installer is unchanged; recreate uses the shared resolver |
| `src/portal/app/api/detect-drifts/route.ts`: `restoreBlockers` (`createBlocker`, `replaceBlocker`) | Blockers become source-aware so the page offers recreate only when a source resolves; settings-only revert must say the installer is unchanged |
| `src/shared/intune/recovery.ts` | Consume a supplied capability descriptor, remaining pure; expose the actual missing artifact/mapping |
| `src/shared/intune/restore-plan.ts` | Propagate capability through blocker/capability/create planning without treating binary upload as a JSON Step |
| `src/main/features/change-sets/model.ts` and `graph.ts` | Remain metadata-only in this roadmap. They do not acquire source capabilities or create Win32 contentless objects; explicit source-less creation stays blocked |
| `scripts/intune-plan.ts` | Remains a JSON metadata planner. No implicit source-store lookup or binary upload. Preserve missing-installer blockers |

Gate restore release on a test for every row, including negative cases for non-Win32 content-bearing types and source-less change-set/CLI creation. This is a migration of actual call sites, not only a new wizard badge.

Dependencies are resolved before any remote write. A cyclic or otherwise invalid dependency graph is rejected before the first write; no review acknowledgment can waive it. Dependency relationships and assignments of a dependent app wait until each prerequisite's content is activated, including across restart and approval continuation. Do not enable a dependent app merely because it has its own installer. Existing mapped dependencies in a destination tenant must also be checked. Cross-tenant copies stay unassigned and retain source-tenant provenance while using target-scoped storage/authorization.

For in-place restore, provide explicit content behavior: **Restore settings only** or **Restore settings and installer**. If exact historic content is unavailable, show that limitation; never claim full restoration after a metadata-only PATCH. Installer replacement is a later, separately gated phase until conflict and cancellation semantics are proven.

**Equivalence and outcomes:** compare metadata and content independently. Content can be known equivalent only where an upload receipt binds the chosen artifact to the same currently observed tenant/app/content-version/file record. Size and display version are diagnostics; missing or stale evidence produces Unknown, not Equal. A content-only change must not be skipped because metadata matches. A settings-only operation reports “Settings restored; installer unchanged”, including when content differs or equivalence is unknown. Full-content restore completes only after activation/read-back of the selected artifact's upload receipt. Until live replacement ships, that choice is unavailable with a clear reason, and drift revert uses the settings-only wording.

### Approval and binary continuation contract

A `Step` is a JSON Graph request. The current `RestoreApproval.remaining` stores only JSON steps, so it cannot represent source streaming, SAS renewal or a content job. Do not append a pretend upload Step and replay it through the legacy continuation.

Introduce a versioned continuation union in `src/main/storage/restore-approvals.ts`: legacy `jsonSteps`, or `appContentJob` containing job ID, tenant/app identity, source ID/artifact digest, approved operation fingerprint, waiting phase and references to remaining work. Existing records decode as legacy. `pauseApproval`, `resumeApproval`, `complete`, repair/retry paths and the durable job state machine must dispatch by continuation kind. Binary bytes, temporary credentials and keys never enter the approval record.

The lab gate must establish which of app create, content creation/commit/activation and later writes can require Microsoft approval. Persist before every such boundary; after approval, re-check actor, permissions, source digest, destination, expiry and server state before resuming the job. Rejection/expiry keeps source reservations until reconciliation and cannot trigger assignments. Do not silently convert a blocked content job into legacy metadata-only completion.

If a particular approval path is not implemented and tested, fail closed with “This installer operation cannot continue through approval yet”. Preflight blocks known unsupported cases; an unexpected service approval pauses the job with no success claim and no later assignments. No bypass or silent cleanup is part of the fallback. Approval pause/restart/approve/reject and legacy-record compatibility are release tests for content restore.

## Backup, export, and storage behavior

Metadata backups keep their current scope and speed. Once an app source is available, new backups may record its immutable source reference and the committed file metadata observed during that backup. For attached and uploaded artifacts, if no reliable receipt/binding exists, keep the association explicit and administrator-selected. Recovered artifacts are never recorded into backups or labelled administrator-selected; they keep their live-app-only binding. Live changes do not rewrite historical references. Recovery stores source files bound to the live app only and makes no restore-readiness claim; there is no parallel recovery-only restore engine.

Stored versions can be browsed and exported independently of backup history. In the foundation, the app inventory and coverage follow the three-outcome coverage rule in the Win32 apps view; inventory before any backup arrives with the milestone 3 live refresh. Stored sources can be viewed/exported without live Graph access. Azure access still requires storage credentials. Backup Reader/scheduled cloud automation cannot read a desktop path; report source-reference status separately and do not claim the runbook captured installers. Scheduled recovery belongs to the later enrolled Windows worker, not the Azure metadata runbook. Missing sources affect source coverage, not the success of metadata backup itself.

Default storage is the tenant's selected managed storage. Retain complete provided `.intunewin` bytes for exact re-export; extract source contents on demand. Generated packages are also retained before upload. Recovery stores its verified plaintext source ZIP as the distinct artifact kind `recoveredSource` (service payload and package keys discarded, see section D). An artifact manifest records immutable source ID, artifact kind/hash, plaintext-content hash when computed, byte count, codec version, origin, setup metadata and creation time. Recovery also records device and service-policy evidence. Package bytes and the metadata needed to upload them must stay consistent; neither an attached outer package nor a recovered source ZIP is silently treated as the other format.

Use tenant-scoped source IDs and blob keys; do not deduplicate across tenants. A plaintext hash may inform comparison within a tenant, but it is not authorization or sufficient identity for selecting an encrypted artifact with different keys/metadata.

Local storage requires a streaming/chunked authenticated-encryption format with tenant, source ID, chunk position and format bound into authentication. Derive domain-separated source keys from the existing `BackupKeys` keyring, record nonsecret key IDs, and retain old key support across rotation/import. The existing TVK2 recovery bundle must recover sources and bindings on another device along with metadata backups. A separately lost device-only key is not an acceptable hidden dependency. TVK2 today carries key material only (`exportRecoveryKey` in `keys.ts`), so the catalog cannot live only in app data: the source store itself is authoritative. Each store holds, alongside the artifacts, encrypted per-source manifests, binding records and pin records. The local catalog/index is a rebuildable cache. On a fresh install, the admin uses **Reconnect source store** (part of 2a) to point TenuVault at the retained store folder and imports TVK2; TenuVault rebuilds discovery, bindings and pins from the store alone. The TVK2 format does not change. Older app builds that import a TVK2 bundle keep working for metadata backups and simply do not see sources. Publish a manifest only after all chunks verify. Azure requires block uploads and conditional object/manifest creation and is deferred past the first local release. Current Azure backup policy uses storage-service encryption rather than an application-held key; document the practical read/write implications for installers and package keys without inventing a new mandatory permission flow. Changes to that established policy need a separate product decision.

The current 32 MiB per-file and 128 MiB archive limits remain for metadata. Do not globally raise them. Source transfers bypass renderer base64/JSON, browser blobs, and the in-memory JSZip path. Compute staging requirements from the actual operation and available disk; expose the temporary location and clean partial files on cancellation/startup.

**Export** depends on artifact kind. `attachedIntunewin` and `uploadedIntunewin`: Original `.intunewin` (exact bytes), Source ZIP, Extracted folder, and Portable restore bundle when that exporter ships. `recoveredSource`: Source ZIP and Extracted folder only; a "Rebuilt package" export follows the 6+ recovered-content restore rule. Source-file content recovery does not promise original NTFS permissions or all filesystem metadata.

Ordinary “Download backup” remains metadata-only and says “Installer sources are exported separately.” Portable bundles use a streaming format with checksums, metadata and source references, explicit encryption/passphrase handling, and a separate import path. If sources are omitted, the bundle names them as external requirements.

**Retention:** derive liveness from kept backups, live links, supplemental bindings, active jobs and export/read leases. Unlink and delete are separate actions. Deletion shows what still references the source. A live link or explicit source pin survives backup retention on every plan, including Community's 30-day history, and remains pinned after deletion of the live app until the admin removes it. No automatic expiry of deleted-app sources in the first release. Supplemental bindings identify their missing/pruned backup honestly; an explicitly saved source remains available through its pin.

Integrate with `src/main/backup/engine.ts` `applyRetention` and source deletion, plus `local-blob-store.ts`'s inventory-damage handling. Pruning a backup releases only its own references under the source-store protocol; it does not directly delete source bytes. Concurrent backups, uploads and retention use a shared generation/lease protocol; a one-time reference scan is insufficient. Unknown/unreadable inventories and uncertain cross-device Azure state stop source deletion. Cancelled new jobs release only their own reservations; they do not delete shared sources. Orphaned unpinned artifacts are reviewed/cleaned separately, and are never indistinguishable from a deliberately saved installer.

## Durable execution and recovery/upload services

New main-process modules, proposed paths:

- `src/shared/app-sources.ts`: states, immutable references, provenance and source-resolution result.
- `src/main/app-sources/{store,codec,bindings,inventory,jobs,export}.ts`.
- `src/main/apps/{content-upload,upload-state}.ts`.
- `src/main/app-backup/recovery/{adapter,eligibility,receipt,jobs,assignment-cleanup}.ts`, plus a separately packaged Windows helper and later a recovery-worker transport. `assignment-cleanup` is not enabled in the existing-targeting-only release.
- `src/renderer/pages/AppBackupPage.tsx` and `src/renderer/features/app-backup/{AppsView,StoredVersionsView,RecoverFlow,RecoveryDevicePanel,AttachSourceFlow,UploadAppFlow,SourceDetails}.tsx`.
- `src/shared/app-backup-recovery.ts`: helper protocol, eligibility, recovery receipt and cleanup states. Internal source-store names may remain `app-sources`; the user-facing feature is App Backup.
- IPC/API contracts: native picker tokens, helper capability checks, job start/status/cancel/resume, inventory and export. Renderer requests refer to approved selections; arbitrary paths, endpoints or helper commands are not exposed as an API.

**Durable state location:** per-job encrypted files and a small discoverable index under the app data directory, partitioned by tenant and job ID. Package bytes live only in the source store/staging area. Journal entries contain source/resource references and bounded progress, not block payloads. Use atomic replace and checksummed/versioned records, with recovery enumeration after restart.

**Publication order and reconciliation.** Per-file atomic replace does not make a set of records atomic, so publication follows one fixed order: (1) reservation record, (2) artifact chunks, (3) artifact manifest (the commit point: an artifact exists only once its verified manifest exists), (4) pin and binding records, (5) receipt, (6) cache/index update. Reservations are renewed while a job holds an active lease and expire only after the lease lapses, so long multi-gigabyte copies to a share are never collected mid-copy. Every startup runs a reconciliation pass: chunks without a manifest are staging garbage once their reservation expires; a manifest without pin/binding records is kept and surfaced as "Stored, not linked" rather than collected; a binding without its receipt is kept but never counted as "Recorded" until the receipt exists; an attached or uploaded binding may be downgraded to administrator-selected, while a recovered binding without its recovery receipt stays unlinked and uncounted, never downgraded; a missing or damaged index is rebuilt from manifests. Reconciliation is idempotent. Tests crash the process after each step, delete the index, and run reconciliation twice, requiring exactly one discoverable artifact with its reservations intact. Do not reuse the single capped `restore-journal.ts` secure-store JSON value as a binary-upload job store. For the first release local jobs resume on their originating device; cross-device recovery of sources is distinct from cross-device transfer of in-progress jobs.

Upload job state: `draft → sourceStored → appCreated → versionCreated → fileCreated → uploading → committing → activating → verifying → completed`. Explicit alternatives: waitingForSignIn, retryableFailure, failed, cancelled, needsReconciliation. Store IDs, stable request intent, source references and progress; do not log tokens, SAS query strings or encryption keys. Obtain/renew temporary credentials as needed rather than exposing them to the renderer.

Recovery job state: `queued → checkingDevice → checkingAccess → resolvingContent → downloading → verifying → storing → bindingLiveApp → completed`. Alternatives include waitingForElevation, accessUnavailable, unsupportedProtocol, contentChanged, cancelled, retryableFailure and needsReconciliation. Bounded retries do not change the selected app/version. A later batch, if entitled, records independent per-app states. Later assignment-enabled jobs additionally journal assignment creation/cleanup, and remain cleanupPending until that state is reconciled even if content was captured successfully.

Sequence to validate in the lab:

1. Persist a source reservation and job intent; preflight tenant, permissions, quotas and source integrity.
2. Create the unassigned app for create/restore, then content version and file record. For replace, preserve the existing content reference until activation.
3. Poll for a usable upload SAS. Put blocks and commit the block list with bounded retries and renewal.
4. Commit with this artifact's matching `fileEncryptionInfo`; poll for the commit-specific successful terminal state.
5. Set the intended committed content version, then read back content and publishing status with a bounded wait.
6. Persist the upload receipt and source binding. Apply relationships and explicitly reviewed assignments only when every prerequisite succeeds.

Do not send a Graph bearer token to the SAS/blob host. Use the existing proxy-aware transport and correct cloud boundaries. Distinguish pending, failed, timed-out, unknown, renewal and commit states, with phase-specific success criteria. Preserve resumable state on throttling, auth expiry, app quit and OS sleep.

POST outcomes can be ambiguous. A prewritten job record alone does not make Graph POST idempotent. Use a proven reconciliation mechanism to identify owned resources; where identity cannot be established uniquely, stop in needsReconciliation rather than issuing another POST. Never select a created app solely by display name. Do not silently delete an app after a partial create. Cleanup requires owned-resource evidence and checking assignments/concurrent changes. Content-version cleanup depends on verified API support.

Tenant-write acknowledgment, existing multi-admin approval rules, requester authorization and audit apply in the main process. App Backup commands have no product billing gate. Route remote write commands through the guarded API host, for example proposed `/api/app-backup/upload-start`, `/api/app-backup/upload-resume` and `/api/app-backup/update-start`, registered explicitly in `tenant-writes.ts` and `src/main/api/plan-gates.ts`. Because `tenantWriteTargets` falls through to no acknowledgment for unknown routes, each new route ships with a test that sends a write request and asserts the acknowledgment and plan gate apply. Native picker/local file IPC does not directly call Graph. If implementation chooses direct IPC for execution, it must invoke the same centralized main-process authorization service, with parity tests against the HTTP path, before it can ship. Background resume re-checks target, current actor and approval scope; a saved job is not permanent permission to write.

An existing-targeting recovery action, proposed `/api/app-backup/recovery-start`, authorizes capture without changing tenant assignments or installing content. It writes nothing to the tenant, so it gets no tenant-write acknowledgment, but it is registered in `plan-gates.ts` with the explicit requester authorization and the kill switch check, with the same missing-registration negative test as the write routes. A later assignment-enabled recovery action is separate, explicitly declared as a tenant write with app/group scope, approval handling and exact-ownership cleanup. The read-oriented capture path cannot silently upgrade itself into that write action. Recovery logs record provenance and outcome without content URLs, package keys or device credentials.

An approved restore includes the selected source digest/version, target tenant and assignment intent. Review invalidates when these change. Audit records actor, source reference, target and outcome, excluding secrets. All App Backup upload, capture, source-based restore and future batch/storage variants are free under revision 9. Each operation needs a named authorization policy with no product-billing requirement, rather than an accidental default fallthrough. Test free access for tenants outside license coverage and refusal of unauthorized Microsoft requests through the same enforcement path. Operations outside App Backup retain their existing access policies.

## Delivery plan and gates

Each milestone is independently shippable once its dependencies have shipped, and has a named exit criterion. Finishing one milestone does not commit to starting the next without its own gate. Cancelling a milestone also cancels the milestones that depend on it. Acceptance criteria below are tagged with the milestone that owns them.

| # | Milestone | Depends on | Contents | Exit criterion |
| --- | --- | --- | --- | --- |
| 1 | **Contracts** | none | Jointly version artifact kinds (`attachedIntunewin`, `recoveredSource`, later `uploadedIntunewin`), source manifest, binding (with its relationship values and the rule of which relationships each artifact kind may hold), pin, upload receipt, backup-time content evidence sidecar and job record schemas, versioned together; RFC 8785 golden fixture for `snapshotSha256`. | Schemas reviewed and frozen with fixtures; no UI. |
| 2a | **Store, attach, export** | 1 | Sidebar entry, `AppBackupPage` with **Win32 apps** and **Stored versions**, coverage per the three-outcome rule with the administrator-selected qualifier, attach an existing `.intunewin`, streaming encrypted local store, publication order and reconciliation, pins that survive retention, **Reconnect source store**, TVK2 fresh-device recovery, exact export, storage preflight, docs for exactly these capabilities ("Restore with installer is coming later"), and a licensing/EULA and `security/data-flows.md` wording check for storing vendor installers. | Acceptance items tagged [2a] pass. |
| 2b | **Backup-time content evidence** | 1 | Content evidence sidecar written by new backups, bound to the snapshot. Ships as its own PR in the same release window as 2a, because every backup taken without it stays a pre-feature backup forever. | Items tagged [2b] pass; metadata backup success and speed unchanged. |
| R0 | **Recovery go or no-go** (non-shipping, parallel to 2a/2b) | none | Decision record, committed evidence, helper threat model, minimum requester role, kill switch channel, version-mapping spike. See section D. | Written go, or a no-go that leaves recovery out. |
| 3 | **Recover source files (Preview)** | R0 go, 1, 2a | This-device Windows helper, existing device targeting, one app at a time, `recoveredSource` artifacts, recovery receipts, kill switch, explicit live inventory refresh. Export only: no Restore action, no rebuilt export, no assignment changes, no batch. | Items tagged [3] pass, plus a measured reach figure from a lab tenant. |
| 4 | **Capture during upload** | 1, 2a, 2b | Community single-app upload to new unassigned apps, source retention, receipt, resume/reconciliation, progress. Approval: a request that needs Microsoft multi-admin approval is blocked in preflight where known, and an unexpected approval response pauses the job with no success claim; typed approval continuation ships in 5. Separate plan approval. | Items tagged [4] pass, including the approval block/pause cases. |
| 5 | **Restore integration** | 4 (and 2b for recorded historic bindings) | Shared source resolution at every call site for attached and upload-captured artifacts, content phase, typed approval continuation, dependencies, wizard return contract, readiness rehearsal. Recovered content stays non-restorable. Separate plan approval. | Items tagged [5] pass. |
| 6+ | **Expansion** | per plan | Production `.intunewin` packaging codec (enables folder packaging and, with version mapping, restore of recovered content), temporary Available assignments, remote Windows worker, scheduling, batch, Azure sources, live replacement, portable bundles. Each is its own plan. | Per plan. |

Product positioning follows what has shipped: existing-package recovery is not claimed before milestone 3 and its reach figure, and full-app restore is not claimed before milestone 5. No “only vendor” claim is established by this plan.

Each user-facing PR updates docs-site. Every PR receives the separate GPT-6.1-Sol full-diff review and required current-head checks before merge, following the workspace agreement. Planning does not create a PR or release.

## Acceptance criteria

- [2a] **Source fidelity:** imported `.intunewin` exports byte-identically. Source export matches the package's verified plaintext files. (Independently generated package fixtures interoperating across platforms belongs to folder packaging, 6+.)
- [3] **Recovery:** a known existing device-targeted Win32 app recovers and verifies against an independently retained source fixture on the enrolled Windows device, without assignment changes or installer execution. The PowerShell/AnyDesk results remain lab evidence, not a substitute for the production helper test. Recovered receipts preserve tenant/device/app/policy identity and artifact kind.
- [3] **Recovery boundaries:** non-enrolled, wrong-tenant, non-elevated, unsupported user targeting, expired certificates, denied access and changed protocol/content return useful distinct outcomes without a stored-ready artifact. Version-mapping failures cannot bind today's installer to an older snapshot. Requester-authorization negatives (read-only role, no read access, replayed/expired ticket, unauthorized local caller) are refused. The kill switch stops new jobs without an app update, and new jobs fail closed when the flag cannot be confirmed within its bounded period. `recovery-start` fails its missing-registration test if not registered in `plan-gates.ts`. Recover appears only for the tenant the device is enrolled in.
- [3] **Recovery lifecycle:** interruption, cancellation, disk full, helper crash and source-store failure leave no published partial package. Job progress stays with its original tenant. Device private keys never leave the enrolled device, and package secrets/content URLs do not enter renderer messages, logs or portable provenance.
- [6+] **Later assignment flow:** Available-only scope is explicitly reviewed; crash/ambiguous create/conflicting admin edits exercise ownership reconciliation; no Required assignment or full-assignment overwrite occurs. Cleanup is verified and cleanupPending remains visible. Remote-worker/schedule tests are separate from this-device capture tests.
- [2a] **Attach safety:** no tenant writes. Same-size wrong packages never get an exact-match label or automatic historical binding. Invalid MAC/digest/XML/ZIP inputs fail clearly. Traversal, symlinks, case collisions, duplicate entries and expansion limits are tested.
- [4] **Upload:** source survives a successful upload, including restart. Storage failure prevents the remote write. Correct app/file/version IDs are read back; an isolated Windows install demonstrates usefulness without making installation the UI success condition.
- [4] **Upload approval:** a known approval-required upload is blocked in preflight with a named reason; an unexpected approval response pauses the job, claims no success and applies no assignments.
- [4] **Resume:** crash after each remote request, unknown POST result, SAS expiry, throttle, sign-in expiry, changed source file and OS sleep cannot silently duplicate, lose or switch content. Ambiguous ownership is surfaced.
- [5] **Restore:** deleted Win32 app recreates from exact historical source reference; selected replacement is disclosed; cyclic dependency graphs are rejected before any write; missing/failed dependencies block dependents; metadata-only outcomes are labeled accurately. No assignments precede successful content activation.
- [5] **Restore integration:** one source-aware/negative test per capability call-site table row, including both execution routes; every new write route has a missing-registration negative test; content-only change cannot get a full-restore success through metadata PATCH; no-source change sets and CLI remain blocked; other LOB app types cannot inherit Win32 support.
- [5] **Approval:** content job survives approval pause and app restart; approve resumes the correct phase, reject/expiry never assigns, changed source invalidates approval, and old JSON-step approvals still work. Unsupported approval cases stop with a named reason.
- [2a] **Storage:** multi-gigabyte transfer uses bounded memory. Crash after each publication step (including binding written but receipt missing), index loss and repeated reconciliation leave exactly one discoverable artifact with its reservations; a reservation is not collected while its job lease is active. Disk full, disconnected shares/storage, conflicting writers, retention races and unreadable inventories do not publish partial artifacts or delete live content.
- [2a] **UX:** App Backup has its own top-level sidebar entry and independent page. Backup & Restore keeps its original tabs and links into App Backup. Stored versions and source details do not require a successful backup-history load; without one, the Win32 apps view shows "Source coverage unavailable". Tenant switch cannot move a running job. The coverage headline shows the administrator-selected qualifier until 2b and milestone 4 have both shipped; with no Apps-containing backup, coverage shows the empty state instead of 0 of 0. All three coverage outcomes are tested, including a cancelled run that saved some apps and a backup with a failure in another folder (both outcome (b)). (Returning from Attach into the restore wizard is [5].) No nested modals, silent failure or color-only status. Light/dark and narrow desktop layouts remain usable with a keyboard.
- [2a] **Inventory failure:** force list-backups failure, missing backup storage configuration and expired Graph sign-in independently. Previously registered local sources remain browseable/exportable; source-specific damage/access failures remain visible. No misleading coverage denominator is invented.
- [2b] **Content evidence:** new Win32 snapshots record content-version and file evidence in a sidecar, read before and after capture and matched to the saved snapshot's content reference (test: app updated between settings read and file read yields retry or an inconsistent label, never a silent mismatch); an unavailable read is labelled without failing the metadata backup; old backups stay "did not record file details".
- [3] **Live inventory:** reuses the registry read path, follows every next link, dedupes by app ID, ignores `@odata.count`, and uses tested `/beta` query shapes (selecting `committedContentVersion` on the collection is known to return 400).
- [2a] **Compatibility:** old metadata backups remain readable and keep truthful blockers. Backup Reader, offline inventory, downgrade/export and cross-device Azure behavior are explicit.
- [2a] **Key recovery and retention:** on a fresh install with no original app-data directory, using only the retained store folder, TVK2 and reconnect information, rediscover sources, bindings and pins, and read/export pre- and post-rotation sources. A pinned installer survives pruning of its final backup and live app deletion on Community. Active restore/export leases and damaged inventories prevent source collection.

## Proposed defaults and decisions left open

Recommended defaults: managed copies rather than live file pointers; store-before-upload; new apps unassigned; All filter initially; export remains available after downgrade; source data uses existing tenant storage policy; metadata backup remains separate.

**Confirmed:** all App Backup capabilities are free under revision 9, including future recovery, workers, batch, scheduling, upload and source-based restore. No App Backup command may require a product license, paid feature, or Community tenant allowance. Tenant-write acknowledgment, Microsoft permissions, approvals, actor authorization and audit remain mandatory. Existing operations outside App Backup retain their access policies.

Release-gated decisions: production recovery protocol support and reliable policy-version mapping, exact package-size ceiling and staging calculation, folder-packaging platform support, Azure multi-writer lease protocol, POST/assignment reconciliation mechanisms, and portable-bundle encryption/import format. App Backup pricing is settled as free.

## Evidence and documentation

- Local UI and restore/storage files named above, inspected in the current checkout.
- [Existing-package recovery analysis](intunewin-content-recovery-analysis-2026-11-11.md) and [mini PC spike evidence](intunewin-content-spike-2026-11-11/README.md). This proves the two tested device-targeted captures and identifies unvalidated cases. Not yet in the repository; committing them is an R0 requirement.
- Graph links use `/beta`, matching the app's existing Graph calls.
- [Microsoft: create Win32 app](https://learn.microsoft.com/en-us/graph/api/intune-apps-win32lobapp-create?view=graph-rest-beta).
- [Microsoft: create content file](https://learn.microsoft.com/en-us/graph/api/intune-apps-mobileappcontentfile-create?view=graph-rest-beta).
- [Microsoft: upload states](https://learn.microsoft.com/en-us/graph/api/resources/intune-apps-mobileappcontentfileuploadstate?view=graph-rest-beta).
- Documentation work: dedicated App Backup navigation, recovery prerequisites/platform/access matrix, capture vs rebuilt export, restore limitations/readiness/cross-tenant, backup coverage/downloads, storage/security data flows and troubleshooting.

Concrete docs: `docs-site/src/content/docs/restore/limitations.md` (its "Intune does not let apps download installer files" answer changes only with milestone 3, using R0-approved wording), `restore/index.md`, `restore/cross-tenant.md`, `restore/disaster-recovery.md`, `backups/coverage.md`, `backups/index.md`, `settings.md`, `security/data-flows.md`, `troubleshooting.md`, and new `apps/app-backup.md` plus recovery/setup guidance and navigation entries. Update only the capabilities actually shipped by each phase.

These documents establish the API surfaces and states. Exact request details, end-to-end compatibility and reliability are still lab gates, not claims of already implemented behavior.

## Muse Code review and disposition

Muse Wonder Full 1.0 (high), independent read-only review, completed 2026-11-11. Full findings: [app-sources-muse-review-2026-11-11.md](app-sources-muse-review-2026-11-11.md). Its verdict applies to revision 1: not ready to implement as written. No product files or tenant objects were changed by the reviewer.

| Finding | Response in revision 2 |
| --- | --- |
| B1 independent inventory page | Explicitly split page-shell history/setup gates; tenant catalog and separate store access states; failure-path acceptance tests |
| B2 capability consumers | Enumerated actual call sites; source-aware vs intentionally metadata-only; exact Win32 type gate and default-blocked semantics |
| B3 binary phase and approvals | Versioned durable job continuation in approval records; no binary JSON Step; phase-specific approval/restart/legacy tests and explicit unsupported-path block |
| B4 replace truthfulness | Independent metadata/content equivalence, receipts and observed content IDs; Unknown evidence state; explicit settings-only outcomes and content-only-change test |
| B5 historical binding target | Existing-field binding key and snapshot digest; new backup-time sidecar evidence; weaker pre-feature backup labels |
| B6 first-release phase order | Keep B first but cut to local existing-package attach/export; receipt schema designed upfront; no premature restore/folder support |
| M1 wizard detour | Lift tenant/backup-scoped draft state, preserve URL parameters and refresh affected preview rows |
| M2 app type | Exact win32LobApp only, negative tests for macOS/mobile packages |
| M3 IPC permissions/pricing | One guarded API-host execution path with explicit policy registrations; Community single-app upload confirmed by user |
| M4 coverage denominator | Latest readable Apps-containing backup, timestamped; unknown/offline count semantics and no implicit live count |
| M5 key recovery | Derive from existing BackupKeys keyring; TVK2 import/rotation/export tests |
| M6 retention | Name applyRetention and damaged-inventory integration; pins outlive backup retention and deleted apps |
| Minor findings | Preserve Backup History label, specify @desktop import alias, name durable job files, define display-version sorting and concrete docs |

The five UX ideas were accepted with scope adjustments described above. Assignment-impact sorting waits for real data; restore rehearsal waits for the content-aware engine and must not bypass existing validation licensing.

These are planning resolutions, not evidence that the code or Graph workflow is implemented. Revision 2 has not been re-approved by Muse. Lab contracts, approval behavior, source-store concurrency and fault-recovery tests remain implementation release gates. No further review round was requested or started.

### Revision 3 user-directed scope change (historical; superseded in part by revisions 4 and 5)

The user explicitly promoted App Backup to its own sidebar feature and added existing-package recovery. This supersedes revision 2's Backup & Restore tab placement and its exclusion of the private recovery path. The B1 fix now uses a dedicated page instead of adding another panel to the backup shell; B6 adds recovery immediately after the local foundation; M4 gains an independent timestamped live inventory with explicit offline fallbacks. The earlier capability, approval, binding, key-recovery and retention safeguards still apply. Muse has not reviewed this expanded recovery scope, and this document does not imply otherwise. No additional review, app implementation, tenant action or machine test was performed for this plan revision.

## Council review, round 1 (revision 3) and disposition in revision 4

Claude Opus 5.5, GPT-6.1 Sol and Muse Wonder Full 1.0, each at high effort, independent and read-only, 2026-11-12. Scores for revision 3: Opus 5/10, GPT Sol 7/10, Muse 6/10.

| Finding | Response in revision 4 |
| --- | --- |
| No legal, terms or licensing gate for the private protocol (all three) | New R0 go or no-go record, kill switch, Preview audience decision; recovery release follows R0; revision 8 permits the read-only foundations before go |
| Lab evidence not in the repo (all three) | Committing redacted evidence is an R0 requirement |
| "No impersonation" wording inaccurate (Opus) | Honest description; product docs wording changes only with milestone 3 |
| Requester authorization undefined (GPT Sol) | Fresh per-app Graph read with the admin's token, single-use bound job tickets, negative tests |
| Helper security model thin (Opus, Muse) | Five-question threat model as an R0 deliverable, including signing and certificate selection |
| Recovery reach overstated (Opus) | Reach paragraph; Attach is primary; Recover only for the enrolled tenant; measured reach is a milestone 3 exit criterion |
| Recovered content is not restorable (Muse) | Milestone 3 is "Recover source files (Preview)" with no Restore action; spike (a) gates restorability |
| Artifact format undecided, long-lived package keys (Opus) | Store verified plaintext source ZIP as `recoveredSource`; discard service payload and keys |
| Version mapping may stay heuristic (Muse) | Pass criterion defined now; failure keeps recovery export-only |
| Too big, pre-commits to everything (all three) | Removed "source-only foundation is not completion"; milestone table with exit criteria; milestones 4 to 6+ need their own approval |
| Foundation too large (GPT Sol, Opus) | Split into 2a and 2b; Activity view, wizard return contract, coverage queue, provenance timeline, live inventory and batch moved later |
| Crash safety across records (GPT Sol) | Fixed publication order, commit point and idempotent startup reconciliation, with crash tests |
| TVK2 carries keys only (GPT Sol) | Source store is authoritative for manifests, bindings and pins; fresh-device acceptance without app data |
| Dependency cycles reviewable (GPT Sol) | Rejected before any write; no acknowledgment can waive |
| Coverage headline overstates (GPT Sol) | Numerator defined as "recorded for current content"; administrator-selected shown separately |
| Inventory duplication and Graph quirks (Muse, Opus, GPT Sol) | Foundation uses latest Apps-containing backup; later live refresh reuses registry path with paging and `/beta` contract tests |
| Call-site table misses write routes (Muse) | Added `restore-backup` and `revert-policy` routes; `detect-drifts` row now names `restoreBlockers` |
| `restore.ts` row wrong (GPT Sol) | Corrected |
| `tenantWriteTargets` fails open (Muse) | Per-route missing-registration negative tests |
| Attach input contradiction (Opus) | Folder input moved to a later subsection |
| Minor: nav wiring, `?tab=` redirect, `snapshotSha256`, generic registry block, naming | All applied |

Not adopted: Muse's suggestion to drop the top-level sidebar slot in the first release. The user chose the separate sidebar feature; GPT Sol and Opus considered it justified.

## Council review, round 2 (revision 4) and disposition in revision 5

Same three reviewers, high effort, read-only, 2026-11-12. Scores for revision 4: Opus 7/10, GPT Sol 8/10, Muse 7/10.

| Finding | Response in revision 5 |
| --- | --- |
| 2a coverage headline always 0 (Opus, Muse) | 2a shows "have a stored installer" with the administrator-selected qualifier; the strict "recorded" headline starts with upload receipts in milestone 4 |
| 2a still assumed live inventory (all three) | Inventory section rewritten; "deleted" means absent from the latest Apps backup; empty state without one; live-app links bind to that backup's app ID |
| Conflicting gates for restoring recovered content (GPT Sol); rebuild needs the 6+ codec (Opus) | One recovered-content restore rule: version mapping plus production codec, both 6+; no Restore or rebuilt export for recovered content in this plan; spike (a) removed from R0 |
| Milestone 4 lacked an approval boundary (GPT Sol) | Block known approval-required uploads, pause unexpected approvals with no success claim; acceptance item added; continuation stays in 5 |
| Content evidence not bound to the snapshot (GPT Sol) | Both reads must match the snapshot's content reference; sidecar bound to `snapshotSha256`; race test added |
| "Independently cancellable" untrue (Opus) | "Depends on" column; cancellation cascades to dependents |
| Kill switch had no channel (Opus, Muse) | Signed field in the licensing service response; fail closed after a bounded unconfirmed period; acceptance test |
| Read access too low for recovery; boundary overstated (Opus, Muse) | R0 names a minimum role (default: update permission), fail closed; threat model states the local-admin and same-user limit |
| `recovery-start` had no gate (Opus, Muse) | Registered in `plan-gates.ts` with entitlement and kill switch check; missing-registration test |
| Spike failure outcome ambiguous (Muse) | Failed version mapping still allows export-only milestone 3 |
| Binding without receipt; reservation expiry on long copies (Muse) | Not counted as recorded; reservations renewed while a job lease is active |
| No UI for fresh-device rebuild (Opus) | **Reconnect source store** added to 2a |
| Licensing check only in R0 (Opus) | 2a includes the EULA and data-flows wording check for stored vendor installers |
| Minor: stale lines 5, 13, 114, 144, 156, 239, 243; Recovery status column; call-site owner; JCS; `tasks/` location; rev 3 note | All applied |

## Council review, round 3 (revision 5) and disposition in revision 6

Same three reviewers, high effort, read-only, 2026-11-12. Scores for revision 5: Opus 8/10, GPT Sol 9/10 (no findings), Muse 8/10. No blockers; all three agreed milestones 1 and 2a can start once the items below are applied.

| Finding | Response in revision 6 |
| --- | --- |
| Milestone 1 did not freeze the content evidence sidecar or relationship values (Opus) | Sidecar and binding relationship values added to milestone 1, versioned with the upload receipt |
| Recovery-created bindings mislabelled "Administrator selected" (Opus) | Recovery binds to the live app only, labelled "Recovered at capture time"; no historic-snapshot bindings in this plan |
| Milestone 4 headline needs 2b (Opus) | 2b added to milestone 4's Depends-on; strict headline waits for both |
| 2a UX check contradicted the coverage rule (Opus) | Reworded to match the inventory-failure item |
| Incomplete Apps backups could shrink the denominator and invent deletions (Muse) | Denominator only from a complete Apps backup per `backupGaps`; otherwise coverage unavailable; acceptance case added |
| Recovery detour and rebuilt export leftovers (Opus, Muse) | Wizard detour is Attach-only; export scoped by artifact kind |
| Kill switch channel only half real (Muse) | Signed App Backup capability claim available without a product entitlement (revision 9); health response excluded; Community consequence part of the Preview audience decision; licensing change listed as an R0 dependency |

## Council review, round 4 (revision 6) and disposition in revision 7

Same three reviewers, high effort, read-only, 2026-11-12. Scores for revision 6: Opus 8/10, GPT Sol 9/10 (no findings), Muse 8/10. No blockers; milestone 1 can start.

| Finding | Response in revision 7 |
| --- | --- |
| "Complete Apps backup" asked `backupGaps` for per-folder failures it cannot report, and ignored run status (Opus, Muse) | Complete is `gaps.succeeded && gaps.missing.length === 0`, as in `before-write.ts`; deliberately strict; cancelled-run test |
| Fallback versus unavailable contradiction (Opus, Muse) | Newest Apps backup decides; three outcomes stated once and referenced from the binding, storage and acceptance sections |
| Administrator-selected qualifier would mislabel recovered sources (Opus) | N split by relationship; copy rule frozen in milestone 1 |
| Receipt-less downgrade and backup recording contradicted live-only recovery (Muse) | Both scoped to attached and uploaded artifacts; recovered bindings without a receipt stay unlinked; artifact-kind relationship rule frozen in milestone 1 |
| Typo (Opus) | Fixed |

## Council review, round 5 (revision 7) and final edit

Same three reviewers, high effort, read-only, 2026-11-12. Scores for revision 7: Opus 9/10, GPT Sol 9/10 (no findings), Muse 8/10. No blockers. Both Opus and Muse flagged the same one-line issue: reading raw `Scope.Included` would skip complete legacy Apps backups. Fixed by using `coveredFolders()` semantics. Opus judged it not worth another revision, so no further round was run.

