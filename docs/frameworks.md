# Frameworks and gap analysis

## Native independent framework comparisons (30 September 2026)

Community includes the ten reviewed mappings ported from IntuneDocumentation commit `bb689bd025cbfb6f85ad97d230df907f7162f92c`: NIST CSF 2.0, SP 800-53 Revision 5, SP 800-171 Revisions 2 and 3, ASD Essential Eight target levels 1–3, Cyber Essentials v3.3, ISO/IEC 27001:2022, SOC 2, BSI IT-Grundschutz Edition 2023 and UK MOD Def Stan 05-138 Issue 4 (risk levels 0–3). No policy-pack import or paid publisher subscription is needed for these independently authored technical mappings. CIS remains **Coming soon** until the signed commercial-use contract is in place. Microsoft Security Baselines, DISA STIG and Custom Baselines retain their imported Settings Catalog comparison workflow; no new official Microsoft or STIG content pack is bundled.

This is a selected technical configuration comparison, not an audit, certification, achieved-maturity verdict or complete framework compliance score. Expected values are TenuVault's interpretation, unless a detector explicitly identifies a publisher-prescribed value. Results show exact setting IDs, expected/observed values, policy references, assignment targets/exclusions/filter IDs, framework references, supported subset and collection gaps. Matching settings do not establish device enforcement or effective access.

The read-only collector uses existing consented `DeviceManagementConfiguration.Read.All` (or read/write), `DeviceManagementApps.Read.All` (or read/write), and optional `Policy.Read.ConditionalAccess` or `Policy.Read.All` permissions. It does not add consent or request directory membership/device-state access. Denied Conditional Access reads stay unavailable. The read-only collector uses twelve beta policy endpoints: Settings Catalog, legacy device configuration, ADMX, classic and catalog compliance, security intents, three app-protection families, feature/quality update profiles and optional Conditional Access. It pages settings and ADMX presentation values independently, bounds concurrency to four policy reads, retries short Graph throttles and rejects foreign, cross-collection or repeated continuation links. Missing or denied reads stay incomplete. Masked/encrypted OMA-URI values are unavailable; secrets are neither recovered nor exported. App configuration, scripts and enrollment evidence are explicitly not collected.

Native history is separate from existing policy-pack workspaces. Up to twenty comparisons per tenant/framework are stored in OS-protected local storage, capped at 24 MB. If encryption is unavailable, history is session-only. Deleting a saved comparison removes it from that history. Historical PDF, JSON and CSV export use the stored comparison without querying the tenant. JSON/CSV contain recognized evidence, not full policy snapshots. CSV cells are escaped against spreadsheet formula interpretation. Compare stored runs only with identical tenant, framework, scope and ruleset hashes; changed rules or scope require separate review. Offline history still requires a signed-in account and valid local tenant entitlement.

The installed `framework-NOTICES.txt` retains the IntuneDocumentation Elastic License 2.0 and publisher attribution. `src/shared/compliance/rights.json` records editions, sources, content decisions and source hashes; Electron builds reject unreviewed provider files or changed hashes. Open material retains its CC BY 4.0, OGL v3 or NIST reuse rights. ISO, SOC 2, BSI and Def Stan ship original descriptions plus factual names/identifiers, without publisher texts, PDFs, logos, official badges or endorsement claims. ISO uses its full standard reference in the catalog. This documents our implementation basis, not a universal legal clearance or publisher partnership.

Read-only Lokka lab validation on 30 September 2026 captured 160 policies through 501 individual Graph GETs grouped into 42 HTTP batches (plus initial discovery probes). All ten mapping/PDF generators passed replay through the desktop collector without collection failures. Source regression tests cover typed values, compound/same-policy prerequisites, assignment uncertainty, conflict evidence, platform scope and incomplete collections. Raw tenant evidence and generated reports are kept outside Git.

The sections below describe the existing imported policy-pack workflow. Their family and history limits apply to that workflow, not the new native comparisons.

The desktop sidebar has an expandable, searchable framework catalog. Each framework has its own route and source/coverage description. Catalog entries and assessment providers are independent, so another framework can reuse the policy-pack workflow without adding another assessment engine.

