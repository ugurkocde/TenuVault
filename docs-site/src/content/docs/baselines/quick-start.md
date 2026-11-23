---
title: "OpenIntuneBaseline"
description: Deploy, compare, validate and assign OpenIntuneBaseline policies from the latest published release or a version you choose, with a backup first and undo per run.
---

The **OpenIntuneBaseline** section deploys, compares, validates and assigns [OpenIntuneBaseline](https://github.com/SkipToTheEndpoint/OpenIntuneBaseline) (OIB) policies in a tenant. It offers four workflows: **New Deployment**, **Existing Deployment**, **Policy Validation** and **Assignments**. Every write can be undone per run.

OpenIntuneBaseline is published by SkipToTheEndpoint and contributors under the GPL-3.0 license. TenuVault downloads the policy files from the upstream GitHub repository when you use them; they are not bundled with the app.

For an overview of the workflows before you choose one, see [OpenIntuneBaseline](https://www.tenuvault.com/openintunebaseline) on the product site.

## Where to find it

Select **OpenIntuneBaseline** in the sidebar. The section works on the tenant selected in the sidebar. OpenIntuneBaseline is not part of the [Frameworks](/baselines/frameworks/) catalog.

The header lists the version each platform uses, for example **Versions: Windows v4.0 · macOS v1.0 · Windows 365 v1.0 · BYOD v2.0**. If GitHub cannot be reached and no versions are known yet, the header shows the error with **Retry**.

<figure class="docs-screenshot">
  <a href="/images/screenshots/oib-home-light.webp" aria-label="Open full-size screenshot: oib home light">
    <img src="/images/screenshots/oib-home-light.webp" alt="OpenIntuneBaseline offers New Deployment, Existing Deployment and Policy Validation" width="2880" height="1800" loading="lazy" decoding="async" />
  </a>
  <figcaption>OpenIntuneBaseline offers New Deployment, Existing Deployment and Policy Validation; Assignments is the fourth workflow. Real public catalog with example tenant history. Select the image to view it full size.</figcaption>
</figure>

## Which OIB version is used

OIB publishes a release per platform, tagged for example `windows-v4.0` or `macos-v1.0`. By default each platform uses its latest published release. A platform without a published release uses the `main` branch and shows **main @ *commit*** instead of a version.

To use another version, click **Change versions** in the header on the OpenIntuneBaseline overview. Each platform offers its published releases, newest first, and `main`, which can hold changes that are not released yet. When a platform uses `main` ahead of its latest release, the header warns you to test in a pilot tenant first. A workflow keeps the versions it started with; change them on the overview.

TenuVault resolves every release tag and `main` to an exact commit and only loads commits it resolved itself, so a comparison and the deployment that follows see the same files. The release and commit are recorded on every deployment run, every validation run, and in the provenance of [custom baselines](/baselines/custom-baselines/) and installed baselines, so you can always see which version was used.

### Downloads and offline use

A platform's policy files are downloaded the first time a version is used, with the progress shown as files are downloaded. They are kept on this device by commit, so later sessions load them without contacting GitHub. When GitHub cannot be reached, TenuVault offers the versions it knew from the last successful check, and versions already downloaded keep working.

## Platforms

| Platform | Content |
| --- | --- |
| **Windows** | Windows 11 devices deployed by Autopilot |
| **macOS** | Apple macOS devices deployed by Apple Business Manager |
| **Windows 365** | Cloud PCs |
| **iOS** | Fully managed iOS devices |
| **Android** | Android Enterprise devices |
| **BYOD** | App protection policies for iOS and Android |

The platforms, their versions and development status come from the upstream `releases.json` manifest. New platforms the manifest marks as **in development** appear but cannot be scanned yet; platforms TenuVault already supports stay available. Beta releases are offered as a platform's latest version when you enable prereleases, and for platforms that only have a beta release (currently iOS) the beta is used by default with a warning. Published releases on the unstable channel are regular releases and are labelled in the version picker.

## What your plan includes

| | Community | Pro | MSP |
| --- | --- | --- | --- |
| New Deployment, Existing Deployment comparison and Policy Validation, every platform | Yes | Yes | Yes |
| Deploy new policies, with undo | Yes | Yes | Yes |
| Assign new policies to device and user groups when you deploy them | Yes | Yes | Yes |
| Update outdated policies in place | | Yes | Yes |
| **Assignments**: change the assignments of deployed policies | | Yes | Yes |
| **Fix drift** in Policy Validation | | Yes | Yes |
| **Customize**: your own baseline under My baselines | | Yes | Yes |
| **Also deploy to** other connected tenants in one run, with groups per tenant | | | Yes |

Community works in its one licensed tenant. Features that need a higher plan carry a plan badge, and the app refuses them in the main process as well. **Also deploy to** needs MSP on every tenant it reaches. Deployments, drift fixes and undo are written to the [audit log](/audit-log/); viewing the audit log needs Pro or MSP.

## Requirements

* The tenant is signed in and licensed.
* Backup storage is chosen for the tenant if you want the backup before a deployment, and always for in-place updates and drift fixes. See [Choose where backups are stored](/getting-started/choose-storage/).
* Your account has an Intune role that can read and create the policy types you deploy.
* The device can reach `api.github.com` and `raw.githubusercontent.com`. See [Network connections and data flows](/security/data-flows/).

## New Deployment

Use New Deployment the first time you deploy OIB to a tenant.

1. Select the operating systems to deploy and click **Continue**.
2. Answer the licensing questions: the tenant's primary licensing (**Microsoft 365 Business Premium** or **Microsoft 365 E3, E5 or E7**), whether Defender for Endpoint is the primary antivirus, and whether Windows updates are managed by Autopatch. Policies and policy types that do not suit the tenant are filtered out.
3. Choose the policy types, then review and select the policies. Policies already in the tenant are left out; use Existing Deployment to update them.
4. Set the deployment options and deploy. See [Deploy and undo](#deploy-and-undo).

<figure class="docs-screenshot">
  <a href="/images/screenshots/oib-new-platforms.webp" aria-label="Open full-size screenshot: oib new platforms">
    <img src="/images/screenshots/oib-new-platforms.webp" alt="New Deployment starts with the platform selection" width="2880" height="1800" loading="lazy" decoding="async" />
  </a>
  <figcaption>New Deployment starts with the platform selection. Real public catalog; no policies were deployed. Select the image to view it full size.</figcaption>
</figure>

### Read a policy's settings before you deploy it

Every policy in the list has **Show settings**. It lists each setting the policy configures in the selected OIB version, with its value, so you can read the baseline without importing it into a tenant first. Child settings are listed under the setting they belong to, and each item of a group setting (such as a list of rules) under its own **Item** line. When a policy has ten settings or more, **Filter settings** narrows the list by setting name, setting ID or value.

* Settings Catalog settings show their names and choices as Intune does. TenuVault reads them from the setting definitions in Microsoft Graph, which are the same in every tenant. If some or all of them cannot be read, the list says so and shows names derived from the setting IDs for those settings.
* Compliance policies, update rings, driver updates, device configuration and app protection policies list their configured properties. Administrative templates list each setting as **Enabled** or **Disabled** with its values.
* `%OrganizationId%` is shown as the tenant ID, as it is deployed.
* **Why OIB sets them** opens the platform's page in the [OpenIntuneBaseline documentation](https://docs.openintunebaseline.com), which explains the reasoning behind the settings.

Show settings only reads. Nothing is created or changed in the tenant.

<figure class="docs-screenshot">
  <a href="/images/screenshots/oib-new-select.webp" aria-label="Open full-size screenshot: oib new select">
    <img src="/images/screenshots/oib-new-select.webp" alt="Review the selected policies before moving to deployment review" width="2880" height="1800" loading="lazy" decoding="async" />
  </a>
  <figcaption>Review the selected policies before moving to deployment review. Real public catalog; no policies were deployed. Select the image to view it full size.</figcaption>
</figure>

## Existing Deployment

Existing Deployment compares the OIB policies in your tenant with the selected OIB version, then deploys missing or outdated policies.

Tenant policies are matched on the `OIBID` in the policy description first, then on the policy name without its version, for policies deployed before OIB added the OIBID. The comparison does not compare settings; use Policy Validation for that, or open **Show what changes** on a policy as described below, or **Show settings** as described under [New Deployment](#read-a-policys-settings-before-you-deploy-it).

| Status | Meaning |
| --- | --- |
| **Up to date** | The tenant has the current OIB version of the policy. |
| **Update available** | The tenant has an older OIB version. |
| **New** | The OIB policy is not in the tenant. |
| **Newer than OIB** | The tenant policy has a newer version than the selected OIB version. |
| **Ambiguous** | More than one tenant policy matches. Review it manually. |

Deprecated OIB policies still deployed, and older OIB versions still deployed next to a newer one, are listed for review and removal. TenuVault does not remove them.

Select missing and outdated policies to deploy them. For an outdated policy, choose:

* **Create the new version alongside:** the new version is created as a new policy. The old one stays unchanged.
* **Update the existing policy in place** (Pro and MSP): the policy's settings are replaced with the OIB version. Assignments, assignment filters and scope tags stay.

**Show what changes** on a policy marked **Update available** reads the tenant policy as it is now and compares it with the selected OIB version, setting by setting:

* **Changed** lists each setting with its value in the tenant now and in the OIB version.
* **Added by OIB** lists settings the OIB version has and the tenant policy does not.
* **Only in** the tenant policy lists settings the OIB version does not have, such as settings an earlier OIB version had or settings added in Intune since. Updating a Settings Catalog policy or an administrative template in place removes them, because all of its settings are replaced. Other policy types are updated with the OIB values, which may leave some of these settings set; the list says so, and you can check them in Intune after updating.

Updating in place applies the changed and added settings; creating the new version alongside leaves the tenant policy unchanged. Each time you open Show what changes, the tenant policy is read again. Show what changes covers the policy types Policy Validation checks setting by setting. For other policy types, and for every other policy in the list, **Show settings** lists the OIB settings instead. Both only read the tenant.

**Export PDF** saves the comparison as a PDF report: a cover with the counts at a glance, a contents page with bookmarks, a summary, one table per status with the platform, type, OIB policy, tenant policy, versions and match method, and the OpenIntuneBaseline attribution. Pro and MSP can brand it with their own name, logo and colors in [Settings](/settings/#pdf-branding).

## Policy Validation

Policy Validation checks deployed OIB policies setting by setting against the baseline. It only reads the tenant.

It covers matched Settings Catalog and Endpoint security policies, compliance policies, update rings, driver updates, Endpoint Analytics and administrative templates. Other policy types show "This policy type is not validated setting by setting." Each policy shows whether it matches the baseline or has drift, with value mismatches, settings missing in the tenant and settings only in the tenant.

* Narrow the list with **Search OIB or tenant policy** (every word you type must match the OIB policy name, the tenant policy name or the platform, in any order), the result buttons **All**, **Matches**, **Drift**, **Errors** and **Not validated** (policies not validated yet and policy types that are not validated setting by setting), and **All platforms** when more than one platform is loaded. The result counts follow the search and platform, and **Clear filters** shows every policy again. A saved validation has the same filters.
* **Export CSV** and **Export PDF** save the results. The PDF report has the same layout as the comparison report, with a summary table of every validated policy and its status, and a table of value mismatches, settings missing in the tenant and settings only in the tenant for each drifted policy. Both always hold every validated policy, whatever the filters show.
* **Saved validations** keeps the latest 50 validations per tenant, encrypted on this device. Only **Validate all** sets the OpenIntuneBaseline score in [Governance](/governance/#openintunebaseline-scores); a single policy check is saved and marked as not part of the score. When the history is full, the oldest single policy checks are removed first, and a full validation is never removed to make room for a single policy check. If every saved validation is a full validation, a new single policy check is not saved and the notice says so; export the results to keep it, or delete older saved validations to make room.
* **Fix drift** (Pro and MSP) resets a drifted policy to its OIB configuration in place. Assignments stay. The tenant is always backed up first, and the fix can be undone.

<figure class="docs-screenshot">
  <a href="/images/screenshots/oib-validate.webp" aria-label="Open full-size screenshot: oib validate">
    <img src="/images/screenshots/oib-validate.webp" alt="Validation presents per-policy results and actions" width="2880" height="1800" loading="lazy" decoding="async" />
  </a>
  <figcaption>Validation presents per-policy results and actions. Results are simulated against the public catalog, not a live tenant assessment. Select the image to view it full size.</figcaption>
</figure>

## Assignments

OpenIntuneBaseline marks every policy as a device policy or a user policy: in its policy manifest, or with `D` or `U` in the policy name, as in `Win - OIB - SC - Device Security - D - BitLocker (OS Disk)`. TenuVault uses that mark to assign policies, both when you deploy them and later in the **Assignments** workflow.

You choose:

* **Device groups**: assigned to device policies.
* **User groups**: assigned to user policies.
* **Excluded device groups**: excluded from the policies that get device groups.
* **Excluded user groups**: excluded from the policies that get user groups.
* **Policies without a device or user marker**: shown only when the selection has policies OIB does not mark. Assign them to device and user groups, device groups only, user groups only, or no groups.
* **Assignment filters** (optional): one filter per platform the selected policies use, for example Windows or macOS, and whether it includes or excludes matching devices. The filter applies to each device and user group of the policies on that platform. Only filters of that platform are offered; app protection policies (BYOD) use app filters. Windows driver, feature and quality update profiles take no filter: when the selection has some, the editor and the confirmation say that they go to the whole group.

Intune only applies an exclusion of the same kind as the include: a user group excluded from a policy assigned to device groups has no effect. That is why device and user exclusions are separate lists, and each goes only with its own kind of include. In Intune an exclusion wins over an include of the same kind.

Each list takes up to 25 groups. A group cannot be both included and excluded.

### Find groups

Type at least two characters to search groups whose name starts with them, or paste a group's object ID. Distribution lists are shown but cannot be chosen, because Intune cannot assign them; a pasted distribution list is refused before anything changes.

Searching by name needs a permission to read groups, the optional delegated `Group.Read.All` (see [Permissions](/security/permissions/)). Without it the editor says so and you paste object IDs from Entra instead. When groups can be read, an ID the tenant does not have is marked "not found in this tenant" and **Continue** stays off until you remove it.

Before anything changes, TenuVault checks the groups and filters again in the tenant: every group must exist (when groups can be read), and every filter must exist with the platform it was chosen for. If a check fails, nothing is changed, not even the backup runs.

### Assign when you deploy

In New Deployment and Existing Deployment, **Assignments for new policies** on the review step assigns the policies the run creates. Without groups, new policies stay unassigned and nothing reaches devices until you assign them; start with a pilot group. Policies updated in place keep their assignments.

The confirmation lists where the policies go, for example "40 device policies: Pilot devices; 31 user policies: Pilot users; Excluded device groups: Kiosk devices". The result says how many new policies were assigned and how many stay unassigned.

### The Assignments workflow

Pro and MSP. **Assignments** changes the assignments of OIB policies that are already deployed:

1. **Platforms**: choose the platforms, as in Existing Deployment.
2. **Policies**: TenuVault finds the deployed OIB policies the same way Existing Deployment matches them. Policies the tenant does not have, and policies that match more than one tenant policy, are not listed. Each policy shows whether it is a device or user policy.
3. **Review and assign**: choose **Add to the current assignments** or **Replace the current assignments**, then the groups and filters. The review reads the current assignments of each policy and shows them next to the assignments after the change. Policies already assigned that way are left alone.

* **Add** keeps what each policy is assigned to and adds the groups. A group already assigned gets the filter you chose for its platform, or keeps its own filter when you chose none. If you include a group the policy excludes, both stay and the exclusion wins; the result says so.
* **Replace** makes the direct assignments exactly the groups you chose. With no groups, every direct assignment of the selected policies is removed. You confirm that the current assignments are replaced.
* Assignments that come from a policy set are never changed. iOS and Android app protection policies (BYOD) can only be added to, not replaced: Intune reports their policy set assignments as direct ones, so a replace could remove them. For the same reason Add only adds groups they are not assigned to yet, leaves existing entries and their filters as they are, and does not add excluded groups to an app protection policy that is already assigned.
* A policy whose current assignments cannot be read is not changed.
* Only what the review showed is changed: if a policy's assignments change in Intune after the review, or the tenant policy is no longer the matched copy of the OIB policy, it is not changed and the result asks you to review it again.
* If Microsoft Graph does not confirm a change (a timeout or server error), the run keeps the previous assignments so Undo can still put them back; check the policy in Intune. Undo right after such a run may say the outcome is not known yet; try again a few minutes later.
* If Microsoft Graph throttles a change, it is not sent again later, because the assignments may have changed by then. The policy is reported as failed; run the change again.

The backup choice is the same as for deployments. Each change is recorded as a run that can be undone.

## Deploy and undo

### How OIB content is deployed

* `%OrganizationId%` in OIB content is replaced with the tenant ID.
* Assignments stored in the source files are never deployed. Scope tags are set to Default.
* New policies are created unassigned, or assigned to the groups you choose. See [Assign when you deploy](#assign-when-you-deploy).

### Backup first

A full backup of the tenant runs before anything changes. If the backup cannot start, fails or does not finish within an hour, nothing is changed.

* For runs that only create policies, the backup is optional and on by default: **Back up the tenant first (recommended)**.
* When existing policies are updated in place, or drift is fixed, the backup is always required. The app enforces this; the toggle shows **Back up the tenant first (required to update existing policies)**.

Only one OpenIntuneBaseline deployment or undo can run per tenant at a time.

### Deploy to several tenants (MSP)

**Also deploy to** deploys the same policies to other connected tenants after the selected tenant, one tenant at a time:

* Groups and filters exist per tenant, so each tenant you add gets its own **Assignments in *tenant*** editor. Leave it empty and that tenant's new policies stay unassigned.
* With the backup on, a tenant without backup storage shows "No backup storage, will be skipped" and is reported as "Skipped: no backup storage is chosen for this tenant in Settings."
* Each tenant's own plan is checked.

### Undo

Every deployment, drift fix and assignment change is recorded on this device with the IDs of the objects it created, the previous version of every policy it updated and the previous direct assignments of every policy it reassigned. **Deployment history** on the section's start page lists the runs that can be undone for the selected tenant.

If the run list cannot load, it shows the error with a **Retry** button. Retry reloads the history. A load failure does not mean there are no runs to undo.

Undo deletes the objects the run created (with their assignments), puts the previous versions of updated policies back and puts the previous assignments of reassigned policies back. It does not touch anything else. If a reassigned policy's assignments were changed again after the run, Undo leaves it alone and says so, so a newer change is never overwritten. To go back further, restore from the backup taken before the run. See [Restore Intune policies](/restore/).

Failed writes follow the same safety rules as restores. A write with an unknown outcome is not repeated automatically; resolve it in **Settings** > **Storage and recovery** > **Restore write history**. See [Restore write history](/restore/limitations/#restore-write-history). Assignment changes from the **Assignments** workflow are the exception: their record is the run in **Deployment history**, which keeps the previous assignments even when the outcome is unknown, so check the policy in Intune and use **Undo** there.

## Your own baseline

Pro and MSP: **Customize** under **Your own baseline** stores a platform at the version selected in the header as your organization's own editable baseline under **My baselines**. There you edit settings in versions, compare them with and rebase them onto the latest OIB release, and deploy them through a reviewed change set. Customize does not change the tenant. See [My baselines](/baselines/custom-baselines/).

## Baseline upgrades

Pro and MSP: in **Changes**, **Baseline upgrades** records an OpenIntuneBaseline deployment as an installed baseline, then compares three ways between the deployed version, your tenant and the platform's latest OIB release (or `main` for a platform without releases).

## Runs from Quick Start

Earlier versions of TenuVault deployed OIB through Quick Start on the OpenIntuneBaseline framework page. On first start after the update:

* Quick Start runs stored on the device are moved into the OpenIntuneBaseline deployment history with the same run IDs, so they stay undoable there and can still be recorded as installed baselines. The original records are kept under a separate key; nothing is deleted.
* Runs that used the previously pinned release keep their exact commit. Runs of other releases have no known commit, so baseline upgrades compare them manually.
* Saved OIB framework workspaces from the old framework page stay on the device. See [Earlier comparisons](#earlier-comparisons).

## Earlier comparisons

If the old OpenIntuneBaseline framework page saved policy pack comparisons for the selected tenant, **Earlier comparisons** on the section's start page lists them with their date, pack reference and Present, Missing, Different and Review counts. **View findings** shows each saved finding, and **PDF**, **CSV** and **JSON** export a comparison on every plan. They are read-only: they cannot be compared again, edited, deleted or used to create policies. New comparisons use Existing Deployment and Policy Validation. The card is hidden when the tenant has no saved comparisons.

## Troubleshooting

| Message | Cause and fix |
| --- | --- |
| GitHub could not be reached. | TenuVault could not read the OIB releases and has no earlier list on this device. Check the connection to `api.github.com` and click **Retry**. |
| GitHub request failed (403) ... GitHub limits requests per network; retry later. | GitHub rate limits unauthenticated requests per network. Wait and retry, or use another network. |
| The OpenIntuneBaseline source changed or expired. Reload it and try again. | The session commit is no longer the one loaded. Reload the section and start the workflow again. |
| The backup could not start, so nothing was changed. | Check the tenant's sign-in, license and backup storage, then retry. |
| The backup failed, so nothing was changed. | Open **Backup & Restore** and check the backup log. Fix the cause and retry. |
| The backup did not finish within an hour, so nothing was changed. | Retry at a quieter time, or check the backup log for slow types. |
| Tenant *type* could not be read (*status*). | Check your Intune role and the app registration permissions. |
| Another change is being applied to this tenant: *label*. Try again when it finishes. | Another deployment, undo, change set or framework creation is running for this tenant. Wait for it to finish. See [Troubleshooting](/troubleshooting/). |
| This run was already undone or is not recorded on this device. | Runs are stored per device. Delete leftover policies in Intune. |
| Each of the device groups must be an Entra group object ID. | Paste the group's object ID (GUID), or search the group by name. |
| This group does not exist in the tenant: *ID*. Nothing was changed. | The group was deleted or belongs to another tenant. Remove it and choose another group. |
| The assignment filter *name* is not a *platform* filter. Nothing was changed. | Choose a filter of the platform shown next to it. |
| A group cannot be both included and excluded. | Remove the group from one of the lists. |
| The current assignments could not be read, so nothing was changed. | Check your Intune role and retry. The policy keeps its assignments. |

## License and attribution

OpenIntuneBaseline content is by SkipToTheEndpoint and contributors and licensed under [GPL-3.0](https://github.com/SkipToTheEndpoint/OpenIntuneBaseline/blob/main/LICENSE). Keep that attribution and license when you share policy content from OIB.

## Related pages

* [OpenIntuneBaseline](https://www.tenuvault.com/openintunebaseline): deploy, compare and validate OIB, on the product site
* [OpenIntuneBaseline by hand or with TenuVault](https://www.tenuvault.com/compare/openintunebaseline-by-hand-vs-automated): when importing by hand is enough, on the product site
* [My baselines](/baselines/custom-baselines/)
