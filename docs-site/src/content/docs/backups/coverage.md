---
title: "What gets backed up"
description: Every Intune object type TenuVault backs up, grouped by area, and what is not covered.
faq:
  - question: "Which Intune objects does TenuVault back up?"
    answer: "41 Intune object types in nine areas: device configuration, compliance, endpoint security, scripts and remediations, Windows updates, apps, app protection and configuration, enrollment, and tenant administration. Each object is saved as it is in Microsoft Graph (beta), with its settings and, where Intune has them, its assignments."
  - question: "Does TenuVault back up app installer files?"
    answer: "Policy backups save app details, assignments, categories, and dependency and supersedence links, not installers. Free App Backup separately stores original .intunewin files selected by an administrator and exports their exact bytes. It does not download installers from Intune or enable app-content restoration."
  - question: "Are the groups that assignments target backed up?"
    answer: "No. Assignments are saved as references to groups; the groups themselves are not part of the backup."
  - question: "Are Windows update rings included?"
    answer: "Yes. Update rings are device configuration profiles, so they are backed up with Device configuration."
  - question: "Why are some types missing from a backup?"
    answer: "TenuVault skips types it is denied access to, for example when the app registration lacks a permission or its admin consent, or when your Intune role excludes the type. A scheduled backup made by the optional Backup Reader also leaves out device categories and device clean-up rules unless the reader has the optional device inventory permission. The backup log and Backup Details say which types were skipped."
---

TenuVault backs up 41 Intune object types in nine areas. Each object is saved as it is in Microsoft Graph (beta), with its settings and, where Intune has them, its assignments.

