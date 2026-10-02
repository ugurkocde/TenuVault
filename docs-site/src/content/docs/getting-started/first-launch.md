---
title: "Choose a plan on first launch"
description: What the welcome screen offers and how to pick Community, a trial or a license key.
---

The first time you start TenuVault, it shows **Welcome to TenuVault**. Here you choose how to start: free with Community, with a 30 day trial of Pro or MSP, or with a license key you already have.

The welcome screen appears while this computer has no license key and no connected tenant. Once you connect a tenant or save a key, TenuVault opens straight into the app.

## The three options

| Option | What it does | Choose it when |
| --- | --- | --- |
| **Start free with Community** | Opens the guided setup, **Set up TenuVault**. No key is needed. | You want to try TenuVault on one tenant, or your organization already shares a TenuVault license with your tenant. |
| **Try Pro or MSP free for 30 days** | Opens the TenuVault pricing page in your browser, where you start a trial. | You want Pro or MSP features, such as daily schedules or Azure storage. |
| **Already have a license key?** | Saves the key you paste on this device. | You received a key by email. |

Community is free for one tenant, with manual and weekly backups. You can upgrade any time from the **License** page. For what each plan includes, see [Plans and features](/licensing/).

## Start with Community

1. Select **Start free with Community**.
2. TenuVault opens **Set up TenuVault** on the **Prepare** step. Continue with [Sign in to your tenant](/getting-started/connect-tenant/).

The first tenant you sign in to without a key uses Community. If your organization shares a TenuVault license with that tenant, TenuVault picks it up when you sign in, and the tenant uses that plan instead.

## Start a trial

1. Select **Try Pro or MSP free for 30 days**. The pricing page opens in your browser.
2. Complete the checkout for the plan you want. Your license key arrives by email. Keys start with `TENU`.
3. Return to TenuVault and follow [Enter a license key](#enter-a-license-key).

## Enter a license key

1. Under **Already have a license key?**, paste the key from your email.
2. Select **Save key**.

The key is saved on this device and activated for your tenant when you sign in. TenuVault then shows the dashboard. Select **Guided setup** to open **Set up TenuVault**, or **Connect tenant** to use the shorter dialog. Both lead to the same sign-in; see [Sign in to your tenant](/getting-started/connect-tenant/).

If the key is rejected, TenuVault shows the reason under the form. For activation details and error messages, see [Activate and manage your license](/licensing/manage/).

## What the license check sends

License checks go to tenuvault.com. They send the license key or your Microsoft sign-in token, the tenant ID and a random installation ID. Tenant configuration and backups are never sent. See [Network connections and data flows](/security/data-flows/).

## If TenuVault cannot unlock its saved data

TenuVault keeps its settings, sign-ins and license in a file encrypted with your operating system account. If it cannot decrypt that file, it shows **TenuVault cannot unlock its saved data.** with two choices:

* **Quit:** nothing is lost.
  * On macOS, allow TenuVault to access its Keychain item and start the app again.
  * On Windows, the data may belong to another Windows user. Start TenuVault as that user.
* **Start over:** TenuVault keeps the unreadable data as a backup file and starts fresh. You sign in to your tenants and activate your license again.

Starting over does not delete backups in your backup folder or storage account. You need your [recovery key](/security/encryption/) to read them with the new setup.

## Next step

[Sign in to your tenant](/getting-started/connect-tenant/).
