---
title: Restore Intune configuration
description: Recreate Intune policies, replace them in place or restore unassigned copies.
---

## Coverage

The restore wizard supports eligible policies, settings and scripts from [Intune backups](/backups/intune/). Review [restore limitations](/restore/limitations/) for dependencies, masked values and types that require manual steps.

## Before you restore

Select a backup that includes the affected policies. Check that your admin role and delegated permissions allow the restore. Decide whether to restore assignments. A copy without assignments is useful for reviewing a policy before it applies to devices.

## Recover from a backup

Open **Backup & Restore**, select **Intune** in the **Service** filter and follow the [restore wizard](/restore/#open-the-wizard). Choose **Create copies** or **Replace in place** as supported for your selection. Review the destination, each action and any assignment changes before confirming. Follow the [Multi Admin Approval workflow](/restore/multi-admin-approval/) for protected policies.

## Verify the result

Review the results and open the restored policies in Intune. Check settings and assignments, then run a new backup to capture the verified configuration.
