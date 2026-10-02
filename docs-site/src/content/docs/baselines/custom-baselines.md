---
title: "My baselines"
description: Keep your own Settings Catalog baseline, customized from OpenIntuneBaseline or taken from a tenant backup, with versions, reviewed deployment and framework comparisons.
---

**My baselines** keeps your organization's own Settings Catalog baseline in TenuVault. Start from the current [OpenIntuneBaseline](https://github.com/SkipToTheEndpoint/OpenIntuneBaseline) version or from a complete backup of your tenant, edit it in versions, deploy it through a reviewed change set and compare it with frameworks without touching the tenant.

## Where to find it

Open **Frameworks** in the sidebar and select **My baselines** at the top of the framework list. To start from OpenIntuneBaseline, select **OpenIntuneBaseline** in the sidebar, choose a platform under **Your own baseline** and select **Customize**. See [OpenIntuneBaseline](/baselines/quick-start/#your-own-baseline).

## What your plan includes

| | Community | Pro | MSP |
| --- | --- | --- | --- |
| Create, edit, deploy, rebase and compare baselines | No | Yes | Yes |
| Read baselines, versions, deployments and comparisons stored earlier | Yes | Yes | Yes |
| Deploy into another tenant | No | The other tenant of the same license | Any connected MSP tenant |

The free **Custom Baselines** framework (import policy JSON on the Frameworks page and compare it with your tenant) is separate and stays free.

## Create a baseline

- **Customize** in the OpenIntuneBaseline section stores the chosen platform of the current OIB version as your baseline, version 1. TenuVault records the platform and the exact `main` commit the section resolved, so later OIB versions can be compared three ways. Only Settings Catalog policies are part of a baseline; other policy types of the pack are listed as not included.
- **Company baseline from a backup** uses the Settings Catalog policies of a complete backup (status Success, every Settings Catalog file readable). IDs, assignments and scope tags are removed.

## Edit settings in versions

Each policy lists its settings with a name derived from the setting ID (the full ID is shown next to it). You can change choice values, text and whole numbers, remove settings or whole policies and rename the baseline. Saving needs a change note and creates a new version; earlier versions never change and stay in **History**.

Secret values are never stored. A setting with a secret value, or one that references a tenant-specific reusable setting, is marked **not portable** and cannot be deployed until you remove it from the baseline.

## Deploy

**Deploy** plans the change against the target tenant: a policy with the same name (without its version suffix) is updated in place and keeps its assignments and scope tags; any other policy is created unassigned with the Default scope tag. TenuVault then shows a change set to review, approve and apply. A backup runs before anything is written, every write is read back, and a rollback is available as a new reviewed change set. Assignments are never written. A change set holds at most 25 policies.

## Newer OpenIntuneBaseline versions

For a customized OIB baseline, **OIB updates** offers the platform's latest OIB release (or `main` for a platform without releases) when it differs from the baseline's base commit. **Compare** shows, per setting, the original OIB version, your version and the latest OIB version. OIB changes you did not touch are taken over, your edits are kept, and settings both sides changed need your decision. **Create rebased version** saves a new version based on the latest OIB version. The tenant is not read or changed; deploy the new version when you are ready.

## Compare

- **With the tenant**: deviations between the version and the tenant's Settings Catalog policies, from the latest complete backup or a live read.
- **With a framework**: OpenIntuneBaseline (the latest `main` commit), UK NCSC, your saved Microsoft, STIG or Custom packs, and the native framework comparisons (NIST, ISO 27001, Essential Eight, Cyber Essentials and others). These comparisons use the baseline instead of the tenant and are labelled "compared with baseline <name> v<n>, not with the live tenant". A baseline holds no assignments and no other policy types, so anything that depends on them is shown as unknown, never as matching or missing.
