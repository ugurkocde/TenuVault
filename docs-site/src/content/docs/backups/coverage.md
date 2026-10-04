---
title: "What gets backed up"
description: Every Intune object type TenuVault backs up, grouped by area, and what is not covered.
faq:
  - question: "Which Intune objects does TenuVault back up?"
    answer: "39 Intune object types in nine areas: device configuration, compliance, endpoint security, scripts and remediations, Windows updates, apps, app protection and configuration, enrollment, and tenant administration. Each object is saved as it is in Microsoft Graph (beta), with its settings and, where Intune has them, its assignments."
  - question: "Does TenuVault back up app installer files?"
    answer: "No. Apps are saved as their Intune details, assignments, categories, and dependency and supersedence links. Installer files are never downloaded, so Win32 and line-of-business apps cannot be recreated from a backup; store, web and Microsoft 365 apps can."
  - question: "Are the groups that assignments target backed up?"
    answer: "No. Assignments are saved as references to groups; the groups themselves are not part of the backup."
  - question: "Are Windows update rings included?"
    answer: "Yes. Update rings are device configuration profiles, so they are backed up with Device configuration."
  - question: "Why are some types missing from a backup?"
    answer: "TenuVault skips types it is denied access to, for example when the app registration lacks a permission or its admin consent, or when your Intune role excludes the type. The backup log and Backup Details say which types were skipped."
---

TenuVault backs up 39 Intune object types in nine areas. Each object is saved as it is in Microsoft Graph (beta), with its settings and, where Intune has them, its assignments.

The area and type names below are the ones the **Back up** dialog shows under **Custom**. See [Choose what to back up](/backups/#choose-what-to-back-up).

## How to read the tables

* **Assignments**: whether the backup holds the object's assignments (the groups and filters it targets). Restoring assignments is a separate choice. See [Restore modes and assignments](/restore/modes/).
* **Everything except apps**: every type is included in this choice except **Apps**. **Everything** includes all 39 types.
* Built-in objects that Intune creates itself are skipped. The backup log reports how many were skipped.

## Device configuration

| Type | Assignments | Notes |
| --- | --- | --- |
| Device configuration profiles | Yes | Including custom profiles with OMA-URI settings. Windows update rings are device configuration profiles, so they are included here. Encrypted OMA-URI values are read in plain text and stored inside the encrypted backup. |
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
| Apple user enrollment profiles | Yes | |
| Apple automated device enrollment tokens and profiles | No | Token details and enrollment profiles, kept for reference. Restore does not recreate them; upload the Apple token again in Intune. |
| Android Enterprise enrollment profiles | No | The profile settings. A restored profile gets a new enrollment token that is valid for 90 days. |
| Device categories | No | |
| Terms and conditions | Yes | |

## Tenant administration

| Type | Assignments | Notes |
| --- | --- | --- |
| Assignment filters | No | |
| Scope tags | Yes | Built-in scope tags are skipped |
| Intune roles | Yes | Custom roles with their role assignments, including members and scopes. Built-in roles are skipped. |
| Compliance notification templates | No | With their messages in every language |
| Company Portal branding | Yes | With the logos and images |
| Device clean-up rules | No | |
| Multi admin approval policies | No | |

## What is not backed up

* **App installer files.** Apps are saved as their Intune details only.
* **Built-in objects Intune recreates itself:** remediations provided by Microsoft, built-in app categories, built-in scope tags and built-in Intune roles.
* **The Apple automated device enrollment token.** Its details and profiles are kept for reference, but the token has to be uploaded again in Intune.
* **Android Enterprise enrollment tokens.** A restored profile gets a new token.
* **The groups that assignments target.** Assignments are saved as references to groups; the groups themselves are not part of the backup.
* **Anything not listed on this page**, such as enrolled devices and their inventory.
* **Types you leave out** with **Everything except apps** or **Custom**.
* **Types TenuVault is denied access to.** The app registration may lack the permission, for example when it was created with an older version of the setup script, or the permission may not have admin consent. Your Intune role can also exclude a type. The backup skips those types and says so in the log and in **Backup Details**. Open the app registration in Microsoft Entra, go to **API permissions** and select **Grant admin consent for &lt;your tenant&gt;**, or run the setup script again. Then sign out of the tenant in TenuVault and sign in again. If every permission already shows **Granted**, check that your Intune role covers these items. See [Create the app registration](/getting-started/app-registration/#3-add-the-delegated-permissions).

Some backed-up items cannot be restored in full, for example apps that need an installer. See [What cannot be restored](/restore/limitations/).
