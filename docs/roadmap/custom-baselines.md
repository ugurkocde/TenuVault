# Custom baselines: Customize OIB and company baselines from a snapshot

## What it does

Lets an organization keep its own Settings Catalog baseline in TenuVault. Route:
`POST /api/custom-baselines` (feature `customBaselines`). Screen: **Frameworks > My baselines**
(`/portal/baselines`), plus a **Customize** button under **Your own baseline** in the OpenIntuneBaseline section
(`/portal/oib`).

1. Customize OIB (`customize`): choose an OIB platform; the content is taken from the `main` commit
   the OpenIntuneBaseline section resolved for the session. That exact content is frozen as a
   source record (origin `oib`, platform, commit,
   per-policy snapshots, via `storeBaselineSource`) and its Settings Catalog policies become
   version 1 of the baseline. Other policy types of the pack (compliance, update rings, app
   protection) are listed as excluded.
2. Company baseline from a snapshot (`snapshots`, `from-snapshot`): choose a complete backup
   (status Success, Settings Catalog policies not excluded, skipped or failed, every file
   readable) of the selected tenant. Its Settings Catalog policies become version 1 (source
   origin `snapshot`, `backupFolder` recorded). IDs, timestamps, assignments, scope tags and
   Graph annotations are removed.
3. Editor (`get`, `save-version`): every policy and setting with a readable name (derived from the
   setting definition ID; the packs carry no display names and no online lookup is made; the full
   ID is always shown). Choice values (boolean-like choices as a toggle, other choices by option
   name), text and whole numbers can be edited, settings and whole policies removed, and the
   baseline renamed. Every save needs a change note and creates an immutable new version; saving
   from an older version than the current one is refused (409).
4. Deploy (`deploy`, `change-...`): plans create and update operations against the target
   tenant's Settings Catalog policies, matched by name without version suffix (`policyMatchKey`),
   and freezes them in a change set (origin `custom-baseline`). Review, approval, apply with
   pre-change backup, retry and rollback use this route's `change-...` actions and the shared
   change-set screen. Assignments are never written: created policies are unassigned with the
   Default scope tag; updated policies keep their scope tags and assignments. Each deployment
   records which version went to which tenant, also on the baseline.
5. Newer OIB version (`releases`, `rebase-compare`, `rebase-resolve`, `rebase-apply`,
   `rebase-discard`): three-way comparison with `comparePolicySets` (base = the OIB commit the
   version is based on, local = the custom version, upstream = the latest OIB `main` commit). Conflicting
   edits, changed data types and policies whose platform or template changed need a decision;
   new release policies can be added or skipped, dropped ones kept or dropped. Applying creates a
   new version based on the latest OIB commit (provenance updated). No tenant is read or written.
6. Compare with the tenant (`compare-tenant`): deviations between a version and the tenant's
   Settings Catalog policies, from the latest complete backup (hygiene backup reader) or a live
   read (Graph GET).
7. Compare with frameworks without the tenant (`compare-framework`):
   - Pack frameworks (OIB at any platform of the latest `main` commit, NCSC, Microsoft, STIG and Custom
     workspace packs) run the existing pack assessment (`assessPolicySet`, extracted from
     `handleFramework` in `src/main/frameworks/service.ts` with unchanged behaviour) with the
     baseline's policies as the policy set. A finding whose baseline value is a masked secret is
     Review, not Different.
   - Native frameworks (NIST CSF, 800-53, 800-171, ISO 27001, SOC 2, BSI, Def Stan, Cyber
     Essentials, Essential Eight) run the native engine (`createEvidenceManifest`) on evidence
     built from the baseline (`baselineEvidence`): only the Settings Catalog family is present,
     every other family is marked not collected, and policies carry no assignments. The engine
     therefore reports anything that depends on other families as unable to check (never
     missing), and no capability or control can become enforced or evidence found because
     assignment state is unknown. Setting values present in the baseline are checked (matches
     or different).
   - Every result is labelled "Compared with baseline <name> v<n>, not with the live tenant."
   - CIS keeps its own paid gate (`baselineAllPlatforms`). CIS Benchmarks packs are compared on the CIS Benchmarks page only, and CIS Controls is refused while it is Coming soon.

