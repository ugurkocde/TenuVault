---
title: "Start TenuVault for the first time"
description: What the welcome screen shows, how the 14 day Pro trial starts when you connect your tenant, and how to enter a license key.
---

The first time you start TenuVault, it shows **Welcome to TenuVault**. There is no plan to choose here: you connect your tenant first, and TenuVault checks the tenant's plan as you finish setup.

The welcome screen appears while this computer has no license key, no tenant licensed through its organization and no connected tenant. TenuVault skips it in these cases:

* You saved a key or connected a tenant. TenuVault opens straight into the app.
* You already started the setup on this computer and did not finish it. TenuVault opens **Set up TenuVault** where you left off.

While no tenant is connected, TenuVault always opens the guided setup, **Set up TenuVault**, instead of an empty dashboard.

## What the welcome screen shows

* Three short points on what TenuVault does: choose Microsoft services to protect with encrypted backups you own, restore a single policy or a whole set, and see what changed between backups.
* **Connect your tenant**: opens **Set up TenuVault**.
* **What TenuVault sends** opens the data flows page.
* **I have a license key** opens license-key entry.

To buy a license or ask for an invoice, use the **License** page after setup. See [Activate and manage your license](/licensing/manage/).

## Connect your tenant

Select **Connect your tenant**. Intune starts selected. Select any additional service you want to connect. Entra ID includes Conditional Access.

Choose a sign-in method and sign in with Microsoft. TenuVault uses your signed-in tenant for **Start now**, **TenuVault app** and **Set up with Microsoft sign-in**. If you administer a different tenant as a guest, open **Different tenant?** before signing in. An existing app registration still needs its tenant ID and client ID.

**Check** moves to **Storage** when all selected services have backup access. If only some services can be read, select **Continue with** the services listed. Open **Details** to review access and check again.

For the first backup, **This device, encrypted** is selected. If your method and plan support Azure, select **Your Azure storage account**, choose an account and wait for access to be checked. Select **Start first backup**. When it finishes, you can turn on scheduled backups, save the recovery key for on-device backups, and go to the dashboard. You can also choose whether to share anonymous setup results.

## Start a trial

There is nothing to start: connecting a new tenant starts its 14 day Pro trial automatically, with no card and no email. When the trial starts during sign-in, open **Plan details** on **Storage** to see its end date. If your organization shares a TenuVault license with your tenant, TenuVault checks it when you finish setting up the tenant. The trial ends without a charge, can be extended once, and afterwards one tenant continues on Community. See [Free trial, no card needed](/licensing/#free-trial-no-card-needed).

## Enter a license key

1. Select **I have a license key**.
2. Paste the key from your email into **License key**.
3. Select **Save key**.

The key is saved on this device and activated for your tenant when you finish setup. TenuVault then opens **Set up TenuVault**; see [Choose a sign-in method](/getting-started/connect-tenant/).

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

[Choose a sign-in method](/getting-started/connect-tenant/).
