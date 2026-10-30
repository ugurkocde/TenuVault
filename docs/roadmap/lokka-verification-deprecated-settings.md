# Lokka verification: deprecated Settings Catalog settings

Date: 2026-10-30
Tenant: Ugur Koc Lab (lab tenant, app-only Lokka connection)
Graph version: beta (every path below is relative to the beta endpoint)
Scope: can TenuVault flag Settings Catalog policies that contain deprecated
settings, using `deviceManagement/configurationSettings` as the reference
catalog and the `settingDefinitionId` values already stored in backups?

## Method

Reads and three controlled lab writes (see the missing-from-catalog
experiments), all sent through Lokka. The catalog was fetched in full and
classified offline, then every Settings Catalog policy in the lab was read
with `$expand=settings` (the same read backups use) and its setting
definition IDs, including nested group and choice children, were compared
with the catalog. Lokka's `fetchAll` fails on these endpoints with "Invalid
array length", so lists were paged by hand by following `@odata.nextLink`.
The product's own list helper already pages this way and is not affected.
The single test policy that was created was deleted, and a filtered listing
confirmed that no "TenuVault E2E DeprecatedSignal" policy remains.

## Question and answer

Graph has no structured deprecation flag on
`deviceManagementConfigurationSettingDefinition`. Deprecation is only written
in prose, in `displayName` and `description`. It is still reliably
detectable if the patterns are narrow (see "Signal tiers"). The lab tenant,
which runs current OpenIntuneBaseline policies, already contains 19 settings
whose names say deprecated or obsolete, across 15 of its 140 Settings
Catalog policies, including the current OIB Microsoft Edge security policy
and the OIB macOS update policies. Two more in-use settings are marked
"[to be deprecated]" in their description.

## Results per call

| Call | Result |
| --- | --- |
| `GET deviceManagement/configurationSettings/$count` | No route. Graph answers "No OData route exists that match template ~/singleton/navigation/$count". Do not use `$count` here. |
| `GET deviceManagement/configurationSettings?$select=...&$top=5` | 5 entries and **no `@odata.nextLink`**. `$top` truncates this list silently. Never page this endpoint with `$top`. |
| `GET deviceManagement/configurationSettings?$select=id,displayName,name,description` (no `$top`) | All 18,620 definitions in one response, no `@odata.nextLink`, about 11 s through Lokka, 12.7 MB as saved JSON. With ten selected fields the same call took about 25 s through Lokka. `$select` is honored for every field used here. |
| `GET deviceManagement/configurationSettings/{id}` | 200 for the known deprecated ID `device_vendor_msft_policy_config_internetexplorer_disableinternetexplorerapp`, with `displayName` "[Deprecated] Disable Internet Explorer 11 as a standalone browser" and `visibility` "settingsCatalog,template". Deprecated definitions remain in the list, so one list fetch is enough; no per-setting reads are needed. |
| `GET deviceManagement/configurationPolicies?$select=id,name&$top=100` | Pages normally with absolute beta `@odata.nextLink` values. 140 policies in the lab. |
| `GET deviceManagement/configurationPolicies/{id}?$expand=settings` | 140 of 140 readable. Expanded `settings` never carry `settingDefinitions` (0 of 140 policies), so backups hold setting definition IDs only. A catalog reference is required to name or judge a setting. |
| `GET deviceManagement/configurationPolicies/{id}?$expand=settings($expand=settingDefinitions)` | Works and returns full definitions per setting (22 on the sample policy). Available if a future feature needs per-policy definitions, but not needed while a cached catalog exists. |

Permissions: the documented least privilege permission for the catalog list
and get is `DeviceManagementConfiguration.Read.All` (delegated and
application). The TenuVault app registration already requests
`DeviceManagementConfiguration.ReadWrite.All`, so this feature needs no new
consent.

## Signal tiers

Counts are catalog-wide, out of 18,620 definitions.

| Tier | Pattern | Count | Verdict |
| --- | --- | --- | --- |
| Definite, name | `displayName` matches `/deprecat\|obsolete/i` | 534 (404 deprecated, 138 obsolete, 8 both) | Safe. Forms seen: "[Deprecated] X" (41), "X (deprecated)", "X (Deprecated)", "X (obsolete)". |
| Definite, description | `description` matches `/this (policy\|setting) is deprecated/i` and the name is clean | 88 | Safe. Mostly ingested Chrome and Edge policies whose text says "This policy is deprecated. Its usage is discouraged." |
| Future | `description` starts with "[to be deprecated]" | 2 | Safe as a lower-severity heads-up, not as deprecated today. Both are Defender update channel settings, and both are in use in the lab. |
| Ignore | `description` or `name` mentions "deprecated" in any other way | 70 | **Unsafe.** These describe a deprecated technology, not the setting itself: XFA ("a legacy technology that's deprecated by its original creators"), Manifest V2 ("support will be deprecated"), WebAssembly module sharing, SwiftShader fallback. Never flag on a bare description match. |
| Clean | none of the above | 17,926 | |

Fields that carry no signal:

- `helpText`: 0 matches for "deprecat" in the whole catalog. Do not select it
  for this feature.
- `name` (internal): 25 matches, only 4 of them outside the tiers above. Not
  worth selecting.
- `visibility`: deprecated definitions are `settingsCatalog,template`
  (555 of 592 any-match) or `settingsCatalog` (37), never `none`. A
  deprecated setting stays fully visible in the portal, which is exactly
  the user complaint behind this feature.
