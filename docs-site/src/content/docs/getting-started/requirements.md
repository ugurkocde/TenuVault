---
title: "Requirements"
description: Operating systems, admin roles and network access TenuVault needs.
---

Check these before you install. TenuVault runs on your own computer and signs in as you, so most requirements are about your computer, your admin roles and your network.

## Computer

| | Windows | macOS |
| --- | --- | --- |
| Architecture | x64 or Arm64 | Apple silicon (arm64) or Intel (x64) |
| Installer | Setup program (`.exe`) or MSI for managed deployment | DMG or ZIP |
| Credential store | Windows data protection (DPAPI) for your user account | macOS Keychain |

TenuVault encrypts its saved data (sign-ins, license and backup key) with the operating system's credential store. If the credential store is not available, TenuVault does not start and shows **OS encryption is not available. Enable the operating system credential store before opening TenuVault.**

## Tenant setup, once per tenant

Someone must create the app registration TenuVault signs in with. TenuVault does this with one Microsoft sign-in, and a setup script does the same from PowerShell. The person who signs in needs one of these Microsoft Entra roles:

* Global Administrator
* Privileged Role Administrator
* Cloud Application Administrator

The setup grants tenant-wide admin consent, so the account must be allowed to consent. See [Create the app registration](/getting-started/app-registration/).

If you do not have one of these roles yourself, select **Someone else is the admin? Copy instructions** on the **Connect** step of **Set up TenuVault**. It copies a ready-to-send message for your Entra administrator with the script link, the command, the permissions and the two values to send back. TenuVault keeps your setup progress while you wait.

## Admins who use TenuVault

TenuVault uses delegated permissions only. Every request runs as the signed-in admin, so the app can never do more than that admin can do in Intune.

| You want to | You need |
| --- | --- |
| Back up, compare and restore Intune configuration | An Intune role, for example **Intune Administrator**. Read access is enough for backups; restores write to Intune and need write access to the objects you restore. |
| Store backups in your own Azure storage account | **Storage Blob Data Contributor** on the storage account, and a role that can read the storage account in Azure (for example **Reader**) so it appears in the storage picker. |
| Store backups on your computer | Nothing extra. |

:::note
Azure storage is available on the Pro and MSP plans. Community keeps backups on the device. See [Plans and features](/licensing/).
:::

### Conditional Access

MFA and Conditional Access apply to TenuVault the same way they apply to the Intune admin center.

TenuVault signs in through your default browser on Windows and macOS, so you can use a separate admin account. Device-based Conditional Access, such as requiring a compliant or Entra-joined device, is checked in the browser. On Windows it works in Microsoft Edge when you are signed in to the browser profile, in Chrome with the Microsoft Single Sign On extension or the `CloudAPAuthEnabled` policy, and in Firefox with Windows single sign-on turned on. On macOS it needs the Microsoft Enterprise SSO extension on the device, and Chrome there also needs the Microsoft Single Sign On extension, unless it is Chrome 135 or later on a Mac that stores the device key in the Secure Enclave.

## Network

TenuVault connects to the global Microsoft cloud endpoints below over HTTPS (TCP 443). Allow them through your proxy or firewall.

| Destination | Used for | Required |
| --- | --- | --- |
| `login.microsoftonline.com` | Microsoft sign-in and tokens | Yes |
| `graph.microsoft.com` | Reading and writing Intune configuration | Yes |
| `www.tenuvault.com` | License checks | Yes |
| `management.azure.com` | Listing your subscriptions and storage accounts in the storage picker | Only for Azure storage |
| `<account>.blob.core.windows.net` | Reading and writing backups in your storage account | Only for Azure storage |
| `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` | Automatic updates | For updates |
| `api.github.com`, `raw.githubusercontent.com` | OpenIntuneBaseline content for the OpenIntuneBaseline section and My baselines | For OpenIntuneBaseline |

TenuVault uses the device's proxy settings, including a proxy auto-config (PAC) file, and the operating system's trusted certificates. Behind HTTPS inspection, it works when the inspection certificate is trusted by Windows or macOS, as it is for Microsoft Edge.

### Proxies that require authentication

When the proxy asks for a sign-in (HTTP 407), TenuVault asks once per proxy for a user name and password, then uses them for sign-in, license checks, backups and updates. Requests that meet the proxy while the dialog is open wait for that one answer. **Remember on this computer** is on by default and saves the credentials encrypted for your Windows or macOS account, so they survive a restart; without operating system encryption they are kept only until TenuVault quits. If the proxy refuses them, TenuVault forgets them and asks again, at most three times in a row. To remove them, open **Settings** > **Sign-in** and select **Forget proxy sign-in**.

A proxy that signs in with your Windows account (NTLM or Kerberos) usually needs no prompt. If the sign-in is cancelled or refused, errors name proxy authentication, for example `HTTP 407` or `ERR_PROXY_AUTH_REQUESTED`. Allowing the destinations above without proxy authentication avoids the prompt, which also keeps scheduled backups from waiting for an answer while nobody is at the computer.

If GitHub is blocked, updates and baseline packs fail, but backup and restore keep working. For what is sent to each destination, see [Network connections and data flows](/security/data-flows/).

If your storage account uses firewall rules, the computer running TenuVault must be allowed through them. Otherwise TenuVault reports that the storage account rejected the request from this network.

## Next step

[Install TenuVault](/getting-started/install/).
