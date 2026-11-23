---
title: Recover Defender configuration
description: Use saved Defender configuration to review changes and plan recovery.
---

## Coverage

TenuVault backs up [17 Defender configuration types](/backups/defender/). In this release, you can browse and compare them. Defender restore, drift revert and cross-tenant copy are unavailable.

## Before you restore

Choose a backup that fully covers the area you need. Review **Backup Details** for any missing types, then check the type's exclusions on the [Defender backup page](/backups/defender/#coverage).

## Recover from a backup

Open **Backup & Restore**, select **Defender** in the **Service** filter and open the appropriate backup. Use [Compare backups](/backups/compare/) or download the backup to review saved settings before applying any changes through your organization's Defender recovery process.

## Verify the result

After applying changes, run a new Defender backup and compare it with your recovery baseline. Check each affected type for complete coverage before using the comparison as evidence.
