---
title: "Network connections and data flows"
description: Every outbound connection TenuVault makes, what it sends, and what happens if you block it.
---

TenuVault connects to three groups of services: Microsoft (for your tenant and storage), tenuvault.com (for license checks, the capture check of App Backup, feedback you choose to send, setup diagnostics a new install chooses to share and, on Pro and MSP, CIS Benchmarks content) and GitHub (for updates and baseline content), plus any notification webhook you configure yourself. This page lists every destination and exactly what is sent to it, so you can review the data flows and configure your firewall or proxy.

All connections use HTTPS on TCP port 443. TenuVault opens no inbound ports. During browser sign-in, Microsoft redirects your browser to `http://localhost` on your own machine, where TenuVault receives the sign-in result.

## Summary

| Destination | Purpose | Carries tenant data? |
| --- | --- | --- |
| `login.microsoftonline.com` | Microsoft sign-in and tokens | Your sign-in only. With the optional Backup Reader, also its certificate sign-in for scheduled backups (no tenant data) |
| `graph.microsoft.com` | Read and write your Intune configuration | Yes, between your machine and Microsoft |
| `management.azure.com` | List subscriptions and storage accounts for the storage picker | No |
| `<your account>.blob.core.windows.net` | Your own Azure storage account, when you store backups there | Yes, backups in your account, over HTTPS |
| Hosts under `manage.microsoft.com`: one that the Intune agent on the PC discovered, one that Intune returns | [App Backup](#app-backup), only when you capture an installer on an enrolled Windows PC: Intune's device content service and the installer download | Yes, between your PC and Microsoft. The selected app's ID, version and name and this PC's Intune device identity go out, the encrypted installer comes back |
| A storage account under `blob.core.windows.net` that Intune returns, not your own storage account | [App Backup](#app-backup), only for **Restore to tenant**: upload of the installer to the address Intune created for it | Yes, the installer, encrypted on your machine before the upload |
| `www.tenuvault.com` | License checks and, on Pro and MSP, CIS Benchmarks content | No configuration or backups. Tenant ID, installation ID and license details only |
| `www.tenuvault.com/api/desktop-feedback` | Feedback, only when you click **Send feedback** | Your answers, an optional reply-to email, app version, operating system, plan and page name. A screenshot of the window only if you tick it, which may show tenant, policy or user names |
| `www.tenuvault.com/api/desktop-events` | [Setup diagnostics](#setup-diagnostics), only on a new install that chose to share them, for 30 days after you agree | No. Setup steps, Microsoft error codes, app version, operating system and a random ID that links the steps. The ID is deleted from your computer after 30 days, and the events are deleted from tenuvault.com after 180 days |
| `www.tenuvault.com/api/app-backup/capture-policy` | [Capture check](#capture-check) of App Backup, on Windows, each time you start an installer capture | No. One random value made for that request. No Microsoft token, tenant ID, license key or installation ID |
| `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` | App updates | No |
| `api.github.com`, `raw.githubusercontent.com` | OpenIntuneBaseline content for the OpenIntuneBaseline section and My baselines | No |
| A webhook URL you configure (optional) | Health review notifications | Counts, severities, finding keys and timestamps only |

TenuVault contains no analytics or crash reporting. Apart from the destinations above, it sends nothing. Feedback goes to tenuvault.com only when you click **Send feedback**. Setup diagnostics are sent only when a new install chooses **Share setup diagnostics**, and only for 30 days after that.

## Microsoft

### Sign-in: `login.microsoftonline.com`

TenuVault signs you in with the Microsoft Authentication Library (MSAL) as a public client, using your app registration's client ID and your tenant. It opens your system browser for the sign-in, on Windows and on macOS.

* **Sent:** your sign-in, the client ID of your app registration and the requested scopes. There is no client secret.
* **Received:** an access token for the requested resource, a refresh token and an ID token for your account.
* **Stored:** tokens are kept in an encrypted token cache on your machine, protected by Windows DPAPI or the macOS Keychain.

With the optional [Backup Reader](/backups/backup-reader/), scheduled backups sign in differently, to the same host: TenuVault requests an app-only token for the separate Backup Reader app registration and proves the app's identity with a short-lived assertion signed on your machine with the reader's certificate private key. No browser opens, no person signs in, and Microsoft returns only an access token (no refresh token and no ID token). The private key itself is never sent; it stays in the same encrypted store. Only scheduled backups use these tokens, for the Graph and Azure Storage calls below. Each token is checked for the right tenant, app, audience and app-only type before use. On top of that, Graph tokens must carry exactly the reader's verified read permissions; storage tokens carry no Graph roles, and Azure instead authorizes them through the container-scoped **TenuVault Backup Writer** role. No new destination is added, so the firewall allow list below does not change.

### Intune: `graph.microsoft.com`

All Intune work goes directly from your machine to Microsoft Graph with your delegated token. The one exception is a scheduled backup of a tenant with a [Backup Reader](/backups/backup-reader/): it reads with the reader's app-only token instead, from the same machine to the same host. Writes never use it.

* Backups read your Intune configuration, including assignments.
* Restores, drift reverts, the OpenIntuneBaseline section and Framework coverage write the objects you choose to your tenant.
* The tenant overview reads your organization's name and verified domains, policy counts, and your managed device count and compliance rate.
* [App Backup](#app-backup) reads the tenant's Win32 apps with their settings, scripts and assignments, and the tenant's Intune account ID. **Assignment check for this PC** also reads the groups this PC's Entra device belongs to, the names and visibility of the assigned groups, and the assignment filters. **Restore to tenant** creates a new Win32 app in the tenant you choose.

Nothing from these calls is sent anywhere else. Results are written only to the backup storage you chose. App Backup differs in two points, both described under [App Backup](#app-backup): an installer capture names the selected app to Intune's device content service, which is also a Microsoft service, and it keeps the installer and the app's settings in its own encrypted folder on your device.

### Azure Resource Manager: `management.azure.com`

Used only when you choose **Your Azure storage account** as backup storage. TenuVault lists the subscriptions and storage accounts you can access so you can pick one. It sends only your token and the list requests.

### Azure Storage: `<your account>.blob.core.windows.net`

Used only when you store backups in your own Azure storage account. TenuVault uses these containers:

| Container | Contents | Encrypted by TenuVault |
| --- | --- | --- |
| `intune-backups` | Your backups | No. Stored as plain JSON, protected by Azure encryption at rest and your role assignments. Backups made by earlier TenuVault versions stay encrypted with the device key that made them. |
| `audit-logs` | The TenuVault audit log for the tenant, including which admin started each action | No. Protected by your storage account's own encryption and access control. |
| `tenant-metadata` | Tenant profile information TenuVault keeps for the tenant | No. Protected by your storage account's own encryption and access control. |

See [Encryption and recovery key](/security/encryption/) for how backups are protected and who is trusted to change them.

When backups are stored on **This device, encrypted**, TenuVault makes no storage connection at all. Backups, the audit log and tenant metadata are all written encrypted to the folder you choose.

## tenuvault.com: license checks and CIS Benchmarks content

The app talks to TenuVault services on `www.tenuvault.com`: the licensing service at `https://www.tenuvault.com/api/desktop-license/`, used to activate, refresh and release licenses, the trial service at `https://www.tenuvault.com/api/desktop-trial`, used only when you start the free trial, and on Pro and MSP the CIS Benchmarks content service at `https://www.tenuvault.com/cis/v1/` (see [CIS Benchmarks content](#cis-benchmarks-content) below). The app never contacts the payment provider directly.

When you open the pricing page or the checkout (`https://www.tenuvault.com/api/desktop-checkout`) from the app, the link names the screen it was opened from (for example `src=app-license-page`) and carries no identifier.

The link to the free setup call page (`https://www.tenuvault.com/setup-call`) works the same way: it names the screen it was opened from (for example `src=app-welcome`) and carries no identifier. Only your browser visits that page, and only when you click the link. The app does not request the page and does not contact a booking service.

### When the app connects

* The first time you use a tenant, to activate it.
* Every 6 hours while the app runs, to refresh each activation.
* When you enter a key, change license sharing, click **Retry** on the **License** page, remove a tenant or deactivate the machine.
* For a tenant on Community, at most every 6 hours, to check whether a license has become available (for example one your organization shared).

### Exactly what is sent

| Request | Fields sent |
| --- | --- |
| Activate a license key for a tenant | License key, installation ID, tenant ID, operating system, app version. When you are signed in to the tenant: the app registration's client ID and, when one can be obtained without prompting you, a Microsoft ID token. |
| Refresh a license key activation | License key, activation ID, installation ID, tenant ID, app version. When sharing is on or not yet decided: the client ID and, when available, a Microsoft ID token. Your sharing choice, once one is set. |
| Organization license (a license shared with your tenant) | Microsoft ID token, installation ID, operating system, app version, the action (activate, refresh or release) and, for refresh and release, the activation ID and the license's ID. The license key is not sent and never reaches your machine. |
| Release (remove a tenant or deactivate the machine) | License key and activation ID. For an organization license, the fields in the row above. |
| Start the free trial | The email address you enter and the screen you started it from, such as `app-license-page`. Nothing else, and only when you click **Start free trial**. The service emails the trial key to that address and keeps a record of the request (see the [privacy policy](https://tenuvault.com/privacy#free-trial)). |

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

Tenant configuration, backups, policy names, device or user records from your tenant, access tokens, refresh tokens and your backup recovery key are never sent to tenuvault.com, with one opt-in exception: feedback you choose to send, that is the text you write and, only if you tick it, a screenshot that may show tenant, policy or user names (see [Feedback](#feedback) below). This is separate from your own sign-in: license requests can carry a Microsoft ID token with your own name and user principal name, as described above, which the licensing service verifies and does not store.

### Feedback

**Share feedback** in the sidebar sends your feedback to `https://www.tenuvault.com/api/desktop-feedback`. Nothing is sent until you click **Send feedback**, and the dialog lists everything that goes with your answers before you send.

* **Sent:** your answers to the two questions, the reply-to email if you enter one, the TenuVault version, the operating system and its version, your plan (Community, Pro, MSP or none) and the name of the section you were on, such as Drift Detection. A random message ID, so a retry of the same draft is not counted twice.
* **Only if you tick it:** a screenshot of the TenuVault window, taken when you open **Share feedback**. It may show tenant, policy or user names. It is unticked every time the dialog opens, and the app discards it when you close the dialog or the feedback is sent.
* **Never added automatically:** your installation ID, tenant IDs or names, license keys, tokens, and routes or links that contain IDs. The only exceptions are what you type into the answers and, if you tick it, the screenshot, which can show any of these.
* **Kept:** stored up to 12 months, with the screenshot, to read and answer feedback; the email copy to support, with the screenshot attached, is kept as support correspondence. A keyed hash of your IP address is stored with the feedback to limit how often feedback can be sent, and is deleted after 24 hours.
* **If blocked:** sending fails and your draft stays in the dialog. **Copy as email** copies your answers and the same details, without the screenshot, to the clipboard and opens a new email to support. Allow `https://www.tenuvault.com/api/desktop-feedback` if your proxy filters by path.

### If tenuvault.com is blocked

Tenants that are already active keep working offline for up to 14 days after their last successful check. A new tenant cannot be activated on a paid plan until the service is reachable. On a machine without a license key, the Community tenant works without any connection to tenuvault.com.

On every plan, a new installer capture in [App Backup](#app-backup) needs its [capture check](#capture-check) each time. Listing apps, exporting installers you already captured and **Restore to tenant** do not use it. **Restore to tenant** sends nothing to tenuvault.com: restoring into another tenant checks the plan already on record on this computer for that tenant, with no licensing request.

### CIS Benchmarks content

On Pro and MSP, the [CIS Benchmarks](/baselines/cis-benchmarks/) page downloads its content from `https://www.tenuvault.com/cis/v1/`: the list of available benchmarks (`/cis/v1/catalog`), and for each benchmark Level you load, its pack (`/cis/v1/packs/...`) and its recommendation list (`/cis/v1/lists/...`). The app only connects when you open the CIS Benchmarks page or load a benchmark.

* **Sent:** the signed entitlement from the last license check, as a bearer token. It contains your license key ID, the activation ID, the tenant ID, the installation ID and your plan. No tenant configuration, assessment results or Microsoft tokens are sent.
* **Logged:** each download is logged with the tenant ID, installation ID, license key ID and the time, and pack and list downloads also with the benchmark, version and Level.
* **Stored on your machine:** the downloaded content is saved in the app's encrypted storage for the selected tenant. It is never bundled in the installer.
* **If blocked:** benchmarks you already loaded stay available on the device; new benchmarks or Levels cannot be loaded. Allow `https://www.tenuvault.com/cis/v1/` alongside `https://www.tenuvault.com/api/desktop-license/` if your proxy filters by path.

## Setup diagnostics

A new install asks once, on the welcome screen, whether it may tell TenuVault which setup steps worked and which Microsoft error codes stopped them. This is how we find out where setups fail, for example on a Conditional Access policy or a blocked Microsoft app, and fix the guidance for setups like yours.

**When it is asked**

* Only on a new install: the first launch of a version with setup diagnostics, with no saved TenuVault data on the device. Installs that existed before are never asked and send nothing.
* On the welcome screen, below **Connect your tenant**, with two equal buttons: **Share setup diagnostics** and **Don't share**. Nothing is preselected and the setup works without an answer.
* If you have not answered, the app may ask next to a setup error, at most once each time the app runs, and never again after you answer. This covers the setup sign-in, the app registration, an app registration without the admin consent TenuVault needs, and the first sign-in to your tenant, not a sign-in you cancelled. **Share** there sends that error and the steps after it, nothing from before.
* **Don't share** is final: you are not asked again. You can still turn it on, or off, in **Settings** > **About** > **Share setup diagnostics**.

**Nothing before you agree.** Until you choose **Share setup diagnostics**, TenuVault stores only whether you answered. It stores no date and no ID, keeps no queue of events and sends nothing. While you have not answered, the last setup error is held in memory only, so the reminder next to it can offer to send it; it is never written to disk and is dropped when you answer or quit. The 30 days start when you agree.

**Sent to** `POST https://www.tenuvault.com/api/desktop-events`, in batches of up to 50 events, a few seconds after a step and at start. Every request carries:

* `schema`: the format version, `1`.
* `funnelId`: a random ID created when you agree. It links the steps of this install and nothing else. It is not your installation ID and is never sent with a license request.
* `appVersion`: the TenuVault version, such as `0.5.3`.
* `os`: `win32`, `darwin` or `linux`.
* `channel`: `stable` or `nightly`.
* For each event: `seq` (a counter starting at 1), `name`, `at` (the time on your computer) and the props listed below.

| Event | When | Props |
| --- | --- | --- |
| `consent` | You agreed | `where`: `welcome`, `error` or `settings` |
| `first_launch` | Right after you agreed | `osVersion`: the major and minor version of the operating system, such as `15.2` or `10.0`. `arch`: `x64`, `arm64`, `ia32` or `other`. `managedInstall`: whether IT manages the install (the MSI or the `DisableAutoUpdate` policy) |
| `welcome_continue` | You selected **Connect your tenant** | None |
| `setup_route` | You chose how to connect | `route`: `auto` (setup with Microsoft sign-in), `script`, `manual` (an existing app registration) or `handoff` (instructions for another admin) |
| `setup_signin` | The sign-in to Microsoft Graph Command Line Tools during the setup ended | `result`: `ok`, `failed`, `cancelled` or `timeout`. `code`, for a failure |
| `registration` | Creating or finding the app registration ended | `result`: `created`, `reused`, `failed`, `not_ready`, `missing_consent` or `cancelled`. `phase`: the step it ended in (`signingIn`, `registration`, `consent` or `publishing`). `code`, for a failure |
| `script_saved` | You saved the setup script | None |
| `signin` | The first sign-in to your tenant's app registration ended | `result`: `ok`, `failed`, `cancelled` or `timeout`. `code`, for a failure. `explained`: whether TenuVault showed its own explanation of the error |
| `license` | A license decision for a new tenant | `outcome`: `trial_started`, `community`, `licensed`, `refused` or `unreachable`. `reason`: the licensing service's refusal reason, or why no trial started, such as `trials_unavailable` |
| `storage` | You saved a tenant with its backup storage | `kind`: `local`, `share` (a backup folder on a network share) or `azure` |
| `tenant_added` | The first tenant was saved | None |
| `first_backup` | A backup ended, manual, scheduled or from the tray, until the first one that works | `result`: `ok`, `partial` or `failed`. `errorClass`, for a failure: `network`, `permission`, `throttled`, `storage`, `cancelled` or `other` |
| `active_day` | The first launch on each later calendar day | `day`: days since you agreed, 1 to 30 |

A `code` is only ever one of these: a Microsoft error code such as `AADSTS53003`, an HTTP status such as `HTTP_403`, a network failure kind (`proxy_auth`, `tls`, `proxy`, `timeout` or `unreachable`) or a Microsoft sign-in library code such as `interaction_required`. Anything else is sent as `other`. **Repeat reporting.** One-time events, sent once: `consent`, `first_launch`, `welcome_continue`, `script_saved` and `tenant_added`. Attempt events, sent per attempt and capped per install, so a setup that fails and then works shows both: `setup_signin`, `registration` and `signin` up to 10 times each, `setup_route` up to 10 times, `license` up to 10 times, `storage` up to 5 times, and `first_backup` until the first backup that works, at most 5 times. `active_day` is sent once per day.

**Never sent:** tenant names or IDs, domains, account names, user principal names or email addresses, app registration client IDs, your installation ID or license key, error message text, file paths, policies, backups or anything else from your tenant. The ingest service accepts only the fields above and rejects a request with anything else. It does not store your IP address or browser details; your IP address is used in memory only, to limit the number of requests.

**Kept:** on your computer, events wait in the encrypted app storage until they are sent; events that could not be sent within 7 days are dropped, and the queue holds at most 100. 30 days after you agreed, the random ID and anything still queued are deleted from your computer and nothing more is sent. On tenuvault.com, events are kept 180 days, then deleted.

**Turning it off.** Turning off **Share setup diagnostics** in **Settings** > **About** stops any upload, deletes the random ID and the queue at once, and deletes the events already sent: TenuVault sends `POST https://www.tenuvault.com/api/desktop-events/erase` with only the schema version and the random ID, and keeps that ID, and nothing else, until tenuvault.com confirms the deletion. If the erase address stays blocked, TenuVault gives up after 180 days, when tenuvault.com has deleted those events anyway. tenuvault.com then keeps only the random ID, as a marker for 180 days, so an upload that arrives late for it is discarded. The `DisableSetupDiagnostics` policy does the same for an install that was sharing. At the normal end of the 30 days, the ID and queue are deleted from your computer, and the events already sent stay until the 180 days are over. From then on they can no longer be linked to your installation, so turning sharing off after the 30 days cannot delete them early. After you turn it off, turning it on again starts with a new random ID and new 30 days. Once the 30 days have ended, it cannot be turned on again.

**Turn it off for your organization.** Set the policy `DisableSetupDiagnostics`. TenuVault then never asks, sends no events, and the toggle in **Settings** is locked off. An install that was already sharing stops, deletes its random ID and queue, and sends the one erase request above. TenuVault reads the policy when it starts.

* **Windows:** a DWORD value `DisableSetupDiagnostics` = `1` under `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\TenuVault` (all users) or `HKEY_CURRENT_USER\SOFTWARE\Policies\TenuVault` (one user). Deploy it like `DisableAutoUpdate`, see [Deploy TenuVault in your organization](/deploy/#turn-off-setup-diagnostics).
* **macOS:** the managed preference `DisableSetupDiagnostics` = `true` (boolean) for the preference domain `com.tenuvault.desktop`.

**Firewall.** Setup diagnostics use `www.tenuvault.com`, which the allow list below already contains. If your proxy filters by path, `https://www.tenuvault.com/api/desktop-events` and `https://www.tenuvault.com/api/desktop-events/erase` may stay blocked: nothing else depends on them, and the queued events are dropped after 7 days.

## App Backup

[App Backup](/apps/app-backup/) lists the Win32 apps of a tenant, captures an app's installer from Intune on an enrolled Windows PC, keeps it encrypted on your device and can restore it as a new app in a connected tenant. Listing apps uses Microsoft Graph like the rest of TenuVault. Capturing and restoring an installer add the connections described in this section.

| Action | Where it runs | Destinations |
| --- | --- | --- |
| List apps, open **Details**, print details, download a script | Windows and macOS | `graph.microsoft.com`, and `login.microsoftonline.com` when your token has to be renewed |
| Enrollment check and **Assignment check for this PC** | Windows | `graph.microsoft.com`, and `login.microsoftonline.com` when your token has to be renewed |
| **Start backup**: capture an installer | Windows, on a PC enrolled in the selected tenant | `www.tenuvault.com/api/app-backup/capture-policy`, `login.microsoftonline.com`, `graph.microsoft.com` and two addresses under `manage.microsoft.com` |
| **Export installer**, **Open local folder** | Windows and macOS | None |
| **Restore to tenant** | Windows and macOS | `login.microsoftonline.com`, `graph.microsoft.com` and an Azure Storage address under `blob.core.windows.net` that Intune returns |

**View app in Intune**, **Intune** in the **Details** dialog and **Open restored app** open the Intune admin center (`intune.microsoft.com`) in your default browser. The app does not request those pages itself.

### Capture check

Installer capture depends on Intune's device content service, not on a documented Microsoft Graph download API. So that capture can be paused, or tied to a newer TenuVault version, if that integration needs a fix, TenuVault asks tenuvault.com before every capture whether capture is allowed. The request goes out when you select **Start backup** and is the first request of the capture: the token refresh, the Microsoft Graph reads, the Windows approval prompt and the request to Intune follow only after a valid answer. It is made only on Windows, because capture runs only there.

* **Sent:** a `GET` request to `https://www.tenuvault.com/api/app-backup/capture-policy?nonce=<value>`. `nonce` is the only parameter: 32 random bytes, written as 64 hexadecimal characters and created for this one request. The request has no body and no cookies, and TenuVault adds no header to it. Like every request the app makes, it carries the standard headers of the app's network stack. Among them is `User-Agent`, which names TenuVault with its version and the operating system.
* **Not sent:** Microsoft tokens, the tenant ID, the license key or the signed entitlement, the installation ID, the selected app or anything else from your tenant.
* **Received:** a short signed answer. It repeats the `nonce` and states whether capture is enabled, the oldest TenuVault version that may capture, the platform (`win32`) and an issue time and an expiry time at most 5 minutes apart. TenuVault checks the signature with public keys built into the app and accepts the answer only if it repeats the `nonce` of this request, so an earlier answer cannot be reused. It compares the minimum version with its own version on your computer. The answer is not saved: the next capture asks again.
* **If the answer says no:** when capture is paused, TenuVault shows **Installer capture has been paused.** When your version is older than the minimum, it shows **Update TenuVault before starting a new app backup.** No capture starts.
* **If blocked:** when the address does not answer within 10 seconds, redirects, or returns anything that is not a valid signed answer, no capture starts and TenuVault shows **Installer capture is temporarily unavailable.** Listing apps, exporting installers you already captured and **Restore to tenant** do not use this check and keep working.

As with any web request, the service also sees your public IP address.

### Installer capture

Capture runs only on a Windows PC that is enrolled in the selected tenant. It starts when you select **Start backup**. The capture helper that is installed with TenuVault, **TenuVault.Capture.exe**, makes its requests only after you approve the Windows prompt for it. After the capture check, one capture makes these requests, in this order:

1. **`login.microsoftonline.com` and `graph.microsoft.com`.** TenuVault refreshes your delegated token and reads the selected app with its settings and relationships. The helper then uses the same token to confirm your account (`/me`) and to read the tenant's Intune account ID, the app's committed content version and the list of its content files. After step 2, TenuVault reads the app's settings once more to make sure they did not change during the capture. All of these are read requests.
2. **Intune's device content service, `agents.<name>.manage.microsoft.com`.** The helper sends one request to the service address that the Intune Management Extension on this PC discovered. TenuVault contains no fixed host name for it: the helper reads the address from the agent's own log files on the PC, uses only files changed in the last 7 days, and accepts only an `https` address of the form `agents.<name>.manage.microsoft.com`. The request is authenticated with this PC's Intune enrollment certificate as a TLS client certificate and carries no Microsoft Graph token.
3. **The installer download, a host under `manage.microsoft.com`.** Intune's answer contains the download address of the installer content. TenuVault contains no fixed host name for this one either. It downloads from the returned address only if that is an `https` address on the default port whose host is `manage.microsoft.com` or a host under it, and it refuses redirects. The download request carries no Microsoft token, no certificate and no cookies.

What the request in step 2 carries:

* **Sent:** the tenant's Intune account ID, the device ID from this PC's enrollment certificate, a random session ID, the selected app's ID, content version and display name, the enrollment certificate without its private key, the computer name, the Windows version and the version of the Intune Management Extension.
* **Received:** the download address, the size of the installer and the decryption information for it, encrypted for the enrollment certificate. The helper decrypts that information with the certificate's private key. The private key is used on the PC and is not exported or sent.

The helper sends its requests in steps 1 and 2 itself. They do not pass through the network stack that the rest of TenuVault uses. The download in step 3 is made by TenuVault itself, like its other requests, and uses a proxy sign-in saved in TenuVault.

TenuVault passes the helper only the tenant ID, the app ID, a job ID and the access token, so a proxy user name and password saved in TenuVault do not reach it, and the helper shows no proxy sign-in prompt. It uses the default proxy handling of the .NET Framework. Whether it signs in to a proxy with your Windows account depends on the .NET configuration of the PC and is not guaranteed. A proxy challenge that stays unanswered on one of the helper's requests stops the capture. To avoid that, allow `graph.microsoft.com`, `manage.microsoft.com` and `*.manage.microsoft.com` without proxy authentication on the capture PC.

Exclude `manage.microsoft.com` and `*.manage.microsoft.com` from HTTPS inspection: the request in step 2 presents this PC's enrollment certificate, which an inspecting proxy cannot pass on, and Microsoft does not support SSL inspection for `*.manage.microsoft.com`.

TenuVault decrypts the installer while it downloads, checks it against the size, HMAC and SHA-256 digest from Intune's answer, and writes it to the App Backup folder on your device, by default the folder `TenuVault App Sources` in your Documents folder, encrypted with AES-256-GCM with a key derived from your TenuVault backup key (see [Encryption and recovery key](/security/encryption/)). No unencrypted copy of the installer is written during capture. The app's settings are stored next to it, encrypted in the same way. Captured installers and their settings are not sent to tenuvault.com, and App Backup does not copy them to your Azure storage account. An unencrypted copy exists only where you save one with **Export installer**.

### Restore to tenant

**Restore to tenant** needs no enrolled PC and runs on Windows and macOS. It uses two destinations:

1. **`graph.microsoft.com`**, with your delegated token for the destination tenant. TenuVault creates a new Win32 app from the settings you reviewed, adds a content version and a content file entry to it and waits for the upload address that Intune creates. After the upload it commits the file and waits until Intune reports the app as published. It also reads the new app and its assignments to confirm that nothing else changed the app during the restore. To continue an interrupted restore without creating a second app, it can read the IDs and notes of the destination's apps. For a backup that was captured before settings were stored with it, **Load current app settings** first reads the app and its relationships from the source tenant, also through `graph.microsoft.com` and with your token for that tenant.
2. **The upload address, a storage account under `blob.core.windows.net`.** Intune returns the address in the `azureStorageUri` property of the content file, and TenuVault uploads the installer to exactly that address, in blocks of 4 MiB. TenuVault contains no fixed host name for it. It uploads only if the address is an `https` address on the default port, its host is one storage account name directly under `blob.core.windows.net` and it contains a signature (a shared access signature). The upload requests carry no Microsoft token: the signature in the address is their only authorization. During a long upload, TenuVault asks Intune through Microsoft Graph to renew the address.

Microsoft documents `azureStorageUri` as [created by the Intune service](https://learn.microsoft.com/graph/api/resources/intune-apps-mobileappcontentfile?view=graph-rest-beta) when it receives the content file entry. It is not the storage account you may have chosen for your backups, and the upload uses no Azure role assignment and no sign-in to Azure.

* **Uploaded to the storage address:** the installer, encrypted on your machine with new random keys (AES-256-CBC with HMAC-SHA256) before it leaves it. Apart from the list of uploaded blocks that completes the upload, nothing else is sent there.
* **Sent to Intune through Microsoft Graph:** the app settings you reviewed, with the app name you entered and a restore marker in the app's notes, the file's size before and after encryption and, in the `commit` request, the keys and the SHA-256 digest of the installer before encryption, so that Intune can decrypt and verify it.
* **Not sent:** nothing from a restore goes to tenuvault.com, and a restore does not use the capture check.

If the destination tenant has no active session, you sign in to it at `login.microsoftonline.com`, in your browser or with **Use a device code**. With a device code, TenuVault shows a code and a Microsoft address that you can open on another device, and waits for the result at `login.microsoftonline.com`.

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

Some buttons open a web page in your default browser instead of making a request from the app, for example **Buy now**, **Buy Pro**, **Compare plans**, **Manage subscription**, **Setup guide**, **Free setup call** and **Book a free setup call**. These pages are visited by your browser only when you click them. TenuVault only opens `https` and `mailto` links, and never loads external pages inside the app window.

## Firewall allow list

To use every feature, allow outbound HTTPS (TCP 443) to:

```
login.microsoftonline.com
graph.microsoft.com
management.azure.com
<your storage account>.blob.core.windows.net
manage.microsoft.com
*.manage.microsoft.com
*.blob.core.windows.net
www.tenuvault.com
github.com
release-assets.githubusercontent.com
objects.githubusercontent.com
api.github.com
raw.githubusercontent.com
```

`management.azure.com` and your storage account are needed only for backups in Azure. The GitHub hosts are needed only for updates and baseline packs. If you configure a health review webhook, also allow its host.

`manage.microsoft.com`, `*.manage.microsoft.com` and `*.blob.core.windows.net` are needed only for [App Backup](#app-backup), and each for one action only:

| Allow | Needed only for | Why it is not a single host |
| --- | --- | --- |
| `manage.microsoft.com` and `*.manage.microsoft.com` | Capturing an installer, on the enrolled Windows PC that runs the capture. Exclude them from HTTPS inspection. For proxy authentication, see [Installer capture](#installer-capture) | The address of Intune's device content service comes from the Intune agent on the PC, and the download address comes from Intune's answer. TenuVault accepts `manage.microsoft.com` itself and any host under it for the download. Microsoft lists `*.manage.microsoft.com` and `manage.microsoft.com` as required for Intune-managed devices and states that SSL traffic inspection is not supported for `*.manage.microsoft.com`. See [Network endpoints for Microsoft Intune](https://learn.microsoft.com/intune/fundamentals/endpoints). |
| `*.blob.core.windows.net` | **Restore to tenant** | Intune chooses the storage account and returns its address for each upload, so the account name is not known in advance. |

Capturing an installer also needs the [capture check](#capture-check) at `https://www.tenuvault.com/api/app-backup/capture-policy`. It is covered by `www.tenuvault.com`. Allow the path if your proxy filters by path. Capture and restore also use `login.microsoftonline.com` and `graph.microsoft.com`, like every other feature. On the PC that captures, the capture helper requests `graph.microsoft.com` itself, without the proxy sign-in saved in TenuVault, see [Installer capture](#installer-capture). Listing apps and their details needs nothing else, and exporting an installer needs no connection.

## Related pages

* [Security and privacy](/security/)
* [App registration and delegated permissions](/security/permissions/)
* [Backup Reader for scheduled backups](/backups/backup-reader/): the optional app-only identity and its certificate
* [Encryption and recovery key](/security/encryption/)
* [App Backup: Intune installers](/apps/app-backup/)
* [Requirements](/getting-started/requirements/)
