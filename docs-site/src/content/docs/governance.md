---
title: "Governance"
description: Read baseline scores, review policy conflicts and hygiene findings, and record organization customizations and golden standards.
---

Governance answers three questions for the tenant selected in the tenant switcher: are we compliant, where do we deviate on purpose, and who accepted it? It groups six screens: **Overview**, **Baseline scores**, **Conflicts and hygiene**, **Accepted deviations**, **Customizations**, and **Golden standards**. Decisions made on these screens (hygiene reviews, customizations, standard adoptions and exception decisions) are recorded in the [audit log](/audit-log/). Golden standard publications are shared across customers, so they stay in the version's own history instead of one customer's audit log. Applying changes happens in [Changes](/changes/), never here.

Open **Governance** in the sidebar, then choose a screen at the top of the page. Without a connected tenant the page says "Connect or select a tenant to use governance." and no screen runs.

## Overview

The **Overview** is the landing screen. It reads only what the other Governance screens already show (saved comparisons, the latest hygiene scan, stored standards records), so every figure names its source and age: the latest baseline score with coverage, open definite and possible hygiene findings, accepted deviations with expired ones marked, and standard deviations and pending upgrades. **Needs attention** lists what waits first, each with a link to its owning screen. **Export evidence pack** saves one dated JSON with the scores, hygiene findings, adoption states, customizations and the accepted deviations register, headed by a notice that states what the evidence is and is not, and how fresh each section is. Each screen also names its own source and age in a "Source:" line, because scores, hygiene and standards are snapshots of different ages, not one live truth.

## What your plan includes

| Screen | Community | Pro | MSP |
| --- | --- | --- | --- |
| Overview and Baseline scores | No | Yes | Yes |
| Conflicts and hygiene | No | Yes | Yes |
| Accepted deviations and Customizations | No | Yes | Yes |
| Golden standards, adoption and portfolio | No | No | Yes |

On a plan that does not include a screen, the tab shows a plan badge and a locked preview that describes what the screen does, with **See plans**. Records that were already created and stored on an earlier plan stay readable after a downgrade; only creating new records needs the plan. Baseline scores are the exception: scores are computed on request and never stored, so after a downgrade there is no stored score to read and the tab shows only its locked preview. See [Plans and features](/licensing/).

## Baseline scores

Baseline scores turn the framework comparisons you already saved into one score per framework for the selected tenant. Scores are computed on request from saved results and are never stored, so this screen shows nothing until a comparison exists.

### Before you start

* Run and save a comparison on the [Framework coverage](/baselines/frameworks/) page, or a validation in [OpenIntuneBaseline](/baselines/quick-start/), for this tenant.
* Comparisons older than 30 days are marked **Stale**. Run the comparison again to refresh the score.

### Read the scores

1. Select the tenant in the tenant switcher.
2. Open **Governance** in the sidebar and choose **Baseline scores**.
3. Click **Refresh** to recompute the scores from the saved comparisons.

Each framework card shows the framework name, version, profile and mapping version, the **Technical score** together with its coverage, for example "9.6% on 96% coverage", the number of **Unknown** results and **Gaps**, and when it was assessed. Under the score, the card lists how many capabilities were counted as matching, different, missing, unknown and outside scope, and the **Top actionable gaps** with their priority. Click **Export CSV** or **Export JSON** at the top of the screen to save the scores currently shown.

**Gaps** are the capabilities counted different or missing, so the gap count always equals different plus missing. A capability counted matching is never listed as a gap. Each gap says how it was counted, for example "Configured but unassigned, counted missing" or "An assigned policy sets a different value". The CSV and JSON exports use the same count and the same labels.

A card marked **Partial collection** means a policy type could not be read, so evidence in it may be missing. Policy types that a comparison does not read by design, such as scripts, app configuration and enrollment settings, are not a read gap. The framework page and the card read the same rule, so they always agree for one comparison.

The score compares Intune and Conditional Access configuration with a technical mapping. It does not prove enforcement on devices or compliance with the full framework.

