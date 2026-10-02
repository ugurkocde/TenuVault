---
title: "Framework coverage"
description: Compare Intune configuration evidence with native framework mappings or administrator-imported policy packs.
---

**Frameworks** compares your tenant's Intune configuration with a framework, setting by setting. There are two workflows:

* **Native comparisons** check your tenant against ten built-in technical mappings: NIST CSF 2.0, NIST SP 800-53 Rev. 5, NIST SP 800-171 Rev. 3 and Rev. 2, ASD Essential Eight, Cyber Essentials, ISO/IEC 27001:2022, SOC 2, BSI IT-Grundschutz and UK MOD Def Stan 05-138. They are read-only: nothing is imported and nothing is created in your tenant.
* **Policy-pack comparisons** check your Settings Catalog policies against a versioned pack: the UK NCSC Device Security Guidance Windows pack, or a pack you import for Microsoft Security Baselines, DISA STIG or Custom Baselines. Except for the NCSC pack, which is comparison only, this workflow can also create the missing settings as new, unassigned policies.

The results are configuration findings, not an audit, a certification, an achieved maturity level or a compliance score.

OpenIntuneBaseline is not part of the framework catalog. It has its own **OpenIntuneBaseline** section in the sidebar, which deploys, compares and validates OIB policies. See [OpenIntuneBaseline](/baselines/quick-start/).

## The framework catalog

Select **Frameworks** in the sidebar to open the catalog. It shows every framework as a card, grouped into framework comparisons, baselines and policy packs, and frameworks that are coming soon. The search box on the catalog filters by name, publisher or type. The sidebar lists each framework by name beneath **Frameworks**; use the arrow next to it to fold the list away. The catalog has sixteen entries:

| Framework | Publisher | Type | Comparison source |
| --- | --- | --- | --- |
| Microsoft Security Baselines | Microsoft | Baseline | Import your own policy JSON |
| UK NCSC Device Security Guidance | UK National Cyber Security Centre | Baseline | 2025 Windows Settings Catalog pack loads directly; comparison and reports only |
| CIS Benchmarks | Center for Internet Security | Benchmark | Coming soon, pending commercial-use contract |
| CIS Controls | Center for Internet Security | Control framework | Coming soon, pending commercial-use contract |
| NIST CSF 2.0 | NIST | Control framework | Native comparison |
| NIST SP 800-53 Rev. 5 | NIST | Control framework | Native comparison |
| NIST SP 800-171 Rev. 3 | NIST | Control framework | Native comparison |
| DISA STIG | DISA | Benchmark | Import your own mappings |
| ASD Essential Eight | Australian Signals Directorate | Control framework | Native comparison, target maturity level 1 to 3 |
| BSI IT-Grundschutz | BSI | Control framework | Native comparison |
| NIST SP 800-171 Rev. 2 | NIST | Control framework | Native comparison |
| ISO/IEC 27001:2022 | International Organization for Standardization / IEC | Control framework | Native comparison |
| SOC 2 | AICPA | Control framework | Native comparison |
| UK MOD Def Stan 05-138 | UK Ministry of Defence | Control framework | Native comparison of Issue 4, target cyber risk level 0 to 3 |
| Cyber Essentials | NCSC | Control framework | Native comparison of v3.3 |
| Custom Baselines | Your organization | Custom | Import your own policy JSON |

Only UK NCSC Device Security Guidance loads automatic policy-pack content. For Microsoft Security Baselines, DISA STIG and Custom Baselines you supply reviewed Settings Catalog policy exports that map the framework to Intune. Native comparisons do not accept policy imports or create policies. TenuVault does not bundle CIS benchmark text, CIS Build Kits or other restricted publisher content. Selecting a framework does not certify your mappings as official.

:::note
CIS Benchmarks and CIS Controls remain visible with **Coming soon** labels. Their workflows are temporarily disabled while TenuVault's commercial-use contract is being finalized, including direct page and API access. Saved workspaces are retained. Upgrading to Pro or MSP does not enable CIS during this pause.
:::

Native framework pages link to the publisher with **Publisher reference**. Policy-pack framework pages describe their source and coverage, and link to the publisher with **Source**.

## What your plan includes

| | Community | Pro | MSP |
| --- | --- | --- | --- |
| Compare with the UK NCSC Device Security Guidance Windows pack | Yes | Yes | Yes |
| Native framework comparisons | Yes | Yes | Yes |
| PDF reports and CSV or JSON exports (every framework except CIS) | Yes | Yes | Yes |
| Compare administrator-imported Microsoft, STIG or Custom packs | Yes | Yes | Yes |
| CIS comparisons and their reports (coming soon) | No | Yes | Yes |
| Create missing settings from a policy-pack comparison | Yes | Yes | Yes |

