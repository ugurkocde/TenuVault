---
title: "Start TenuVault for the first time"
description: What the welcome screen shows, and how to start the free Pro trial or enter a license key before you connect your tenant.
---

The first time you start TenuVault, it shows **Welcome to TenuVault**. There is no plan to choose here: you connect your tenant first, and TenuVault shows the tenant's plan once you have signed in.

The welcome screen appears while this computer has no license key, no tenant licensed through its organization and no connected tenant. TenuVault skips it in these cases:

* You saved a key or connected a tenant. TenuVault opens straight into the app.
* You already started the setup on this computer and did not finish it. TenuVault opens **Set up TenuVault** where you left off.

While no tenant is connected, TenuVault always opens the guided setup, **Set up TenuVault**, instead of an empty dashboard.

## What the welcome screen shows

* Three short points on what TenuVault does: back up your Intune policies encrypted on this computer, restore a single policy or a whole set, and see what changed between backups.
* **Connect your tenant**: opens **Set up TenuVault**.
* A note that setup takes a few minutes: connect your tenant with Microsoft sign-in and take a first backup. Community is free for one tenant, and a TenuVault license your organization shares with the tenant is picked up when you sign in.
* Two links: **Try Pro free for 30 days, no card** and **I have a license key**.

To buy a license or ask for an invoice, use the **License** page after setup. See [Activate and manage your license](/licensing/manage/). For what each plan includes, see [Plans and features](/licensing/).

## Connect your tenant

1. Select **Connect your tenant**.
2. TenuVault opens **Set up TenuVault** on the **Connect** step, where one Microsoft sign-in creates the app registration in your tenant. Continue with [Create the app registration](/getting-started/app-registration/).

The first tenant you sign in to without a key uses Community. If your organization shares a TenuVault license with that tenant, TenuVault picks it up when you sign in, and the tenant uses that plan instead. You can also start the trial or enter a key later, on the **Storage** step of the setup or on the **License** page.

## Start a trial

1. Select **Try Pro free for 30 days, no card**.
2. Enter your work email address and select **Start free trial**. No payment card is needed.
3. TenuVault shows **Check your inbox** and a **Your trial key** field. The key usually arrives within a minute. Keys start with `TENU-`.
4. Copy the key from the email and return to TenuVault. TenuVault finds the key on the clipboard and saves it by itself. You can also paste it into **Your trial key** and select **Save key**.

TenuVault reads the clipboard only while it waits for a trial key, and only when its window gets focus. Only text shaped like a TenuVault key, starting with `TENU-`, is ever read back into the app; anything else on the clipboard is ignored.

The trial runs for 30 days and ends without a charge. See [Free trial, no card needed](/licensing/#free-trial-no-card-needed).

## Enter a license key

1. Select **I have a license key**.
2. Paste the key from your email into **License key**.
3. Select **Save key**.

The key is saved on this device and activated for your tenant when you sign in. TenuVault then opens **Set up TenuVault**; see [Create the app registration](/getting-started/app-registration/).

If the key is rejected, TenuVault shows the reason under the field. For activation details and error messages, see [Activate and manage your license](/licensing/manage/).

## What the license check sends

License checks go to tenuvault.com. They send the license key or your Microsoft sign-in token, the tenant ID and a random installation ID. Tenant configuration and backups are never sent. See [Network connections and data flows](/security/data-flows/).

## If TenuVault cannot unlock its saved data

TenuVault keeps its settings, sign-ins and license in a file encrypted with your operating system account. If it cannot decrypt that file, it shows **TenuVault cannot unlock its saved data.** with two choices:

* **Quit:** nothing is lost.
  * On macOS, allow TenuVault to access its Keychain item and start the app again.
  * On Windows, the data may belong to another Windows user. Start TenuVault as that user.
* **Delete backup key and start over:** TenuVault keeps the unreadable data as a backup file and starts fresh. This deletes the backup encryption key from the active app state, along with your sign-ins and license. You sign in to your tenants and activate your license again.

Backups on this device become unreadable unless you exported their [recovery key](/security/encryption/), and so do Azure backups that an earlier TenuVault version encrypted with it. Azure backups made by this version stay readable. Starting over leaves the backup files in your backup folder or storage account. To export the key first, choose **Quit**, restore access to the saved data, then select **Settings** > **Storage and recovery** > **Save recovery key**. If you already exported it, use **Import a recovery key** in the same Settings section after starting over.

## Next step

[Create the app registration](/getting-started/app-registration/).
