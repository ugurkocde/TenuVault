---
title: Intune configuration backups
description: Back up Intune settings, policies, apps, scripts, enrollment and tenant administration.
---

## Enable backups

Intune is preselected in setup. For a connected tenant, open **Settings > Services and permissions** to check or change its Intune switch.

## Coverage

TenuVault backs up [41 Intune types](/backups/coverage/#intune) across nine areas. These include device configuration, compliance, endpoint security, scripts, Windows updates, apps and app protection, enrollment and tenant administration. Supported assignment references are stored with the policies.

The default scope leaves out app details. Choose **Everything** to include them, or use **Custom** to choose types. Use [App Backup](/apps/app-backup/) to capture supported Win32 installers separately.

## Permissions and verification

Check [the Intune setup permissions](/security/permissions/#microsoft-graph) and the coverage status on the Intune card. Use a tenant role that can read the types you back up and write any types you restore. Backups can run manually, on a desktop schedule, or in [Azure Automation](/backups/cloud/).

## Restore

See [Restore Intune configuration](/restore/intune/) for recovery methods and assignment choices.