- `applicability` on sampled deprecated definitions: `maximumSupportedVersion`
  is null, and `referredSettingInformationList` is empty. There is no
  structured end-of-support version and no pointer to a replacement setting,
  so findings can name the setting but cannot suggest its successor.

## The "missing from catalog" signal

The 140 lab policies use 1,865 distinct setting definition IDs including
nested children. Every one of them is present in the flat catalog list:
0 missing. No positive case exists in this tenant, so three lab experiments
checked whether one can be manufactured. Test policies used the "TenuVault
E2E DeprecatedSignal" prefix; the one policy that was created was deleted
and a filtered listing confirmed none remain.

| Experiment | Result |
| --- | --- |
| A: create a policy with a fabricated definition ID (`device_vendor_msft_nonexistent_tenuvault_deprecated_signal_test`) | Rejected: "Setting Id is not found in the Settings Catalog Database." A missing ID cannot be introduced through the API today. |
| B: create a policy containing the deprecated Edge setting `renderercodeintegrityenabled`, copied from the live OIB Edge policy | Created and read back normally (`settingCount: 1`, deprecated ID present). Deprecated is not removed: the service still accepts and returns these settings, so they must be caught by the wording tiers, not by absence. Deleted after the check. |
| C: use a compliance-only definition in a configuration policy. `deviceManagement/complianceSettings` holds 21 definitions, 13 of them absent from `configurationSettings` (all Linux compliance). The setting was copied from the lab's Linux compliance policy. First attempt in a Windows policy body, then retried with matching `platforms: linux`, `technologies: linuxMdm` | Rejected on platform applicability in the first attempt, then on usage: "Setting type Compliance does not match with policy type Configuration. Expected setting type is Configuration". A configuration policy cannot gain a compliance-usage definition through the API. |

Conclusions:

1. Child definitions are all in the flat list, so comparing recursively
   collected IDs against the list produces no structural false positives.
2. Create validates both catalog membership and setting usage. An ID found
   in a configuration policy but absent from a complete, current
   `configurationSettings` list therefore almost certainly means the
   definition was removed from the catalog after the policy was created.
   This earns the signal a "possible" tier. It stays below the definite
   tiers because one case remains unobserved: how the service reads back a
   policy whose setting was removed after creation (returned as-is, or
   silently dropped). Only flag it when the catalog fetch in the same scan
   succeeded completely.
3. The lab now serves as a standing test case. Its policies contain
   deprecated IDs (see the preview below); when Microsoft actually removes
   one of those definitions from the catalog, re-running this verification
   will show the first natural missing-from-catalog case and its read-back
   shape.

## Lab findings preview

Applying the tiers above to the lab tenant gives 19 definite-name settings
and 2 future settings in use, across 15 of 140 policies. Examples:

- "Enable renderer code integrity (deprecated)" and "Enhance the security
  state in Microsoft Edge (obsolete)", both in the current OIB Edge security
  policy.
- Seven "… (Deprecated)" macOS software update settings in the current OIB
  macOS update policy, plus deprecated Apple Intelligence and privacy
  preferences settings in other current OIB policies.
- "Engine Updates Channel" and "Platform Updates Channel" ("[to be
  deprecated]" in the description) in all three OIB Defender antivirus
  update ring policies.

## Rules for an implementation

1. Fetch the catalog once per scan with
   `GET deviceManagement/configurationSettings?$select=id,displayName,description`
   and **no `$top`**. Record the fetch date and definition count with the
   scan. Store only the matched definitions, not the full catalog.
2. Flag the two definite tiers as definite findings. Flag the future tier as
   a separate, lower-severity "to be deprecated" finding. Never flag the
   ignore tier. Unit tests must include the risky samples above (XFA,
   Manifest V2, SwiftShader) as must-not-flag cases.
3. Wording stays "review for replacement or removal". Deprecated does not
   mean the setting no longer applies, and Graph gives no replacement
   pointer, so a finding shows the setting name, its definition ID and the
   policies containing it, nothing more.
4. Match against the setting definition IDs already collected from the
   latest backup, recursively through group and choice children, the same
   walk the hygiene `conflicting-setting` rule uses.
5. An in-use ID absent from a completely fetched catalog may be flagged in a
   "possible" tier ("no longer in the Settings Catalog; the setting may have
   been removed by Microsoft"). Never flag it from a partial or failed
   catalog fetch, and never in the definite tier until a natural case has
   been observed end to end.

Implemented as above: the hygiene rule `deprecated-setting` and, sharing the
same classifier in `src/shared/intune/settings-catalog.ts`, a restore-time
check (`POST /api/settings-catalog-check`) that warns in the restore wizard
before anything is written. The restore check reads the catalog of the
tenant restored from; for copies to other tenants their catalogs may differ.

## Not verifiable with Lokka

- A natural "missing from catalog" case: the lab has none today, and one
  cannot be manufactured (create validates catalog membership and usage,
  experiments A and C above). In particular it is unknown whether the
  service still returns a removed setting when such a policy is read back.
  The lab's deprecated settings are the candidates to watch.
- Delegated-token behavior of the catalog read. Lokka used an app-only
  token; the endpoint documents the same read permission for delegated
  calls, and the app already holds the ReadWrite variant.
- Catalog content in national clouds. The API is documented as available
  there, but definition wording was only observed in the global cloud.
- Timing of the catalog call from the desktop app itself. The Lokka timings
  above include MCP transport; the payload size (about 13 MB for the three
  needed fields) is the figure to plan with.
