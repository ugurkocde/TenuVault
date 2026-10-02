---
title: "OpenIntuneBaseline"
description: Deploy, compare and validate OpenIntuneBaseline policies from the latest published release or a version you choose, with a backup first and undo per run.
---

The **OpenIntuneBaseline** section deploys, compares and validates [OpenIntuneBaseline](https://github.com/SkipToTheEndpoint/OpenIntuneBaseline) (OIB) policies in a tenant. It offers three workflows: **New Deployment**, **Existing Deployment** and **Policy Validation**. Every write can be undone per run.

OpenIntuneBaseline is published by SkipToTheEndpoint and contributors under the GPL-3.0 license. TenuVault downloads the policy files from the upstream GitHub repository when you use them; they are not bundled with the app.

## Where to find it

Select **OpenIntuneBaseline** in the sidebar. The section works on the tenant selected in the sidebar. OpenIntuneBaseline is not part of the [Frameworks](/baselines/frameworks/) catalog.

The header lists the version each platform uses, for example **Versions: Windows v4.0 · macOS v1.0 · Windows 365 v1.0 · BYOD main @ *commit***. If GitHub cannot be reached and no versions are known yet, the header shows the error with **Retry**.

## Which OIB version is used

OIB publishes a release per platform, tagged for example `windows-v4.0` or `macos-v1.0`. By default each platform uses its latest published release. A platform without a published release (BYOD today) uses the `main` branch.

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
| **BYOD** | App protection policies for iOS and Android |

iOS and Android device platforms are listed as **Coming soon**.

## What your plan includes

| | Community | Pro | MSP |
| --- | --- | --- | --- |
| New Deployment, Existing Deployment comparison and Policy Validation, every platform | Yes | Yes | Yes |
| Deploy new policies, with undo | Yes | Yes | Yes |
| Update outdated policies in place | | Yes | Yes |
| **Fix drift** in Policy Validation | | Yes | Yes |
| **Customize**: your own baseline under My baselines | | Yes | Yes |
| **Also deploy to** other connected tenants in one run | | | Yes |

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

## Existing Deployment

Existing Deployment compares the OIB policies in your tenant with the selected OIB version, then deploys missing or outdated policies.

Tenant policies are matched on the `OIBID` in the policy description first, then on the policy name without its version, for policies deployed before OIB added the OIBID. Settings are not compared; use Policy Validation for that.

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

**Export PDF** saves the comparison as a PDF report.

## Policy Validation

Policy Validation checks deployed OIB policies setting by setting against the baseline. It only reads the tenant.

It covers matched Settings Catalog and Endpoint security policies, compliance policies, update rings, driver updates, Endpoint Analytics and administrative templates. Other policy types show "This policy type is not validated setting by setting." Each policy shows whether it matches the baseline or has drift, with value mismatches, settings missing in the tenant and settings only in the tenant.

* **Export CSV** and **Export PDF** save the results.
* **Saved validations** keeps the latest 50 validations per tenant, encrypted on this device.
* **Fix drift** (Pro and MSP) resets a drifted policy to its OIB configuration in place. Assignments stay. The tenant is always backed up first, and the fix can be undone.

## Deploy and undo

### How OIB content is deployed

* `%OrganizationId%` in OIB content is replaced with the tenant ID.
* Assignments stored in the source files are never deployed. Scope tags are set to Default.
* New policies are created unassigned. If you enter a **Pilot group object ID**, every new policy is assigned to that Entra group only. An invalid value shows "Enter a group object ID (GUID)."

### Backup first

A full backup of the tenant runs before anything changes. If the backup cannot start, fails or does not finish within an hour, nothing is changed.

* For runs that only create policies, the backup is optional and on by default: **Back up the tenant first (recommended)**.
* When existing policies are updated in place, or drift is fixed, the backup is always required. The app enforces this; the toggle shows **Back up the tenant first (required to update existing policies)**.

Only one OpenIntuneBaseline deployment or undo can run per tenant at a time.

### Deploy to several tenants (MSP)

**Also deploy to** deploys the same policies to other connected tenants after the selected tenant, one tenant at a time:

* In other tenants, policies are always created unassigned. The pilot group applies to the selected tenant only.
* With the backup on, a tenant without backup storage shows "No backup storage, will be skipped" and is reported as "Skipped: no backup storage is chosen for this tenant in Settings."
* Each tenant's own plan is checked.

### Undo

Every deployment and drift fix is recorded on this device with the IDs of the objects it created and the previous version of every policy it updated. **Deployment history** on the section's start page lists the runs that can be undone for the selected tenant.

Undo deletes the objects the run created and puts the previous versions of updated policies back. It does not touch anything else. To go back further, restore from the backup taken before the run. See [Restore items](/restore/).

Failed writes follow the same safety rules as restores. A write with an unknown outcome is not repeated automatically; resolve it in **Settings** > **Storage and recovery** > **Restore write history**. See [Restore write history](/restore/limitations/#restore-write-history).

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
| An OpenIntuneBaseline deployment or undo is already running for this tenant. | Wait for the current run to finish. |
| This run was already undone or is not recorded on this device. | Runs are stored per device. Delete leftover policies in Intune. |
| The pilot group must be an Entra group object ID. | Enter the group's object ID (GUID), not its name. |

## License and attribution

OpenIntuneBaseline content is by SkipToTheEndpoint and contributors and licensed under [GPL-3.0](https://github.com/SkipToTheEndpoint/OpenIntuneBaseline/blob/main/LICENSE). Keep that attribution and license when you share policy content from OIB.
