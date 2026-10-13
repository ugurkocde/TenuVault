---
title: "Governance"
description: Read baseline scores, review policy conflicts and hygiene findings, and record organization customizations and golden standards.
---

The **Governance** hub groups three screens for the tenant selected in the tenant switcher: **Baseline scores**, **Conflicts and hygiene**, and **Standards and customizations**. It helps you see how the tenant compares with frameworks, find candidate policy problems, and document where your organization deliberately differs from a baseline.

Open **Governance** in the sidebar, then choose a screen at the top of the page. Without a connected tenant the page says "Connect or select a tenant to use governance." and no screen runs.

## What your plan includes

| Screen | Community | Pro | MSP |
| --- | --- | --- | --- |
| Baseline scores | No | Yes | Yes |
| Conflicts and hygiene | No | Yes | Yes |
| Standards and customizations: organization customizations | No | Yes | Yes |
| Standards and customizations: golden standards, adoption and portfolio | No | No | Yes |

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

Each framework card shows the framework name, version, profile and mapping version, the **Technical score**, **Coverage**, the number of **Unknown** results and **Gaps**, and when it was assessed. Under the score, the card lists how many capabilities are matching, different, missing, unknown and outside scope, and the **Top actionable gaps** with their priority. Click **Export CSV** or **Export JSON** at the top of the screen to save the scores currently shown.

The score compares Intune and Conditional Access configuration with a technical mapping. It does not prove enforcement on devices or compliance with the full framework.

### How the score is counted

Score is matching divided by matching plus different plus missing, over evaluated capabilities only. Each capability counts once using its best assigned policy evidence, and unassigned policies cannot count as matches. Unknown results are left out of the score and shown as coverage, which is evaluated divided by evaluated plus unknown. Outside scope results are not counted. When nothing could be evaluated there is no score, shown as **Not scored**, never 0 or 100 percent.

### Look at the controls behind a score

1. On a framework card, click **Controls and gaps**.
2. Read **Gaps**, which lists each differing or missing capability with its controls, settings and priority reasons, then **Source controls**, which lists every control with its status.
3. Click **Close** to return, or **Open comparison** on the card to open the saved comparison itself.

A **Trend of compatible comparisons** line connects only assessments of the same framework version, profile and scope. Comparisons that do not match are listed separately under the trend and are not connected to it.

### Portfolio scores (MSP)

With MSP, the **Portfolio** section at the bottom of the screen shows scores per customer tenant from each tenant's own saved comparisons.

1. Click **Load portfolio**, or **Refresh portfolio** after the first load.
2. In the table, use **Controls** on a row to open that tenant's controls and gaps.

Tenants without an MSP license or without sign-in are listed as not included and are never guessed.

### Limits

* Scores come only from saved native comparisons and OpenIntuneBaseline validations. Nothing is read from the live tenant to build a score.
* A partial collection is marked **Partial collection**, and frameworks whose saved comparison could not be read are listed without a score.

## Conflicts and hygiene

Conflicts and hygiene finds candidate conflicting settings, duplicate profiles, unassigned policies and broken references in the selected tenant. Findings are built from the latest complete backup, not from the live tenant.

### Run a scan

1. Select the tenant in the tenant switcher.
2. Open **Governance** in the sidebar and choose **Conflicts and hygiene**.
3. Click **Scan latest backup**. While it runs the button shows "Scanning backup".

A scan reads the latest complete backup. It does not read or change the tenant apart from checking whether referenced groups exist, and it never deletes or changes a policy. If no scan has run yet, the screen says so and offers the same button.

### Read a scan

The latest scan shows when it was collected, the source backup, how many objects were inspected, and how many findings are definite and possible. Types that were not collected are shown as not collected, not as clean. Group membership, filters and device state are not collected, so overlaps that depend on them stay possible, never proven.

Use the filters above the findings to narrow the list:

* **Status**: open and acknowledged, all, or one status.
* **Classification**: all, **Definite** or **Possible overlap**.
* **Rule**: all rules or one rule.
* **Search**: type a finding or policy name in "Finding or policy name".

Click **Export CSV** or **Export JSON** to save the findings currently shown with the filters applied.

### Review a finding

1. Click a finding to expand it. The detail shows the rule and its limits, the evidence backup and collection date, the affected objects, and the setting values per policy.
2. To accept a finding you have checked, write a note in "Note or false positive reason" if you want one, then click **Acknowledge**.
3. To mark a finding that does not apply, write the reason first, then click **Mark as false positive**. The button stays disabled until a reason is entered.
4. To return an acknowledged or false positive finding to the open list, write a reason for reopening if you want one, then click **Reopen**.

Reviews never change or delete a policy. A review is reopened automatically when the evidence changes. The **History** section of a finding lists earlier reviews.

### Fleet summary (MSP)

With MSP, the **Fleet summary** section shows stored findings per customer tenant. Click **Load fleet summary**, or **Refresh fleet** after the first load, to see each tenant's latest collection, open definite and possible counts, reviewed count, and the top of its queue. Each customer is scanned and reviewed on its own. Tenants without an MSP license or without sign-in are listed as not included.

### Limits

* Only the latest complete backup is scanned. Backups that failed or stopped early are not used.
* A finding marked possible needs group, filter or device context to confirm. Unknown membership is not proof either way.

## Standards and customizations

This screen has two parts. **Organization customizations** (Pro and MSP) records where this tenant deliberately differs from its installed baseline. **Golden standards** (MSP) keeps reusable, versioned standards that you adopt per customer tenant through reviewed change sets.

### Document a customization

1. Open **Governance** in the sidebar and choose **Standards and customizations**.
2. In **Organization customizations**, fill in **Title**, **Setting definition ID**, **Reason** and **Owner**. **Policy name (optional)** and **Organization value (optional)** can be left empty.
3. Click **Document customization**.

Records are versioned and nothing here changes the tenant. For an active record, click **Change owner** to save a new owner as a new version, or **Retire** and enter why it is retired, then click **Save**. Click **Cancel** to leave a record unchanged.

### Create a golden standard (MSP)

1. In **Golden standards**, fill in the **New standard** form: **Key (lowercase, hyphens)**, **Name** and **Change notes**.
2. Choose the **Source**: **Settings Catalog exports**, then enter a **Source reference** and paste **Policies (JSON array of Settings Catalog exports)**, or **OpenIntuneBaseline (latest release)**, then choose the **Platform**. The exact commit is recorded with the standard.
3. Add **Parameters (JSON array: name, label, type string, integer, choice or reference, required, default, min, max, options, renamedFrom)** and **Bindings (JSON array: policyKey, settingDefinitionId, parameter)** as needed.
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

The **Adoption across customers** section shows the adopted version, pending upgrade, deviation and assessment freshness per tenant. Click **Load portfolio** to fill the table. Connected tenants without MSP are named as not included.

### Limits

* Organization customizations only document a difference. They do not change any policy.
* A golden standard holds no tenant evidence. Customer values live in parameters, mappings and the overlay of each adoption.
* Applying an adoption always goes through a reviewed change set. Nothing is written by publishing a standard or saving a configuration.