The **Baseline score** tile on the dashboard shows the most recently assessed score, names its framework, and shows its coverage in the same format as the card.

### How the score is counted

Score is matching divided by matching plus different plus missing, over evaluated capabilities only. Each capability counts once using its best assigned policy evidence, and unassigned policies cannot count as matches. Unknown results are left out of the score and shown as coverage, which is evaluated divided by evaluated plus unknown. A framework reference that has no configuration check counts once as unknown, and the card says how many of the unknown results are such references. Outside scope results are not counted. When nothing could be evaluated there is no score, shown as **Not scored**, never 0 or 100 percent.

Read the score and its coverage together. A partial collection can change the coverage and the score without any change in the tenant.

### Look at the controls behind a score

1. On a framework card, click **How this score is counted**.
2. Read **Counted capabilities**. Every capability and framework reference is listed once under the result it was counted as: **Different**, **Missing**, **Unknown**, **Matching** and **Outside scope**, each with the reason. The groups add up to the counts on the card, so you can trace a low score item by item. Different and missing capabilities also show their controls, the settings and policies behind them, including whether a policy is assigned, and the priority reasons.
3. Read **Source controls**, which lists every control with its status and its gap count. A capability can support several controls, so the per-control counts add up to more than the gap count on the card.
4. Click **Close** to return, or **Open comparison** on the card to open the saved comparison itself.

Only one detail panel is open at a time, whether you open it from a card or from the portfolio. **Refresh** reloads the scores and an open detail.

A **Trend of compatible comparisons** line connects only assessments of the same framework version, profile and scope. A point with partial collection is drawn hollow. Comparisons that do not match, and saved results that set no score, are listed separately under the trend with the reason.

### Scores after an app update

When an app update changes how capabilities are counted or changes a framework mapping, earlier comparisons stay saved but no longer set a score. The screen lists such a framework under **Saved results without a score** with "Scored under older rules. Compare again to score." and the reason. On the framework page, those comparisons carry the label **Scored under older rules** in **Comparison history**. Run **Compare again** to score the framework under the current rules.

The scores update as soon as a framework comparison or an OpenIntuneBaseline validation finishes, on this screen and on the dashboard.

### OpenIntuneBaseline scores

OpenIntuneBaseline cards count expected settings instead of capabilities. Only a full validation, **Validate all** in Policy Validation, sets the card score and trend. A single policy check is saved in history but does not change the score. A platform with only single policy checks is listed under **Saved results without a score**. The version on the card is the OIB reference and commit, for example `windows-v4.0 @ 1cc71a9`, with the full commit shown below it. A trend connects only validations of the same OIB reference and the same commit. A published release tag points at one commit, so its validations stay on one trend; a branch that moves to a new commit starts a new trend, and the earlier validations are listed with "Framework version changed" as the reason. A saved validation without a recorded commit is never connected to another one. A saved validation that cannot be read is left out on its own and does not hide the other validations of its platform.

### Portfolio scores (MSP)

With MSP, the **Portfolio** section at the bottom of the screen shows scores per customer tenant from each tenant's own saved comparisons.

1. Click **Load portfolio**, or **Refresh portfolio** after the first load.
2. In the table, use **Details** on a row to open how that tenant's score is counted.

A framework whose saved results set no score, such as comparisons scored under older rules or OpenIntuneBaseline single policy checks, shows the date of its newest saved result and the reason instead of a coverage figure. A tenant without any saved comparison reads "No saved comparison yet."

Tenants without an MSP license or without sign-in are listed as not included and are never guessed.

### Limits

* Scores come only from saved native comparisons and OpenIntuneBaseline validations. Nothing is read from the live tenant to build a score.
* A partial collection is marked **Partial collection**, and frameworks whose saved comparison could not be read are listed without a score. When several frameworks fail for the same reason, the reason is shown once with **Retry**. If a refresh of the scores or of an open detail fails, the error is shown with **Retry** and the earlier results and exports are hidden until a read succeeds, so an old score is never shown as current.

## Conflicts and hygiene

