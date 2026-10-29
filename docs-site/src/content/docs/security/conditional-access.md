---
title: "Conditional Access and TenuVault"
description: How Conditional Access applies to TenuVault, why session controls such as sign-in frequency stop scheduled backups, and the ways to keep them running.
---

TenuVault signs in as you, through your own app registration. Your Conditional Access policies therefore apply to TenuVault exactly as they apply to the Intune admin center. That is intended, but session controls can stop scheduled backups that run at night. This page explains why and what you can do about it.

## How Conditional Access applies

* **Sign-in.** TenuVault opens the Microsoft sign-in in your system browser. MFA, device compliance, location and other grant controls are checked there. Device-based conditions need a browser that passes the device identity; see [Conditional Access](/getting-started/requirements/#conditional-access) in the requirements.
* **Tokens.** After sign-in, TenuVault keeps your Microsoft refresh token in its encrypted token cache and renews access tokens silently, like any desktop app.
* **Session controls.** When a policy ends the session, the silent renewal fails. TenuVault then stops and asks you to sign in again. Background work never opens a sign-in window by itself.

## Why scheduled backups stop

The usual cause is **sign-in frequency** on a policy for admins, for example "every 4 hours" or "every time" for users with the Intune Administrator role. After that time, Microsoft refuses the silent renewal and a scheduled backup at 02:00 fails with a message such as:

> Microsoft needs you to sign in again as admin@contoso.com for Microsoft Graph (AADSTS70044).

`AADSTS70044` means the session ended because of a sign-in frequency check. `AADSTS50076` and `AADSTS50079` mean MFA is required again. In the morning, TenuVault shows a sign-in banner, and the next scheduled backup works again until the session ends the next time.

### Why excluding the app registration usually does not help

A tempting fix is to exclude the TenuVault app registration from the policy. That usually changes nothing: Conditional Access evaluates the **resource** a token is for, here Microsoft Graph and Azure Storage. A policy that targets **All resources** or Microsoft Graph still applies when TenuVault asks for a Graph token, whichever app asks. Exempting Microsoft Graph instead would weaken the policy for every app, so do not do that either.

## Ways to keep scheduled backups running

Pick the option that fits your policies. They are listed from least to most change.

### 1. Sign in when TenuVault asks

If backups only need to run on working days and someone opens TenuVault daily, signing in again in the morning may be enough. A night whose attempts are used up is not repeated: the next backup runs at the next scheduled time, so start a backup yourself if you need one sooner.

### 2. A dedicated backup admin account

This option needs help from whoever assigns Intune roles and owns Conditional Access in your tenant. Back up with a separate account that only reads Intune:

* Assign it a read-only Intune role, for example **Read Only Operator**. Backups only read Intune; restores need a write role, so do those with your own account.
* Keep the role **permanently active**. With PIM, an eligible assignment that nobody activated makes scheduled backups fail.
* Exclude this account from the strict admin sign-in frequency policy, and cover it with its own policy instead: for example require a compliant device or a trusted location, with a longer sign-in frequency such as 30 days.
* Sign in to TenuVault with this account on the computer that runs scheduled backups.

Everything stays delegated: no application permissions, no certificate.

### 3. The Backup Reader

If your policies do not allow either option, add the optional [Backup Reader](/backups/backup-reader/) on Pro and MSP. It is a separate, read-only app registration with a certificate on the TenuVault computer. Only scheduled backups use it; manual backups, restores and every other change keep using your own sign-in, MFA and Conditional Access. Sign-in frequency does not apply to it, because it does not sign in as a user.

The Backup Reader is an application identity, so treat its certificate like an admin credential. Setting it up is a small project with colleagues: an Entra administrator (Global Administrator or Privileged Role Administrator) creates the app registration, an Azure administrator grants the storage role for Azure backups, and the certificate on each computer is renewed yearly. The Backup Reader page lists [who has to do what](/backups/backup-reader/#who-has-to-do-what), with request texts you can send them.

You can control it with **Conditional Access for workload identities**, which needs Microsoft Entra Workload ID Premium: for example a policy that blocks it outside the network your TenuVault computers use. Its token requests appear in Entra ID under **Sign-in logs** > **Service principal sign-ins**, grouped by Microsoft rather than one entry per backup.

## Other policies to check

* **Azure Storage roles with PIM.** For backups in Azure, the admin, or the Backup Reader, needs its storage role permanently active. See [Create a storage account](/getting-started/create-storage-account/).
* **Token protection and compliant network.** Policies that bind tokens to a device or network apply to TenuVault like to other desktop apps. If sign-in works in your browser but TenuVault cannot renew its token, check the Entra sign-in logs for the failing policy.

## Related pages

* [Backup Reader for scheduled backups](/backups/backup-reader/)
* [Schedule backups](/backups/schedules/)
* [App registration and delegated permissions](/security/permissions/)
* [Troubleshooting](/troubleshooting/#background-backups)