## Plan boundary

- Community: `list` and `get` only (stored records stay readable after a downgrade). Every other
  action answers 402. The free Custom Baselines framework (pack import on the Frameworks page) is
  unchanged and stays free.
- Pro: everything for the tenant the baseline belongs to, and deploying into the other tenant of
  the same license (`sourceTenantId` and `targetTenants` name the baseline's tenant; the route
  checks both plans and `sameLicense`, otherwise 403).
- MSP: deploying into any connected MSP tenant with the same parameters.

## Limits

- Settings Catalog policies only. Other policy types in a pack or backup are not part of a
  baseline and are listed as excluded (OIB) or not read (snapshot).
- Secret setting values are never stored: they are replaced by the redaction marker, which the
  change-set engine refuses to write, and the setting is listed as not portable. Settings that
  reference reusable settings are not portable either. A policy with a not portable setting is
  left out of a deployment until the setting is removed in the editor. Secrets and references
  cannot be edited.
- In a comparison with the tenant, secret and reference values are reported as not comparable
  (unknown), never as deviations or matches.
- A policy kept in a rebase although the release dropped it is offered again (kept by default)
  in every later rebase.
- Setting names are derived from the definition ID, not the Intune display name.
- Other choice options than boolean-like ones are typed by option name; Microsoft Graph validates
  the value on write and the engine's read-back reports a mismatch.
- A change set holds at most 25 operations; deploy larger baselines by selecting policies.
- At most 50 versions and 200 policies per baseline.
- Deployment status on the baseline is updated when the target tenant's records are synchronized
  (listing or opening deployments in that tenant).
- Native comparisons against a baseline never produce enforced or evidence found results, because
  a baseline has no assignments; they show which baseline values match the mapping.

## Microsoft Graph

Reads and writes use the Graph beta endpoint and the delegated scope
`DeviceManagementConfiguration.ReadWrite.All`, verified with Lokka (GET only):
- `GET deviceManagement/configurationPolicies?$select=id,name` (collection under `value`, paged by
  `@odata.nextLink`): matching for deploy and live comparison.
- `GET deviceManagement/configurationPolicies/{id}?$expand=settings,assignments` (settings with
  nested `settingInstance` trees, `assignments` array): target state, live comparison.
- Writes go through the existing change-set engine (`POST` and `PUT` of configurationPolicies),
  tested with the fake tenant.

## Manual verification

1. Pro tenant: OpenIntuneBaseline > Your own baseline, choose Windows, select **Customize**. The app opens My baselines with version 1; the tenant is unchanged (no audit
   entries, no new policies).
2. Settings: expand a policy, change a boolean choice, an integer and a text value, remove a
   setting, rename the baseline, enter a note and save. Version 2 appears in History; version 1
   still shows the old values. Enter text in an integer field: the save is refused.
3. My baselines > Company baseline from a backup: only Success backups are selectable. Create one
   from a backup of a tenant that has a policy with a secret (for example a Wi-Fi pre-shared key
   in Settings Catalog). The policy shows "not portable"; the stored records contain no secret.
4. Deploy: plan a deployment into the own tenant. The change set lists create and update
   operations, none sets assignments; blocked policies are listed with the reason. Review,
   approve and apply: a backup runs first. In Intune the created policies are unassigned; updated
   policies keep their assignments. Preview and create a rollback, apply it.
5. Pro with two tenants of the same license: deploy into the second tenant. With a tenant of
   another license the deployment is refused. On MSP any connected MSP tenant works.
6. OIB updates: with a baseline on an older release, check for newer releases, compare, resolve
   the conflicts, create the rebased version. History shows the new base release; the tenant is
   unchanged.
7. Compare: compare with the latest backup and with the live tenant; compare with OIB (another
   release), NCSC, a saved Custom workspace pack and NIST SP 800-53. Every framework result shows
   the "not with the live tenant" label, native results show unknown checks and no control with
   evidence found.
8. Downgrade the license to Community: My baselines shows the locked preview and the stored
   baselines, versions, deployments and comparisons read-only; Customize shows the plan badge.