Conflicts and hygiene finds candidate conflicting settings, duplicate profiles, unassigned policies, broken references and settings Microsoft lists as deprecated in the current Settings Catalog in the selected tenant. Findings are built from the latest complete backup, not from the live tenant.

### Run a scan

1. Select the tenant in the tenant switcher.
2. Open **Governance** in the sidebar and choose **Conflicts and hygiene**.
3. Click **Scan latest backup**. While it runs the button shows "Scanning backup".

A scan reads the latest complete backup. It does not change the tenant. Apart from the backup it only reads whether referenced groups exist and the current Settings Catalog definitions, and it never deletes or changes a policy. If no scan has run yet, the screen says so and offers the same button.

The findings stay those of the last scan until you scan again: a newer backup does not update them on its own. The screen names the source backup and its collection date, and warns when that backup was collected more than 7 days ago.

### Read a scan

The latest scan shows when it was collected, the source backup, how many objects were inspected, how many findings are definite and possible, and when the Settings Catalog was checked. Types that were not collected are shown as not collected, not as clean. Group membership, filters and device state are not collected, so overlaps that depend on them stay possible, never proven. When the Settings Catalog cannot be read during a scan, deprecated settings are shown as a check that could not be made, never as clean.

Use the filters above the findings to narrow the list:

* **Status**: open and acknowledged, all, or one status.
* **Classification**: all, **Definite** or **Possible**.
* **Rule**: all rules or one rule.
* **Search**: type a finding or policy name in "Finding or policy name".

Click **Export CSV** or **Export JSON** to save the findings currently shown with the filters applied.

#### Deprecated settings

A **Deprecated settings** finding names one setting and every collected policy that configures it. The scan compares the settings in the backup with the current Settings Catalog read during the same scan. Microsoft Graph has no deprecation flag, so only the catalog's own wording counts: the setting name says deprecated or obsolete, or its description says the policy or setting is deprecated. Settings announced as "[to be deprecated]" are reported separately at low severity. A setting whose definition is no longer in a completely read catalog is reported as **Possible** only.