Non-CIS native comparisons, the UK NCSC Device Security Guidance pack, administrator-imported Microsoft, STIG and Custom comparisons, and their PDF, CSV and JSON reports are free in Community in TenuVault 0.2.0. CIS assessments and CIS reports will need Pro or MSP; CIS stays unavailable on every plan until its commercial-use agreement is signed.

Every report and export is built on this device from the saved comparison or assessment, without reading the tenant again. It names the tenant, framework, version and profile, the assessed scope, the collection date, the supported coverage, what stayed unknown and the limitations, and states that it is not a certification and does not prove device enforcement. Secrets, tokens and credentials are redacted. You choose where the file is saved; nothing is uploaded.

## Compare your tenant with a native framework

Select the tenant in the sidebar, then open a native framework. The page header links to the publisher with **Publisher reference**. Expand **About this comparison** to read its scope, content license and limits.

### 1. Choose what to compare

In **Compare your tenant**:

1. Under **Platforms in scope**, toggle **Windows**, **macOS**, **iOS / iPadOS**, **Android** and **Conditional Access**. Select at least one.
2. On ASD Essential Eight, choose a **Target maturity level**. On UK MOD Def Stan 05-138, choose a **Target cyber risk level**.
3. Click **Compare settings** (**Compare again** for later runs).

TenuVault reads your Intune policies and compares them with the framework mapping. The comparison is read-only.

### 2. Follow the progress

A progress bar shows the current step, for example "Reading settings catalog policies (1 of 12): 4 of 37 policies", with the percentage and elapsed time. Click **Cancel comparison** to stop it.

The comparison runs in the background, so you can keep using TenuVault:

* While it runs, the **Frameworks** entry in the sidebar shows a spinner and the framework shows **Comparing · *N*%**.
* When it finishes, a notification with **View results** appears in the app. If the TenuVault window is not in front, a system notification appears instead; click it to open the framework page.
* Starting the same framework again for the same tenant while it runs shows the running comparison instead of starting a second one.

### 3. Review the results

Summary tiles count individual setting observations:

| Result | Meaning |
| --- | --- |
| **Matches** | The observed value matches the expected value. |
| **Different** | The setting is configured with a different value. |
| **Missing** | No collected policy configures the setting. |
| **Unable to check** | TenuVault could not read the evidence, for example because a read failed or a value is masked. |
| **Outside scope** | The check applies to a platform you did not select. |

Compliance policies, device restriction profiles and endpoint protection profiles return every on/off setting, and one left at **Not configured** reads as off. TenuVault ignores those, so they never count as **Different** or as evidence against a requirement. For example, a compliance policy that only requires the firewall is not reported as a different value for BitLocker or antivirus. Administrative template and custom (OMA-URI) settings are compared as set, because **Disabled** there is an explicit choice.

Click a tile to filter the evidence list. **Setting-by-setting evidence** lists each check with its expected and observed values, the source policy and its assignment evidence. Use the search box and the result filter to narrow the list.

Below the evidence, expand **Collection coverage and limitations**, **Framework references** and **Snapshot and ruleset provenance** for the read status of each policy type, the framework requirements each check maps to, and the hashes that identify the input and ruleset.

Export the result as a **PDF** report, **CSV** or **JSON**. JSON and CSV contain the recognized evidence, not full policy snapshots. Masked or encrypted values are shown as unavailable; secrets are never recovered or exported.

### What native comparisons collect

TenuVault reads twelve policy types: Settings Catalog, legacy device configuration, administrative templates, classic and Settings Catalog compliance, endpoint security intents, app protection policies (three types), feature and quality update profiles, and, when selected, Conditional Access. App configuration, scripts and enrollment settings are not collected. A read that fails or is denied stays visible as a collection gap and is never reported as a match.

Expected values are TenuVault's interpretation unless a check identifies a publisher-prescribed value. A match does not prove that the setting is assigned to the right devices or enforced on them.

### Comparison history

**Comparison history** keeps up to 20 comparisons per tenant and framework in protected local storage on this device. If protected storage is unavailable, history lasts for the current session only. When the history exceeds its storage limit, the oldest comparisons are removed automatically.

For each saved comparison you can:

* **View** it. PDF, CSV and JSON exports of a saved comparison use the stored result and do not query the tenant.
* **Show changes since** to list the setting observations that changed between that comparison and the one you are viewing, with before and after values, directly under the history. Only comparisons with the same scope and ruleset can be compared.
* **Delete** it.

If saved comparisons for a framework cannot be read, TenuVault sets them aside and shows a notice. New comparisons are saved normally. Viewing history offline still requires a signed-in account and a valid local tenant entitlement.

Native history is separate from policy-pack workspaces.

### Content and licensing

