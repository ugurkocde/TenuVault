---
title: "Work with other admins in one tenant"
description: Let several Intune admins share one TenuVault setup for a tenant, with one app registration, one Azure storage account and the same backups, policies and restores for everyone.
---

Several admins can use TenuVault for the same tenant, each on their own computer and with their own sign-in. When the tenant's backups are in an Azure storage account, every admin sees, compares and restores the same backups, with no key to hand over. This page lists what the admins share and what stays on each computer.

## What the admins share

| | How |
| --- | --- |
| App registration | One per tenant. Create it once with the [setup script](/getting-started/app-registration/). Every admin signs in through it with their own account, so you share the client ID, never a secret. Changes are attributed to the admin who made them in the Intune and Entra audit logs. |
| Roles | Each admin needs an Intune role that covers the policies they back up and restore. For Azure storage, each admin also needs **Storage Blob Data Contributor** and read access (for example **Reader**) on the storage account. The [storage setup script](/getting-started/create-storage-account/) grants both to one admin group. |
| License | The key holder shares the license with the tenant, so the other admins need no key of their own. See [Share the license with your tenant's admins](/licensing/manage/#share-the-license-with-your-tenants-admins). Each tenant can be active on up to 5 installations. |
| Backups | Choose the same storage account in **Your Azure storage account** on every computer. Backups made by one admin appear for all of them, for [drift detection](/drift/), [restore](/restore/) and download. |
| Audit log | Kept in the same storage account, so every admin sees who started each action. See [Audit log](/audit-log/). |

## Set up a second admin

1. Make sure the admin is in the admin group with the roles above, and, if sign-in is restricted, in the group that may sign in. See [Restrict who can sign in](/deploy/#restrict-who-can-sign-in).
2. The admin installs TenuVault and selects **Connect your tenant**. See [Start TenuVault for the first time](/getting-started/first-launch/).
3. On the **Connect** step, they select **I already have an app registration**, because the tenant already has one. They enter the tenant ID and the client ID of the existing app registration and sign in with their own account. An admin who can grant admin consent can select **Set up with Microsoft sign-in** instead: TenuVault finds the existing app registration and uses it. See [Sign in to your tenant](/getting-started/connect-tenant/).
4. On the **Storage** step, they select **Your Azure storage account**, choose the same storage account and select **Check access**. No recovery key is needed.
5. The existing backups appear in **Backup & Restore** right away.

## Who is trusted

Everyone who can write to the `intune-backups` container is trusted like an Intune admin, because TenuVault restores what it finds there, including replacing live policies and restoring assignments. Backups in Azure are not encrypted by TenuVault: Azure encrypts them at rest, and your role assignments decide who can read and change them. They include the plain-text values of secret OMA-URI settings, so a restore is complete.

* Grant the blob data roles on the storage account only to the Intune admin group.
* Keep soft delete on for blobs and containers, which the storage setup script turns on. See [Backups in Azure](/security/encryption/#backups-in-azure).

## What stays on each computer

| | What it means |
| --- | --- |
| Settings | Appearance, notifications, PDF branding, updates and the other entries in [Settings](/settings/) apply to that computer only. |
| Schedules | Each computer runs its own [schedule](/backups/schedules/) while TenuVault runs there. Two admins with a daily schedule make two backups a day. Usually one computer, or [cloud backups](/backups/cloud/), runs the schedule and the others back up by hand. |
| Retention | Every computer applies its own **Keep backups for** setting to all of the tenant's backups in the storage account, so the shortest setting among the admins wins. Agree on one value. See [Retention](/backups/storage/#retention). |
| Backup Reader | A Backup Reader certificate belongs to one computer. See [Backup Reader for scheduled backups](/backups/backup-reader/). |
| Sign-in | Each admin's sign-in and token cache stay on their computer. |
| Recovery key | Only for backups kept on that computer, and for older Azure backups that an earlier TenuVault version encrypted. Azure backups made by this version do not need it. See [Encryption and recovery key](/security/encryption/). |

## Backups from earlier versions

TenuVault versions before plain Azure backups encrypted each Azure backup with the key of the device that made it. Those backups stay readable on that device, and on any computer that imports its recovery key. On other computers, **Backup & Restore** shows a notice with **Import recovery key** for them, while all newer backups work. Make sure every admin runs the current version: an older version treats the new plain backups as unverified, so it can show and compare them, but cannot replace live policies from them. See [Older encrypted Azure backups](/security/encryption/#older-encrypted-azure-backups).

## Related pages

* [Deploy TenuVault in your organization](/deploy/)
* [Choose where backups are stored](/getting-started/choose-storage/)
* [Create a storage account for TenuVault](/getting-started/create-storage-account/)
* [Activate and manage your license](/licensing/manage/)
