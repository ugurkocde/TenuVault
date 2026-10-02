---
title: "Security and privacy"
description: How TenuVault accesses your tenant, where your data goes, and what TenuVault the company can and cannot see.
---

TenuVault is built so that your Intune configuration, your backups and your Microsoft tokens stay between your machine, Microsoft and the storage you choose. This page explains the design; the pages below it go into the details.

## At a glance

| Question | Answer |
| --- | --- |
| Whose app registration does TenuVault use? | Your own, created in your own tenant with a setup script. |
| What kind of permissions? | Delegated permissions only. No application permissions. |
| Is there a client secret or certificate? | No. The app registration is a public client with no credentials. |
| Who does TenuVault act as? | You, the signed-in admin. It can never do more than your own roles allow. |
| Do MFA and Conditional Access apply? | Yes, exactly as they do when you sign in to the Intune admin center. |
| Where do backups go? | Encrypted on your device, or encrypted into your own Azure storage account. |
| Does tenant data reach TenuVault servers? | No. Only license checks go to tenuvault.com, and they carry no tenant configuration, backups or access tokens. |
| Is TenuVault data shared with anyone? | TenuVault receives no tenant data, so there is none to share. |
| Can I check this myself? | Yes. The source code is public at [github.com/ugurkocde/TenuVault](https://github.com/ugurkocde/TenuVault). |

## How TenuVault connects to your tenant

TenuVault is a desktop app, not a hosted service. Everything it does with your tenant happens on the machine where it runs.

1. **Your app registration.** You create the app registration with the TenuVault setup script. It lives in your tenant, is single-tenant, and is a public client: it has no client secret and no certificate. See [App registration and delegated permissions](/security/permissions/).
2. **You sign in as yourself.** When you add a tenant, you sign in with your own admin account. The sign-in opens in your system browser on Windows and macOS, so you can use a separate admin account rather than the one signed in to the computer.
3. **Delegated access only.** Every call to Microsoft Graph and Azure uses a token issued to you through that app registration. TenuVault holds no permission of its own. The effective access is the overlap of the delegated permissions and your own roles, such as Intune Administrator.
4. **Your policies apply.** Because you sign in interactively, MFA, Conditional Access, sign-in frequency and device compliance requirements apply as they do in the Intune admin center. When Microsoft asks for a new sign-in, TenuVault stops and asks you to sign in again. Background work never opens a sign-in window on its own.
5. **Changes are attributed to you.** Restores and other writes are made with your token, so they appear under your name in the Intune and Entra audit logs, just like changes you make in the portal.

:::note
TenuVault calls Microsoft Graph and Azure directly from your machine. There is no TenuVault proxy or relay in between.
:::

## What stays on your machine

TenuVault keeps its working data in an encrypted store in your user profile, protected by the operating system (Windows DPAPI or the macOS Keychain). This includes:

* Your Microsoft token cache (access and refresh tokens).
* Your tenant profiles and sign-in accounts.
* Your license key and license activations.
* The encryption keys for your backups.

If the operating system cannot provide this protection, the packaged app refuses to start rather than store this data in plain text.

Backups are encrypted with AES-256-GCM before they are written to disk or uploaded to Azure. See [Encryption and recovery key](/security/encryption/).

## What TenuVault the company can see

TenuVault talks to its own server, tenuvault.com, for one purpose only: checking your license. The table below lists everything a license check can include. [Network connections and data flows](/security/data-flows/) lists every request in detail.

| TenuVault can see | When |
| --- | --- |
| Your license key | When this machine activates, refreshes or releases a key. Community sends no key. |
| Your tenant ID | Each time a tenant is activated or refreshed. |
| The client ID of your app registration | When a license key is activated or refreshed for a tenant you are signed in to, so the license can be shared with that tenant's other admins. |
| A random installation ID | Each activation and refresh. It is generated on your machine and identifies this installation, not you. |
| Your operating system (Windows or macOS) and the TenuVault version | When a tenant is activated, and with organization license checks. |
| A Microsoft ID token for your sign-in | When a license is shared with your tenant, or when you use a license your organization shared. The token contains identity claims such as your name and user principal name. The licensing service verifies it with Microsoft's public signing keys to confirm which tenant and app registration you signed in to, and does not store it. |
| Your public IP address | As with any web request. The licensing service uses it only to rate limit requests. |

If you buy a plan, the purchase itself is handled by Polar, the payment provider, which holds your billing details. Your license key and its activations are managed there.

| TenuVault never sees | |
| --- | --- |
| Your Intune configuration | Policies, profiles, apps, scripts and assignments are read and written between your machine and Microsoft Graph only. |
| Your backups | Stored on your device or in your Azure storage account, never uploaded to TenuVault. |
| Access tokens and refresh tokens | They stay in the encrypted token cache on your machine. |
| Your backup recovery key | It is created on your machine and only leaves it when you save it to a file yourself. |
| Your storage account contents | TenuVault has no access to your Azure subscription. |

TenuVault contains no telemetry, analytics or crash reporting.

## Control and revoke access

You stay in control of the app registration at all times, because it lives in your tenant.

* **Limit who can sign in.** Run the setup script with `-AllowedGroupId` to require user assignment. Only members of that group can then sign in to TenuVault. See [App registration and delegated permissions](/security/permissions/#restrict-sign-in-to-a-group).
* **Revoke access.** Delete the app registration, or remove the admin consent for it in the Microsoft Entra admin center. TenuVault then cannot obtain new tokens for your tenant.
* **Sign out on one machine.** Remove the tenant from TenuVault on the **Tenants** page. This signs you out of the tenant on that machine, stops its scheduled backups and frees its license slot. Existing backups are kept and nothing in the tenant changes.
* **Apply your own policies.** Conditional Access, sign-in frequency and device compliance policies that target the app registration or your admins apply to TenuVault too.

## Review the source

The TenuVault Desktop source code is public at [github.com/ugurkocde/TenuVault](https://github.com/ugurkocde/TenuVault) so you and your security team can review how it signs in, what it sends and how it encrypts backups. TenuVault is commercial software; the source is published for transparency and review.

Windows builds are signed with Azure Trusted Signing. macOS builds are signed and notarized by Apple.

## In this section

* [App registration and delegated permissions](/security/permissions/): every permission and why it is needed.
* [Network connections and data flows](/security/data-flows/): every outbound destination and what is sent to it.
* [Encryption and recovery key](/security/encryption/): how backups are encrypted and how to keep your recovery key safe.