OpenIntuneBaseline (OIB) is no longer a catalog entry: it has its own sidebar section. See [OpenIntuneBaseline](#openintunebaseline) below.

## Framework catalog

The catalog has sixteen entries: the ten native mappings listed above, UK NCSC Device Security Guidance, Microsoft Security Baselines, DISA STIG, Custom Baselines, CIS Benchmarks and CIS Controls. CIS displays **Coming soon**.

Non-CIS native comparisons and administrator-imported Microsoft, STIG and Custom comparisons are available in Community. Only CIS Benchmarks and CIS Controls assessments and reports need Pro or MSP. Native comparisons do not accept policy imports or create policies.

## Available assessment

For Microsoft Security Baselines, DISA STIG and Custom Baselines, admins can import their reviewed Settings Catalog JSON exports (one object or an array, multiple files supported). Provide a source version and profile. Imported packs are supplied by the admin; selecting a framework does not certify those mappings as official. CIS benchmark content and Build Kits are not bundled. The native control-framework mappings described above cover a selected technical subset.

CIS Benchmarks and CIS Controls remain visible as plain-text framework references with a **Coming soon** status. Their navigation, import, comparison and creation workflows are disabled until TenuVault's commercial-use contract is signed. Direct URLs show the unavailable status, and the main process rejects CIS framework operations, including creation from a previously obtained assessment. Saved CIS workspaces are retained. This temporary gate is independent of subscription upgrades; upgrading a plan does not enable CIS.

Imports require `name`, `platforms`, `technologies`, and nonempty `settings`. Each setting needs a `settingInstance` with `settingDefinitionId` and its derived `@odata.type`. Tenant-specific IDs, assignments, scope tags and export annotations are omitted from creation payloads; derived setting types and nested dependency trees are retained. Limits: 200 policies and 8 MB per import.

Comparison reads `/beta/deviceManagement/configurationPolicies`, then all pages of each policy's settings collection. Empty pages with continuation links are followed. Failed or incomplete reads fail the assessment; they do not become missing-policy findings. Cross-origin, non-beta and repeated continuation links are rejected. The current reader uses four concurrent settings reads to bound load.

## Finding meanings

- **Present:** All observed occurrences of the root setting match the recommendation's configuration content.
- **Missing:** No occurrence exists in the assessed policy family and platform.
- **Different:** At least one observed occurrence differs, including when another policy matches.
- **Review:** The imported pack recommends alternative values for that root setting. Remove alternative profiles or resolve the recommendation first.

Names are not used to match settings. Nested values are compared. Export and template metadata do not affect equivalence. Collection ordering is compared conservatively, so a differently ordered collection may require manual review. Matching root settings must contain the same nested configuration; extra nested values can produce a Different result.

These are configuration findings, not a compliance score. Settings Catalog assignment targets are read from each policy's `/assignments` collection, including groups, exclusions and filter references. Targeting is reported as unassigned, configured, review or unavailable. A denied, malformed or incomplete assignment read is unavailable, not unassigned. Group membership, exclusion overlap and filter evaluation remain manual review items. Device applicability and observed device enforcement are explicitly unavailable; organizational evidence is a separate manual result. Neither configured targeting nor a configuration match proves device compliance. Conflicts with other policy families are not evaluated. Unassigned policies can be Present. Compliance policies, update rings, legacy configurations and other policy families are outside the initial engine's scope.

## Remediation

Select Missing root settings, preview exact payloads, then confirm the tenant and creation. Selected root settings retain their nested dependencies. One new policy is created per selected source policy; assignments are never copied or sent. Existing policies are never patched or deleted. Alternative recommendations and Different findings cannot be selected for automated creation. Duplicate root selections across source policies are rejected.

An assessment is held in the main process for 15 minutes and is bound to its tenant, source pack and inventory fingerprint. The service rereads the tenant before creation, rejects stale runs and concurrent creation for the same tenant, and consumes a run before writing. A failed or uncertain write cannot be blindly replayed. Outcomes are reported per policy, and each creation result is audited in local tenant storage. A second comparison recognizes created configurations, while assignment and device verification remain the admin's next steps in Intune.

Packs, source references and assessment history are saved per tenant/framework in protected local storage. Historical views are read-only and cannot authorize remediation. Export an assessment as JSON or as a PDF report, or delete individual assessments or an entire workspace. Deleting a saved assessment also revokes its live creation authorization. Source mappings retain provenance; [coverage metadata](framework-coverage.md) lists supported families, unsupported areas and manual evidence requirements. History is limited to 50 assessments and 32 MB per workspace; export and delete older entries when full. Approved mappings for other frameworks and pack update management remain future work.

## OpenIntuneBaseline

The OpenIntuneBaseline section offers the three OIBDeployer workflows. The platforms and versions come from the upstream `releases.json` manifest: each published release is pinned to the commit its tag points to, beta releases are pinned to the commit of their branch, and `main` is offered where a platform has no published release. Each platform uses its newest non-prerelease release by default; a prerelease toggle offers the beta and unstable channels, and selecting a beta, unstable or main version shows a warning to test in a pilot tenant first. Every version is resolved to one commit per session, so a comparison and the deployment that follows see the same files; only commits the app resolved itself are loaded. The commit is recorded on every deployment run, every validation run and in the provenance of custom and installed baselines. The manifest lists Windows, macOS, Windows 365, iOS, Android and BYOD (iOS and Android app protection); platforms it marks as in development appear but cannot be scanned. Attribution and the upstream GPL-3.0 license are linked in the UI.

- **New Deployment:** choose operating systems, answer the licensing questions (Business Premium or E3/E5/E7, Defender for Endpoint as primary antivirus, Autopatch), choose policy types, then policies. `PolicyManifest.json` `skuRequirements` and `licenseRequirements` hide policies the tenant cannot use; they can be shown and selected anyway. Policies already in the tenant are not created again.
- **Existing Deployment:** tenant policies are matched on the `OIBID:` in their description (current or previous version), then on their name without version for policies deployed before OIB 3.8. Results are up to date, update available, new, newer than OIB or ambiguous; deprecated OIB policies and older versions still deployed are listed for review. Missing and outdated policies can be deployed. Outdated policies are created alongside, or (Pro and MSP) updated in place: settings are replaced with the OIB version, assignments, filters and scope tags stay.
- **Policy Validation:** read-only, setting-by-setting comparison of matched policies: Settings Catalog and Endpoint security, compliance, update rings, driver updates, Endpoint Analytics and administrative templates. Results show value mismatches, settings missing in the tenant and settings only in the tenant; export CSV or PDF. Validation runs are kept per tenant in protected local storage (latest 50). **Fix drift** (Pro and MSP) resets a drifted policy to its OIB configuration in place, keeping assignments.

`%OrganizationId%` in OIB content is replaced with the tenant ID before deployment and validation. Source assignments are not deployed and scope tags go back to Default. A full backup runs before anything changes; if it fails, nothing changes. Runs that only create policies may skip the backup (it is on by default); in-place updates and drift fixes always back up first, and the main process enforces this. New policies are created unassigned, or assigned only to a pilot group when one is given, and (MSP) the same policies can be created in further tenants. Every deployment and drift fix is recorded on the device with the IDs it created and the previous version of every policy it updated; undo deletes the created objects and puts the previous versions back. Deployment, drift fixes and undo are written to the tenant's audit log (viewing it needs Pro or MSP).

Community gets New Deployment, the Existing Deployment comparison, Policy Validation and deployment of new policies on every platform in its one tenant, plus undo. Updating in place and Fix drift need Pro or MSP; Also deploy to needs MSP. Customize (an editable custom baseline from a platform of the current OIB version) is Pro and MSP and lives in the section under Your own baseline; custom baselines compare with and rebase onto the latest `main` commit.

Quick Start and the pinned OIB framework pack were replaced by this section, and OIB left the framework catalog. On first start after the update, Quick Start runs stored on the device are moved into the OpenIntuneBaseline deployment history with the same run IDs, so they stay undoable and can still be recorded as installed baselines. The original records are kept under a separate key; nothing is deleted. Runs of the previously pinned release keep their exact commit; runs of other releases have unknown provenance, so baseline upgrades compare them manually. Saved OIB framework workspaces stay on the device but are no longer shown.

## Verification scope

Updated 27 September 2026. Current tests cover import validation, nested values, alternative profiles, paging, token destination restrictions, access failures, tenant/run binding, stale inventory, replay prevention, workspace persistence/deletion and honest write outcomes. Read-only Lokka beta checks verified policy, setting and assignment response shapes; no live remediation was performed during this issue pass. See [reliability scope](reliability-review.md) and the [README](../README.md).

The earlier document at commit `42488bc29b8777e12bbe8e9a30c3fd358f5f877e` recorded 102 tests and a restricted lab fixture with 62 OIB policies and 784 root findings. Its Windows relay exercised temporary unassigned creation and cleanup while excluding real sign-in/licensing. These counts and live results are historical, preceding the 26–27 September 2026 issue pass; they are not current whole-product validation.

## Assignment evidence scope and permissions

The initial evidence reader uses the existing delegated `DeviceManagementConfiguration.Read.All`
or `DeviceManagementConfiguration.ReadWrite.All` permission for Settings Catalog assignment reads.
It does not request directory membership or managed-device permissions. Group and filter IDs are
reported as references, with their effective applicability unavailable. Device enforcement reports
are not collected by this version. In the read-only beta verification on 27 September 2026 (Europe/Berlin), configuration-policy
`/assignments` returned direct all-device targets; `/deviceStatuses` was not a supported segment.
Historical reports preserve the evidence available at assessment time, including unavailable states.