Deprecated does not prove a setting no longer applies on devices, and the catalog does not name a replacement setting. Treat each finding as a prompt to review the policy in Intune and replace or remove the setting there. TenuVault never changes the policy for you. Each finding shows two dates: when the backup was collected and when the Settings Catalog was checked. For how Microsoft marks deprecated settings and how to run the same check with Microsoft Graph, see how to [find deprecated Intune settings](https://www.tenuvault.com/guides/find-deprecated-intune-settings).

### Review a finding

1. Click a finding to expand it. The detail shows the rule and its limits, the evidence backup and collection date, the affected objects, and the setting values per policy.
2. To accept a finding you have checked, write a note in "Note or false positive reason" if you want one, then click **Acknowledge**.
3. To mark a finding that does not apply, write the reason first, then click **Mark as false positive**. The button stays disabled until a reason is entered.
4. To return an acknowledged or false positive finding to the open list, write a reason for reopening if you want one, then click **Reopen**.

Reviews never change or delete a policy. A review is reopened automatically when the evidence changes. The **History** section of a finding lists earlier reviews, and each review decision is recorded in the [audit log](/audit-log/) and listed in [Accepted deviations](#accepted-deviations). **Document this setting as a customization** records a deliberate difference with the setting and policy prefilled.

### Fleet summary (MSP)

With MSP, the **Fleet summary** section shows stored findings per customer tenant. Click **Load fleet summary**, or **Refresh fleet** after the first load, to see each tenant's latest collection, open definite and possible counts, reviewed count, and the top of its queue. Each customer is scanned and reviewed on its own. Tenants without an MSP license or without sign-in are listed as not included.

### Limits

* Only the latest complete backup is scanned. Backups that failed or stopped early are not used.
* A finding marked possible needs group, filter or device context to confirm. Unknown membership is not proof either way.

## Accepted deviations

**Accepted deviations** is one read-only register of what this tenant knowingly does differently: active customizations, hygiene findings a reviewer acknowledged or marked false positive, and approved standard exceptions. Each entry shows its setting, policy, owner or approver, reason, when it was decided, the age of its evidence, and its expiry where one is recorded. Expired entries sort first and are marked **Expired**; they need a new decision on their owning screen. Filter by **Kind** or **Expired only**, and use **Export CSV** or **Export JSON** to save the register as shown. The register changes nothing itself.

## Customizations and golden standards

These are two screens. **Customizations** (Pro and MSP) records where this tenant deliberately differs from its installed baseline. **Golden standards** (MSP) keeps reusable, versioned standards that you adopt per customer tenant through reviewed change sets.

### Document a customization

1. Open **Governance** in the sidebar and choose **Customizations**. Links from a score gap (**Document as customization**) or a hygiene finding open this screen with the setting and policy already filled in.
2. In **Organization customizations**, fill in **Title**, **Setting definition ID**, **Reason** and **Owner**. The setting and policy fields suggest values from the hygiene evidence already collected, so an ID can be picked instead of typed. **Policy name (optional)**, **Organization value (optional)** and **Re-review by (optional)** can be left empty. A re-review date makes the customization expire in the Accepted deviations register.
3. Click **Document customization**.

Records are versioned and nothing here changes the tenant. For an active record, click **Change owner** to save a new owner as a new version, or **Retire** and enter why it is retired, then click **Save**. Click **Cancel** to leave a record unchanged.

### Create a golden standard (MSP)

1. In **Golden standards**, fill in the **New standard** form: **Key (lowercase, hyphens)**, **Name** and **Change notes**.
2. Choose the **Source**: **Settings Catalog exports**, then enter a **Source reference** and paste **Policies (JSON array of Settings Catalog exports)**, or **OpenIntuneBaseline (latest release)**, then choose the **Platform**. The exact commit is recorded with the standard.
3. Add parameters and bindings with the **Add a parameter** and **Add a binding** fields (each appends one entry to the JSON below, which stays editable), or edit **Parameters (JSON array: name, label, type string, integer, choice or reference, required, default, min, max, options, renamedFrom)** and **Bindings (JSON array: policyKey, settingDefinitionId, parameter)** directly. Binding setting IDs are suggested from the pasted policy exports, and the policies themselves can be loaded from an export file instead of pasted.
4. Click **Publish standard**.

Versions are immutable and stored without tenant evidence. Tenant specific values are parameters, and tenant references must be bound to a reference parameter. On a published version, click **What changed** to compare it with the previous version, or **New version** to publish the next version from the latest one. A new base version never changes a customer tenant by itself.

### Adopt a standard for a customer (MSP)

1. On the latest version of a standard, click **Adopt for** followed by the tenant name.
2. In **Standards adopted by** the tenant, click the adoption to open it.
3. Set the parameters, choose for each standard policy whether to create a new policy or update an existing one (enter its **Existing policy ID** when updating), and edit the **Overlay (JSON: settings as policyKey and setting instance, removals, exceptions with reason, approver and expiry)**. The overlay stays separate from the base standard.
4. Click **Save configuration**, then **Preview effective settings** to see the result and any problems.
5. Click **Assess deviation** at any time to record how the tenant differs from the adopted version.
6. When the preview is ready, click **Create change set**, then work through the change set below it: review the diff, approve it, apply it, and use its rollback when needed. See [Changes](/changes/) for how change sets are reviewed and applied.

Customers keep their adopted version until you adopt a newer one for them. When a newer version exists, **Configure for** the new version starts the same reviewed flow. In **Standards adopted by** the tenant, click **Export CSV** or **Export JSON** to save the adoption states currently shown.

### Adoption across customers (MSP)

The **Adoption across customers** section shows the adopted version, pending upgrade, deviation and assessment freshness per tenant. When some policies of an adoption could not be assessed, the deviation is shown as unknown, never as 0. Click **Load portfolio** to fill the table. Connected tenants without MSP are named as not included.

### Limits

* Organization customizations only document a difference. They do not change any policy.
* A golden standard holds no tenant evidence. Customer values live in parameters, mappings and the overlay of each adoption.
* Applying an adoption always goes through a reviewed change set. Nothing is written by publishing a standard or saving a configuration.
