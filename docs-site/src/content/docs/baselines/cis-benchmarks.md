---
title: "CIS Benchmarks"
description: Assess and remediate Intune against delivered CIS Benchmark packs, with the certified scope, readiness per Level, reviewed remediation and PDF, CSV and JSON exports.
---

**CIS Benchmarks** compares your tenant's Intune Settings Catalog policies with a CIS Benchmark pack, Level by Level, shows how ready the tenant is, and remediates deviating settings through a reviewed change set. It has its own entry in the sidebar.

## Certification and scope

TenuVault is CIS Benchmarks Certified for Assessment and Remediation. CIS awarded the "CIS Benchmark Assessment Certified" and "CIS Benchmark Remediation Certified" status on 2 November 2026. The certification covers only these benchmarks and Levels:

| Benchmark | Version | Certified Levels |
| --- | --- | --- |
| CIS Microsoft Intune for Windows 11 Benchmark | v5.0.0 | Level 1 |
| CIS Microsoft Intune for Microsoft Defender Antivirus Benchmark | v1.0.0 | Level 1 and Level 2 |
| CIS Apple macOS 26 Tahoe Intune Benchmark | v1.0.0 | Level 1 and Level 2 |

Other CIS Benchmarks, versions and Levels are not certified. The CIS Benchmarks page and the benchmark picker state this scope, and every CIS export (PDF, CSV and JSON) carries it together with the limits of remediation and the CIS notice with its link.

The certification belongs to TenuVault, not to your tenant. Assessment results compare the recorded Intune configuration with the benchmark pack. They do not certify your tenant's compliance with a CIS Benchmark.

## Plans

CIS Benchmarks is included in **Pro** and **MSP**. On Community, the sidebar entry carries a plan badge and opens the CIS Benchmarks page, which shows a preview instead of the benchmark picker:

- The certification statement and each certified benchmark Level with how many of its recommendations TenuVault checks automatically. For example, TenuVault checks 274 of the 308 recommendations of the Windows 11 benchmark Level 1 automatically; the rest are listed for a manual check.
- What Pro and MSP add: assessment against the delivered benchmark pack per Level, readiness with pass rate and coverage, Manual and Not assessed recommendations listed with their CIS text, remediation per recommendation through a reviewed deployment with backup, read-back and rollback, PDF, CSV and JSON exports, and on MSP, CIS scores across the tenants in your portfolio.
- Ways to start the 30 day trial or see the plans, and to add a license key.
- **View sample report**, which saves a sample CIS readiness PDF where you choose. Every plan can open it. It is marked SAMPLE DATA on every page and uses a fictional tenant, fictional results and placeholder recommendation titles and text, so it is not a real assessment and holds no CIS content. It shows the layout of a real report: readiness per Level, recommendation results with remediation labels, a Manual section, the certification statement and the limits of remediation.

