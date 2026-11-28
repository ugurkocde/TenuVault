---
title: Entra ID backups
description: Back up Microsoft Entra device and access settings, with optional groups and device inventory.
---

Turn on **Also back up Entra ID device and access settings** on the **Check** step to include these settings and Conditional Access during setup. To change coverage for an existing tenant, open **Settings > Services and permissions**. Conditional Access has its own switch there.

## Coverage

| Area | Types |
| --- | --- |
| Device settings | Device registration policy, including Windows LAPS, and MDM and MAM enrollment policies |
| Authentication | Authentication methods policy and authentication contexts |
| Terms of use | Agreement settings and file metadata |
| [Conditional Access](/backups/conditional-access/) | Conditional Access policies, named locations and authentication strengths |

Terms of use PDFs and individual acceptances are excluded. MDM and MAM enrollment policies require a signed-in admin. Review the required [permissions](/security/permissions/) or the [Backup Reader coverage](/backups/backup-reader/) for unattended runs.

## Opt-in directory inventories

Turn on **Groups** or **Devices** under **Areas and access** in Settings. Groups include group properties, member and owner IDs, group lifecycle policies and the ownerless group policy. Devices include Entra device inventory. These snapshots can contain personal data, such as device names and the IDs of group members. Inventory counts appear separately from policy counts.

TenuVault reports changes only when it can compare complete reads for the type in both backups. A permission or role refusal leaves the affected type out and records the coverage gap.

## Restore

[Conditional Access](/backups/conditional-access/#how-restores-stay-safe) has its own restore options. Eligible cloud security groups support [individually reviewed restores](/restore/identity/#groups). Device and access settings, group lifecycle policies, the ownerless group policy and Entra devices are available for backup and comparison.
