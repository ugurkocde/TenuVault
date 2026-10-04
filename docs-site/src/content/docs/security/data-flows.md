---
title: "Network connections and data flows"
description: Every outbound connection TenuVault makes, what it sends, and what happens if you block it.
---

TenuVault connects to three groups of services: Microsoft (for your tenant and storage), tenuvault.com (for license checks only) and GitHub (for updates and baseline content), plus any notification webhook you configure yourself. This page lists every destination and exactly what is sent to it, so you can review the data flows and configure your firewall or proxy.

All connections use HTTPS on TCP port 443. TenuVault opens no inbound ports. During browser sign-in, Microsoft redirects your browser to `http://localhost` on your own machine, where TenuVault receives the sign-in result.

## Summary

| Destination | Purpose | Carries tenant data? |
| --- | --- | --- |
| `login.microsoftonline.com` | Microsoft sign-in and tokens | Your sign-in only |
| `graph.microsoft.com` | Read and write your Intune configuration | Yes, between your machine and Microsoft |
| `management.azure.com` | List subscriptions and storage accounts for the storage picker | No |
| `<your account>.blob.core.windows.net` | Your own Azure storage account, when you store backups there | Yes, encrypted backups in your account |
| `tenuvault.com` | License checks | No |
| `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` | App updates | No |
| `api.github.com`, `raw.githubusercontent.com` | OpenIntuneBaseline content for the OpenIntuneBaseline section and My baselines | No |
| A webhook URL you configure (optional) | Health review notifications | Counts, severities, finding keys and timestamps only |

TenuVault contains no telemetry, analytics or crash reporting, and sends nothing else.

## Microsoft

### Sign-in: `login.microsoftonline.com`

TenuVault signs you in with the Microsoft Authentication Library (MSAL) as a public client, using your app registration's client ID and your tenant. It opens your system browser for the sign-in, on Windows and on macOS.

* **Sent:** your sign-in, the client ID of your app registration and the requested scopes. There is no client secret.
* **Received:** an access token for the requested resource, a refresh token and an ID token for your account.
* **Stored:** tokens are kept in an encrypted token cache on your machine, protected by Windows DPAPI or the macOS Keychain.

### Intune: `graph.microsoft.com`

All Intune work goes directly from your machine to Microsoft Graph with your delegated token:

* Backups read your Intune configuration, including assignments.
* Restores, drift reverts, the OpenIntuneBaseline section and Framework coverage write the objects you choose to your tenant.
* The tenant overview reads your organization's name and verified domains, policy counts, and your managed device count and compliance rate.

Nothing from these calls is sent anywhere else. Results are written only to the backup storage you chose.

### Azure Resource Manager: `management.azure.com`

Used only when you choose **Your Azure storage account, encrypted** as backup storage. TenuVault lists the subscriptions and storage accounts you can access so you can pick one. It sends only your token and the list requests.

### Azure Storage: `<your account>.blob.core.windows.net`

Used only when you store backups in your own Azure storage account. TenuVault uses these containers:

| Container | Contents | Encrypted by TenuVault |
| --- | --- | --- |
| `intune-backups` | Your backups | Yes. Each file is encrypted with AES-256-GCM on your machine before upload. |
| `audit-logs` | The TenuVault audit log for the tenant, including which admin started each action | No. Protected by your storage account's own encryption and access control. |
| `tenant-metadata` | Tenant profile information TenuVault keeps for the tenant | No. Protected by your storage account's own encryption and access control. |

See [Encryption and recovery key](/security/encryption/) for how backup encryption works.

When backups are stored on **This device, encrypted**, TenuVault makes no storage connection at all. Backups, the audit log and tenant metadata are all written encrypted to the folder you choose.

## tenuvault.com: license checks

The only TenuVault server the app talks to is the licensing service at `https://tenuvault.com/api/desktop-license/`. It is used to activate, refresh and release licenses. The app never contacts the payment provider directly.

### When the app connects

* The first time you use a tenant, to activate it.
* Every 6 hours while the app runs, to refresh each activation.
* When you enter a key, change license sharing, click **Retry** on the **License** page, remove a tenant or deactivate the machine.
* For a tenant on Community, at most every 6 hours, to check whether a license has become available (for example one your organization shared).

### Exactly what is sent

| Request | Fields sent |
| --- | --- |
| Activate a license key for a tenant | License key, installation ID, tenant ID, operating system, app version. When you are signed in to the tenant: the app registration's client ID and, when one can be obtained without prompting you, a Microsoft ID token. |
| Refresh a license key activation | License key, activation ID, installation ID, tenant ID. When sharing is on or not yet decided: the client ID and, when available, a Microsoft ID token. Your sharing choice, once one is set. |
| Organization license (a license shared with your tenant) | Microsoft ID token, installation ID, operating system, app version, the action (activate, refresh or release) and, for refresh and release, the activation ID and the license's ID. The license key is not sent and never reaches your machine. |
| Release (remove a tenant or deactivate the machine) | License key and activation ID. For an organization license, the fields in the row above. |

What each field is:

* **License key:** the key from your purchase email. Community sends no key.
* **Installation ID:** a random identifier generated on your machine and kept in its encrypted store. It identifies this installation, not you or your device.
* **Tenant ID:** the ID of the tenant being licensed. Licenses are counted per tenant.
* **Client ID:** the application (client) ID of your app registration. When you share a license with your tenant, only admins who sign in through this app registration are licensed by it.
* **Operating system and app version:** `win32` or `darwin`, and the TenuVault version number.
* **Microsoft ID token:** proof of which tenant and app registration you signed in to. It contains identity claims, such as your name and user principal name. The app only sends a token issued within the last few minutes, and never sends access tokens or refresh tokens.

### What the licensing service does with it

* It checks the license key with the payment provider and records the activation there, with the installation ID, tenant ID, operating system and app version.
* It verifies the Microsoft ID token against Microsoft's public signing keys and uses only its tenant ID and audience (your client ID) to decide whether the license applies. The token is not stored.
* When you share a license with a tenant, it stores the link between that tenant ID, the license and your app registration's client ID, so other admins in the tenant can be licensed. The license key itself is not stored in this link.
* It answers with an entitlement token signed by TenuVault, bound to the tenant and your installation. The app verifies it offline with a public key built into the app.

As with any web request, the service also sees your public IP address. It uses it only to limit the number of requests per address.

### What is never sent

Tenant configuration, backups, policy names, device or user information, access tokens, refresh tokens and your backup recovery key are never sent to tenuvault.com.

### If tenuvault.com is blocked

Tenants that are already active keep working offline for up to 14 days after their last successful check. A new tenant cannot be activated on a paid plan until the service is reachable. On a machine without a license key, the Community tenant works without any connection to tenuvault.com.

## GitHub

### App updates

| Destination | What it is used for |
| --- | --- |
| `github.com` | Reads the public release feed of `ugurkocde/TenuVault` to find new versions. |
| `release-assets.githubusercontent.com`, `objects.githubusercontent.com` | GitHub redirects release downloads to these hosts. Allow them as well as `github.com`. |

The updater checks 15 seconds after the app starts and then every 6 hours. It downloads public files only and uploads nothing. You can turn updates off in **Settings** > **Updates**, or by policy on managed devices. See [Install and update TenuVault](/getting-started/install/).

If these hosts are blocked, update checks and downloads fail. The installed version keeps working.

### OpenIntuneBaseline content

| Destination | What it is used for |
| --- | --- |
| `api.github.com` | Resolves the latest commit of the OpenIntuneBaseline `main` branch once per session and lists its repository files when the OpenIntuneBaseline section or My baselines loads a pack. |
| `raw.githubusercontent.com` | Downloads the public policy files and `PolicyManifest.json` from that commit. |

These requests download public files from the OpenIntuneBaseline repository. They send no tenant data and no tokens. TenuVault only loads commits it resolved itself, never a URL supplied by the app's interface. Loading a pack and deploying it to your tenant are separate steps; the deployment itself goes to Microsoft Graph.

If these hosts are blocked, packs that are not already loaded in the current session cannot load. Backups and restores are not affected.

## Health review notifications (optional)

Off by default. When you add a webhook under **Operations** > **Health review** > **Notifications**, TenuVault sends a JSON `POST` to that https URL after a scheduled or manual review finds something new, and when you click **Send test**. Only `https` URLs are accepted, redirects are refused and each request times out after 10 seconds.

* **Sent:** a schema name, whether it is a test, when the payload was generated, the time and outcome of the review, counts per severity, and for each new finding its key, check type, severity, state and first seen, last seen and evidence times. **Preview payload** shows the exact body.
* **Only if you opt in:** the tenant display name, and tenant and record IDs. Without that option every ID inside a finding key is replaced by a short one-way reference.
* **Never sent:** tokens, credentials, your backup recovery key, policy content or names, finding titles, reasons or owners.
* **Secret header:** an optional header value you enter is sent only to your URL, stored encrypted on your machine and never shown again in the app.
* **Retries:** up to 3 attempts for network errors, timeouts, HTTP 408, 429 and 5xx. Failures are shown on the endpoint and do not create further notifications.

A local notification option shows a system notification on your machine and makes no network connection. Notifications are sent only while TenuVault runs and, for backup checks, while you are signed in. A closed or asleep computer sends nothing.

## Links that open in your browser

Some buttons open a web page in your default browser instead of making a request from the app, for example **Buy Pro or MSP**, **Buy a license**, **Manage subscription** and **Setup guide**. These pages are visited by your browser only when you click them. TenuVault only opens `https` and `mailto` links, and never loads external pages inside the app window.

## Firewall allow list

To use every feature, allow outbound HTTPS (TCP 443) to:

```
login.microsoftonline.com
graph.microsoft.com
management.azure.com
<your storage account>.blob.core.windows.net
tenuvault.com
github.com
release-assets.githubusercontent.com
objects.githubusercontent.com
api.github.com
raw.githubusercontent.com
```

`management.azure.com` and your storage account are needed only for backups in Azure. The GitHub hosts are needed only for updates and baseline packs. If you configure a health review webhook, also allow its host.

## Related pages

* [Security and privacy](/security/)
* [App registration and delegated permissions](/security/permissions/)
* [Encryption and recovery key](/security/encryption/)
* [Requirements](/getting-started/requirements/)