Benchmark packs and recommendation lists are delivered only to tenants on Pro or MSP, so the preview loads nothing from the delivery service. Assessments and deployments saved on an earlier plan stay readable, and changes a deployment applied can still be rolled back after the plan ends (see [Roll back](#roll-back)); the preview shows when you start a new assessment. See [Plans and features](/licensing/).

CIS Controls is not available yet and stays marked **Coming soon**.

## How benchmark content is delivered

Benchmark packs and their recommendation lists are not part of the TenuVault installer. TenuVault downloads them at runtime from its delivery service, for licensed installations only, using the license of the selected tenant. A loaded pack is stored in encrypted storage on this device for that tenant. You may use CIS content only within TenuVault and in the reports and exports it produces, and share those reports and exports within your organization, with your auditors and advisers and, on MSP, with the customer whose tenant a report covers. Publishing or redistributing CIS content is not allowed (EULA section 5.3).

If the delivery service refuses the license, the page shows "CIS Benchmarks content is not available for this license yet." If delivery is switched off or temporarily unavailable, it shows "CIS Benchmarks content delivery is unavailable right now. Try again later." If the service cannot be reached at all, for example because a firewall or proxy blocks `https://www.tenuvault.com/cis/v1/` or the request times out, it shows "The CIS content delivery service could not be reached." (see [Network connections and data flows](/security/data-flows/#cis-benchmarks-content)). Click **Retry** to try again.

## 1. Load a benchmark

Select the tenant in the sidebar and open **CIS Benchmarks**. Under **1. Load benchmark**, TenuVault lists the benchmarks available to your license, each with its version and Levels. Every Level is marked **CIS Certified** or **Not certified**.

1. Click the Level you want to assess, for example **Level 1**. TenuVault loads the pack and saves it for the selected tenant.
2. Click **Refresh available benchmarks** to check for updated benchmarks later.

Loading a pack does not change your tenant.

## 2. Compare with your tenant

Click **Start Assessment** (**Run again** for later runs). TenuVault reads every Settings Catalog policy of the tenant, its settings and its assignments, and compares them with the pack. The assessment is read-only. Its progress shows the current step and partial tallies; the assessment keeps running in the background if you leave the page.

Each pack setting gets one result:

| Result | Meaning |
| --- | --- |
| **Present** | Every occurrence of the setting in your tenant has the recommended value. |
| **Different** | At least one occurrence has another value. |
| **Missing** | No Settings Catalog policy configures the setting. |
| **Review** | The pack holds alternative values for the setting. Choose the profile that applies to you. |

## 3. Read the results

The readiness view shows each Level of the benchmark:

* **Pass rate.** When the pack lists its recommendations, the headline is the recommendation pass rate: a recommendation passes only when every setting it names is in the pack and **Present**, and fails when any of them is **Different** or **Missing**. Otherwise the headline is the settings pass rate.
* **Coverage.** A line in plain words says how much of the full benchmark the pack covers, when the list of all its automated recommendations is available, and that pass rates do not depend on it.
* **Recommendation results** list each recommendation with its settings and result, and whether TenuVault can remediate it (see [Remediation per recommendation](#remediation-per-recommendation)).
* **Manual recommendations** and **Not assessed by this tool** list the recommendations TenuVault does not check. Manual recommendations need a manual check by design. Not assessed recommendations are automated in CIS terms but not covered by the pack. Both show their CIS description, impact, audit and remediation text when the delivered list includes it, for you to check them yourself. Each is marked **Remediation: manual action** with the reason.
* **Exclusions.** Select findings and click **Exclude from score** to record an accepted exception with an owner, a reason and an expiry date. The pass rate with exclusions is shown next to the raw rate.

Every readiness view and report carries the CIS notice: "Not all recommendations from the CIS Benchmarks are included in this tool. Please refer to the CIS website to access the free CIS Benchmarks PDFs for manual assessment instructions." with a link to [https://www.cisecurity.org/cis-benchmarks](https://www.cisecurity.org/cis-benchmarks).

A configuration match is evidence for review. It does not prove that the setting is assigned to the right devices or enforced on them.

## 4. Remediate

Under **Remediate or deploy from these results**, select **Different** or **Missing** findings, then:

* Click **Plan remediation for *N* selected findings** to change only those settings, or
* Click **Deploy whole benchmark policies** to create the pack policies that hold the selected findings.

The planned deployment opens in **Remediation history**, where it goes through the same reviewed flow as every change set in TenuVault:

1. **Review** the preview: every policy that would be created or updated, the exact settings, and whether an updated policy is assigned. The preview is an offline comparison against the assessment, not a tenant dry run.
2. **Approve** it. Approval reads the tenant again; a changed tenant stops the deployment before anything is written.
3. **Apply** it. TenuVault runs a backup of the tenant first and captures the current state of every policy it changes; if the backup fails, nothing is written. Then it writes the changes and reads each one back to verify it.
4. **Roll back** if needed, see below.

Run the assessment again after an apply or a rollback to confirm which findings closed.

### Roll back

A rollback is a new change set built from the state TenuVault captured before the apply. It deletes the policies the deployment created and writes back the previous settings of the policies it updated, through the same review, approval, backup and read-back as the deployment. It stays available after your plan ends, so you can always undo a deployment that was applied while the tenant was on Pro or MSP. A new deployment needs Pro or MSP again.

A rollback does not always restore everything automatically:

* **Masked values.** A policy that held values Intune masks was captured without them, so TenuVault cannot write it back. The rollback preview names it; restore it by hand.
* **Created policy without an ID.** If Intune did not return the ID of a policy the deployment created, TenuVault cannot remove it. The preview asks you to check Intune for a policy with that name and delete it yourself.
* **Partial results.** An apply or a rollback writes one policy after another and is not a single transaction. Some operations can succeed while others fail or stay uncertain; each result is shown per operation, and **Reconcile and retry** checks the live state before writing again.
* **Devices.** A rollback changes Intune configuration only. It does not guarantee the previous state on devices.

See [How change sets work](/changes/#how-change-sets-work) for the review, apply, retry and rollback steps every change set shares.

### Limits of remediation

* TenuVault remediates only recommendations it assesses automatically: the settings in the delivered benchmark pack, written to Intune Settings Catalog policies.
* Manual recommendations and recommendations marked **Not assessed by this tool** cannot be remediated by TenuVault. They are listed for manual action, with their CIS text when the delivered list includes it.
* **Review** findings hold alternative values in the pack. They cannot be selected for remediation until the profile is chosen.
* **Missing** settings are created in new policies with no assignments. Nothing in them takes effect until an administrator assigns them in Intune.
* **Different** settings are updated in place in the tenant policies that hold them. Those policies keep their assignments, so the change reaches their assigned devices.
* Remediation changes Intune configuration only. It does not confirm that devices apply the settings.

### Remediation per recommendation

Every recommendation says whether TenuVault can remediate it, in the **Recommendation results**, the **Manual** and **Not assessed** lists, and in the PDF, CSV and JSON exports:

| Indication | Meaning |
| --- | --- |
| **Remediation: by TenuVault** | Every setting of the recommendation is in the delivered pack. TenuVault remediates its **Different** and **Missing** settings with a reviewed deployment. |
| **Remediation: by TenuVault after a profile choice** | A setting of the recommendation is a **Review** finding. Choose the profile before it can be remediated. |
| **Remediation: partly by TenuVault, partly manual action** | Some of its settings are in the pack and some are not. TenuVault remediates the ones in the pack; the others need manual action. |
| **Remediation: manual action** | None of its settings are in the pack, or it is a Manual or Not assessed recommendation. TenuVault does not remediate it. |

Findings exports state the same per setting: **Different** and **Missing** findings can be remediated by TenuVault, **Review** findings after a profile choice.

## Export results

Open **Export** in the results header:

| Export | Content |
| --- | --- |
| **PDF report** | Readiness per Level, recommendation results, Manual and Not assessed recommendations, exceptions, and the remediation indication of each recommendation. |
| **Findings CSV** and **Findings JSON** | One row per pack setting with its result, the observed tenant policies, their assignment evidence and its remediation indication. The CSV starts with the disclosure rows, then an empty row, then the table. |
| **Readiness CSV** and **Readiness JSON** | The readiness figures per Level, the recommendation results and the Manual and Not assessed recommendations, each with its remediation indication. |

Every CIS export, including the saved assessments JSON and the coverage export, carries the certified scope, the limits of remediation and the CIS notice with its link.

Exports are built on this device from the saved assessment, without reading the tenant again, and saved where you choose. Pro and MSP can brand the PDF in [Settings](/settings/#pdf-branding). Under **Saved assessments** you can view earlier assessments read-only, export them as JSON or delete them. On MSP, **Portfolio** compares the readiness of your customer tenants on one benchmark.

## Related pages

* [Framework coverage](/baselines/frameworks/)
* [Plans and features](/licensing/)
* [Changes](/changes/)

CIS, CIS Benchmarks and CIS Controls are trademarks of the Center for Internet Security, Inc.