The area and type names below are the ones the **Back up** dialog shows under **Custom**. See [Choose what to back up](/backups/#choose-what-to-back-up).

For the product overview of how to [back up Intune policies](https://www.tenuvault.com/intune-backup), see the backup page on the product site.

Original installers stay separate from this metadata. [App Backup](/apps/app-backup/) can keep encrypted copies of `.intunewin` files you already have and export them later, free for every configured tenant. It does not make the restore wizard recreate Win32 content.

## How to read the tables

* **Assignments**: whether the backup holds the object's assignments (the groups and filters it targets). Restoring assignments is a separate choice. See [Restore modes and assignments](/restore/modes/).
* **Everything except apps**: every type is included in this choice except **Apps**. **Everything** includes all 41 types.
* Built-in objects that Intune creates itself are skipped. The backup log reports how many were skipped.

## Device configuration

| Type | Assignments | Notes |
| --- | --- | --- |
| Device configuration profiles | Yes | Including custom profiles with OMA-URI settings. Windows update rings are device configuration profiles, so they are included here. Encrypted OMA-URI values are read in plain text and stored in the backup file: encrypted in backups on this device, and readable JSON in Azure backups to everyone with read access to the storage account (see [Secret OMA-URI values](/security/encryption/#secret-oma-uri-values)). The read-only [Backup Reader](/backups/backup-reader/) and [cloud backups](/backups/cloud/) read them too, because Microsoft documents `DeviceManagementConfiguration.Read.All` as enough. If Microsoft refuses such a read, the value stays masked (`****`) and the profile cannot be restored from that backup. |
| Settings catalog and endpoint security policies | Yes | With all settings, including settings catalog based endpoint security policies |
| Administrative templates | Yes | With every configured setting and its values |
| Reusable settings | No | The reusable setting itself |
| BIOS configurations | Yes | |

## Compliance

| Type | Assignments | Notes |
| --- | --- | --- |
| Compliance policies | Yes | With their actions for noncompliance |
| Settings catalog compliance policies | Yes | With settings and actions for noncompliance |
| Compliance scripts | Yes | |
| Compliance policy settings | No | The tenant-wide settings under **Endpoint security** > **Device compliance** > **Compliance policy settings**: **Mark devices with no compliance policy assigned as** and **Compliance status validity period (days)**, plus the switches for scheduled actions for noncompliance and enhanced jailbreak detection. One per tenant. Restore replaces them in place; they cannot be copied. See [Compliance policy settings](/restore/modes/#compliance-policy-settings). |

Microsoft Graph returns the compliance policy settings together with unrelated tenant features, such as log collection, Autopilot diagnostics, Android device administrator enrollment and derived credentials. Those other features are not part of the backup.

## Endpoint security

| Type | Assignments | Notes |
| --- | --- | --- |
| Security baselines and template profiles | Yes | Template-based profiles with their settings. Settings catalog based endpoint security policies are under **Device configuration**. |

## Scripts and remediations

| Type | Assignments | Notes |
| --- | --- | --- |
| Windows PowerShell scripts | Yes | |
| macOS shell scripts | Yes | |
| macOS custom attributes | Yes | |
| Remediations | Yes | Remediations provided by Microsoft are skipped |

## Windows updates

| Type | Assignments | Notes |
| --- | --- | --- |
| Feature update profiles | Yes | |
| Expedited quality update profiles | Yes | |
| Hotpatch quality update policies | Yes | |
| Driver update profiles | Yes | |

Update rings are device configuration profiles and are backed up with **Device configuration**.

## Apps

| Type | Assignments | Notes |
| --- | --- | --- |
| App categories | No | Built-in categories are skipped |
| Apps | Yes | App details, assignments, categories, and dependency and supersedence links. Installer files are never downloaded. Left out of **Everything except apps**. |
| Policy sets | Yes | With the items each set contains |

Apps are the slowest type to back up. Because installer files are never downloaded, Win32 and line-of-business apps cannot be recreated from a backup; store, web and Microsoft 365 apps can. See [What cannot be restored](/restore/limitations/).

## App protection and configuration

| Type | Assignments | Notes |
| --- | --- | --- |
| App configuration policies for managed devices | Yes | |
| App configuration policies for managed apps | Yes | With the apps they target |
| iOS app protection policies | Yes | With the apps they target |
| Android app protection policies | Yes | With the apps they target |
| Windows app protection policies | Yes | With the apps they target |

## Enrollment

| Type | Assignments | Notes |
| --- | --- | --- |
| Enrollment configurations | Yes | Including the tenant defaults, with their priority order |
| Windows Autopilot deployment profiles | Yes | |
| Windows Autopilot devices | No | Serial number, manufacturer, model, group tag, purchase order, assigned user and device name of every registered device. Hardware hashes are not included: Microsoft Graph does not return them. See [Windows Autopilot devices](#windows-autopilot-devices). |
| Apple user enrollment profiles | Yes | |
| Apple automated device enrollment tokens and profiles | No | Token details and enrollment profiles, kept for reference. Restore does not recreate them; upload the Apple token again in Intune. |
| Android Enterprise enrollment profiles | No | The profile settings. A restored profile gets a new enrollment token that is valid for 90 days. |
| Device categories | No | In a scheduled backup made by the [Backup Reader](/backups/backup-reader/), only with its optional device inventory permission; otherwise left out |
| Terms and conditions | Yes | |

### Windows Autopilot devices

A backup records each device registered in Windows Autopilot, one file per device, named by its serial number. It keeps what identifies the device and what admins set on it: serial number, manufacturer, model, group tag, purchase order, assigned user and its friendly name, and device name. It leaves out what changes on its own, such as the last contact time, the enrollment state, the profile status and the Intune and Entra device IDs, so a device shows as changed only when someone changes it. The product key and the Surface Hub device account password are never stored.

The backup does not include the hardware hash. Microsoft Graph returns a device's hash only while it is being imported, never once the device is registered, so no backup tool can read it. Keep the files you imported devices with, or get the hashes again from the device or from your OEM or reseller.

What you can do with the device records:

* **See what changed.** A changed group tag or user shows in **View Changes** and in drift detection, per device.
* **Restore group tags and users.** On a device that is still registered, restore puts the group tag, the assigned user and its friendly name, and the device name back. A device that was deleted and imported again is found by its serial number. Restore never registers a device and never copies one to another tenant. See [Restore limitations](/restore/limitations/).
* **Export them as CSV.** In **Backup Details**, open **Enrollment** and select **Export CSV** next to **Windows Autopilot devices**. The file lists serial number, manufacturer, model, group tag, purchase order, assigned user, user friendly name and device name, so you can match group tags to your hash files by serial number before you import devices again.

Devices are counted as items of the backup, not as policies, and hygiene checks and alert suggestions leave them out. Large tenants are supported: a backup reads the device list page by page, without one request per device.

## Tenant administration

| Type | Assignments | Notes |
| --- | --- | --- |
| Assignment filters | No | |
| Scope tags | Yes | Built-in scope tags are skipped |
| Intune roles | Yes | Custom roles with their role assignments, including members and scopes. Built-in roles are skipped. |
| Compliance notification templates | No | With their messages in every language |
| Company Portal branding | Yes | With the logos and images |
| Device clean-up rules | No | In a scheduled backup made by the [Backup Reader](/backups/backup-reader/), only with its optional device inventory permission; otherwise left out |
| Multi admin approval policies | No | Restoring them always needs a second administrator's approval. In a tenant that has no access policy yet, the restore marks them **Approval required**; send them from **Waiting for approval** with a justification. See [Multi Admin Approval and TenuVault](/restore/multi-admin-approval/). |

## Entra Conditional Access (opt-in)

Off until you turn the service on for the tenant in **Settings** > **Services and permissions**. **Everything** does not include these types while the service is off. See [Conditional Access backups](/backups/conditional-access/).

| Type | Assignments | Notes |
| --- | --- | --- |
| Conditional Access policies | No | Who a policy covers is part of its settings. Microsoft-managed policies are backed up for drift detection only. |
| Named locations | No | |
| Authentication strengths | No | Built-in authentication strengths are skipped |

## What is not backed up

* **App installer files.** Apps are saved as their Intune details only.
* **Built-in objects Intune recreates itself:** remediations provided by Microsoft, built-in app categories, built-in scope tags and built-in Intune roles.
* **The Apple automated device enrollment token.** Its details and profiles are kept for reference, but the token has to be uploaded again in Intune.
* **Android Enterprise enrollment tokens.** A restored profile gets a new token.
* **The groups that assignments target.** Assignments are saved as references to groups; the groups themselves are not part of the backup.
* **Other tenant-wide Intune settings** that Microsoft Graph returns with the compliance policy settings, such as log collection, Autopilot diagnostics, Android device administrator enrollment and derived credentials.
* **Windows Autopilot hardware hashes.** Microsoft Graph does not return them once a device is registered.
* **Anything not listed on this page**, such as enrolled devices and their inventory.
* **Types you leave out** with **Everything except apps** or **Custom**.
* **Types TenuVault is denied access to.** The app registration may lack the permission, for example when it was created with an older version of the setup script, or the permission may not have admin consent. Your Intune role can also exclude a type. The backup skips those types and says so in the log and in **Backup Details**. Open the app registration in Microsoft Entra, go to **API permissions** and select **Grant admin consent for &lt;your tenant&gt;**, or run the setup script again. Then sign out of the tenant in TenuVault and sign in again. If every permission already shows **Granted**, check that your Intune role covers these items. See [Create the app registration](/getting-started/app-registration/#3-add-the-delegated-permissions).

Some backed-up items cannot be restored in full, for example apps that need an installer. See [What cannot be restored](/restore/limitations/).

## Related pages

* [Intune backup](https://www.tenuvault.com/intune-backup): coverage and plans, on the product site
* [Your own Intune export script or a backup app](https://www.tenuvault.com/compare/intune-export-script-vs-backup-app): what a Graph script has to read and restore, on the product site