The native mappings are adapted from IntuneDocumentation under the Elastic License 2.0. The installed `framework-NOTICES.txt` contains the license and publisher attribution. Open material keeps its CC BY 4.0, Open Government Licence v3.0 or NIST reuse terms. ISO/IEC 27001, SOC 2, BSI IT-Grundschutz and Def Stan mappings use original descriptions plus factual names and identifiers, without publisher text, PDFs, logos, official badges or endorsement claims. This describes TenuVault's implementation basis, not a legal clearance or publisher partnership.

## Compare your tenant with a policy pack

Select the tenant in the sidebar, then open UK NCSC Device Security Guidance, Microsoft Security Baselines, DISA STIG or Custom Baselines.

### 1. Choose your policy pack

"Import one or more Settings Catalog JSON exports. Review the source, version and intended profile before comparison. Loading a pack does not change your tenant."

* On **UK NCSC Device Security Guidance**, click **Load NCSC Windows 2025**. See [UK NCSC Device Security Guidance](#uk-ncsc-device-security-guidance).
* On Microsoft Security Baselines, DISA STIG or Custom Baselines, use **Import policy JSON** to select one or more `.json` files. Each file holds one policy or an array of policies.

The header shows how many policies are loaded. Then:

1. Enter **Source version / profile**, for example "approved workstation baseline, revision 3, standard profile". It is required before you can compare, and is limited to 200 characters. The NCSC pack fills it in for you.
2. Expand **Review *N* loaded policies and remove alternative profiles**. Some packs include alternative profiles for some settings; click **Remove** next to the ones you do not use. Alternatives left in the pack produce **Review** findings.
3. Optional: click **Export coverage and source mappings** to save a JSON inventory of every policy and setting mapping, its provenance, and the areas outside automated coverage.

#### Requirements for imported policies

* Between 1 and 200 policies, 8 MB in total.
* Each policy needs `name`, `platforms`, `technologies` and a non-empty `settings` array.
* Each setting needs a `settingInstance` with a `settingDefinitionId` and its `@odata.type`.
* Tenant-specific IDs, assignments, scope tags and export annotations are removed from what TenuVault would create.

Errors such as "Policy 3: expected a Settings Catalog export with name, platforms, technologies and settings." tell you which policy to fix.

### 2. Compare with your tenant

Click **Run comparison** (**Compare again** for later runs). TenuVault reads all Settings Catalog policies in the tenant, every page of each policy's settings, and each policy's assignments. If any read fails or is incomplete, the comparison stops instead of reporting settings as missing.

The result shows how many tenant policies were read and when. Filter the findings with **All**, **Present**, **Missing**, **Different** and **Review**:

| Result | Meaning |
| --- | --- |
| **Present** | Every occurrence of the setting in your tenant matches the recommended configuration. |
| **Missing** | No policy of the same family and platform configures the setting. |
| **Different** | At least one occurrence differs from the recommendation, even if another policy matches. |
| **Review** | The pack contains alternative values for this setting. Remove the alternative profiles, or resolve the recommendation yourself. |

How matching works:

* Settings are matched by their setting definition, never by policy name.
* Nested values are compared. Extra nested values in your policy produce **Different**.
* Collections are compared in order, so a reordered collection may show **Different** and need manual review.
* An unassigned policy can still be **Present**.

Expand a finding to see **Recommended configuration** next to **Observed policies and configuration**. The observed side lists each matching policy with its value and its assignment evidence: all devices, all users, groups, exclusions and filter references. Targeting is reported as unassigned, configured, review or unavailable. A denied or incomplete assignment read is shown as unavailable, never as unassigned.

Findings are shown 50 per page. Click **Export report** to save the assessment as JSON.

:::note
A configuration match is evidence for review. It does not prove the setting is assigned to the right devices or enforced on them. Group membership, filter evaluation, device applicability, device enforcement and organizational controls need separate assessment.
:::

### 3. Review unassigned policies

You can create the **Missing** settings as new policies. This step is not available for the UK NCSC Device Security Guidance pack, which is comparison and reports only.

To create policies:

1. Tick the **Missing** findings you want. Only **Missing** findings can be selected. The footer shows how many settings and new policies your selection makes, for example "4 missing root settings selected · 2 new policies".
2. Click **Preview recommended policies**.
3. Expand **Inspect the exact policy payloads** to see what will be sent.
4. Tick "I reviewed these recommendations and want to create unassigned policies in *tenant*."
5. Click **Create *N* unassigned policies**.

What TenuVault creates:

* One new policy per source policy you selected settings from, named `[Baseline]` followed by the source policy name. Its description records the source version and that it was created unassigned.
* Only the selected settings, with their nested dependent settings.
* No assignments. Existing policies are never changed or deleted.

Before writing, TenuVault reads the tenant again. If your policies changed since the comparison, it stops with "The tenant policy landscape changed. Compare again before creating policies." A comparison can be used for creation once, within 15 minutes.

The result lists each policy with its new ID or its error, followed by "Unassigned policies created. Assignment and device verification are still required." Review the new policies and their conflicts in Intune before you assign them. Run the comparison again to confirm the settings now show as **Present**.

## UK NCSC Device Security Guidance

The UK National Cyber Security Centre publishes its recommended device settings as [configuration packs](https://github.com/ukncsc/Device-Security-Guidance-Configuration-Packs). TenuVault loads the nine Windows Settings Catalog policies of the 2025 pack (Defender, Defender Antivirus, attack surface reduction, App Control for Business, BitLocker, Device Control, Windows Security Experience, Microsoft Edge and General, 187 root settings) from a pinned commit and checks every file against a reviewed SHA-256 hash. If any file cannot be downloaded, does not match its hash or cannot be parsed, nothing is loaded.

* **Compared:** the Windows Settings Catalog policies, with your tenant's Settings Catalog policies.
* **Not assessed:** the Windows endpoint security exports (Account Protection, Application Control) and the Surface DFCI device configuration export, which use legacy policy formats; the AppLocker XML rules; and the Apple, Android and ChromeOS guidance, which is not in Intune policy format.
* **Review findings:** the pack configures some settings in more than one policy with different values, which shows about ten settings as **Review**. Decide which value applies to your estate.
* **Comparison and reports only:** you can compare, save and export PDF, CSV and JSON reports on every plan. Creating policies from the NCSC pack is not available.

Contains NCSC configuration packs, Crown Copyright, licensed under the [Apache License 2.0](https://github.com/ukncsc/Device-Security-Guidance-Configuration-Packs/blob/681e07584d3f7a84549ff26bda83e4f1480703f6/LICENSE). TenuVault modifies the content for comparison: it decodes the files from UTF-16 and removes export metadata, IDs, assignments and scope tags. No endorsement by NCSC. Every export of an NCSC assessment carries this notice.

## Saved policy-pack workspace and history

Loaded packs, source versions and assessment results are saved per tenant and framework in encrypted storage on this device. Under **Saved workspace and history** you can:

* **Export workspace** to save the whole workspace as JSON.
* **Delete workspace** to remove the packs and all history for this framework and tenant.
* **View read-only** to open a saved assessment. Historical assessments cannot be used to create policies; run a fresh comparison first.
* **Export** or **Delete** a single saved assessment. Deleting an assessment also cancels its pending creation.

A workspace keeps up to 50 assessments and 32 MB. When it is full, TenuVault shows "Workspace history is full. Export and delete older assessments before continuing."

## What policy-pack comparisons do not assess

Policy-pack comparison covers Settings Catalog policies only. These areas are outside its scope:

* Compliance policies
* Update rings
* Legacy security baseline templates
* Application deployment
* Device enforcement and applicability
* Organizational controls and manual audit evidence

Conflicts with other policy families are not evaluated. Profile selection and approval, organizational safeguards and device-side validation remain manual.

## Troubleshooting comparisons

| Message | Cause and fix |
| --- | --- |
| A comparison for this framework is already running. | A comparison for this tenant and framework is still in progress. Wait for it to finish, follow its progress on the framework page, or cancel it. |
| This comparison is too large to save. Narrow the platforms in scope and compare again. | The result exceeds the local history storage limit. Select fewer platforms and compare again. |
| Scope or ruleset changed. These runs cannot be compared as tenant configuration drift. | The two comparisons used different platforms, levels or a different ruleset version. Pick a saved comparison with the same scope, or review them separately. |
| Choose valid platforms, maturity level and risk level. | Select at least one platform and a valid target level, then compare again. |
| Request failed (403) at ... Check Intune permissions for this tenant. | Your account or the app registration cannot read Settings Catalog policies. Check your Intune role. |
| Policy settings changed during the read. Compare again. | A policy changed while TenuVault read it. Run the comparison again. |
| This assessment has expired or was already used. Run comparison again. | More than 15 minutes passed, or policies were already created from it. Compare again. |
| Another baseline creation is in progress for this tenant. | Wait for the current creation to finish. |
| The selection repeats a setting across multiple policies. Select it from one policy only. | Deselect the duplicate setting in one of the policies. |
| Provide a source version and profile (up to 200 characters). | Fill in **Source version / profile**. |
| The policy pack exceeds 8 MB. | Import fewer or smaller files. |

## Related pages

* [OpenIntuneBaseline](/baselines/quick-start/), to deploy, compare and validate OIB policies
* [Drift detection](/drift/)
* [Plans and features](/licensing/)

UK NCSC Device Security Guidance content is Crown Copyright, licensed under the [Apache License 2.0](https://github.com/ukncsc/Device-Security-Guidance-Configuration-Packs/blob/681e07584d3f7a84549ff26bda83e4f1480703f6/LICENSE).
