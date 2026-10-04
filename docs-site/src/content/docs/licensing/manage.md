---
title: "Activate and manage your license"
description: Enter your license key, share it with your tenant's admins, move it to another machine and fix license errors.
---

You manage your license on the **License** page in the TenuVault sidebar. This page explains how to activate a key, how licensing works per tenant, how to share a license with other admins and how to move a license to another machine.

## How license checks work

* Each tenant is licensed on its own. The first time you use a tenant, TenuVault activates your license for it with the licensing service at tenuvault.com.
* TenuVault refreshes each activation every 6 hours while it runs.
* If the licensing service cannot be reached, active tenants keep working offline for up to 14 days after their last successful check. The **License** page then shows: "The licensing service could not be reached. Tenants that are already active keep working until their verification expires."
* Your license key is stored in TenuVault's encrypted app store on your machine.

License checks never include tenant configuration, backups or Microsoft access tokens. For the exact fields, see [Network connections and data flows](/security/data-flows/).

## Activate a license key

You receive your license key by email right after checkout.

### On the welcome screen

If you have not connected a tenant yet, TenuVault opens on **Welcome to TenuVault**.

1. Under **Already have a license key?**, paste your key.
2. Click **Save key**.
3. Click **Start free with Community** to continue to the tenant sign-in. Your key is activated for the tenant when you sign in to it.

### On the License page

1. Click **License** in the sidebar.
2. Paste your key into **License key**.
3. Click **Activate**.

If you are already signed in to one or more tenants, TenuVault activates the key for them right away and shows **License activated.** If you are not signed in to a tenant yet, it shows **License key saved. It activates for a tenant when you sign in to it.**

If the key cannot be activated for any of your signed-in tenants, it is not saved and the reason is shown. See [License messages](#license-messages).

## Read the License page

The top card shows your plan, for example **Pro plan active**, and how many tenants your license covers and how many are active on this machine. Your key is shown masked, with only its last four characters visible.

The **Tenants** card lists every tenant on this machine with its license state:

| Badge | Meaning |
| --- | --- |
| **Active, Pro** or **Active, MSP** | The tenant is licensed with your key. **Verified until** shows when the current verification expires if TenuVault cannot refresh it. |
| **Active through your organization (Pro)** or **(MSP)** | The tenant is licensed through a license another admin shared with it. |
| **Community (free)** | The tenant uses the free plan. |
| **Not active** | You are signed in, but the tenant is not licensed. The reason is shown below the tenant. Click **Retry** after fixing it. |
| **Not signed in** | Sign in to the tenant so TenuVault can check its license. |

## Add and remove tenants

* **Adding a tenant:** TenuVault checks the license when you sign in to a new tenant. If your license does not cover it, the tenant is not added and the reason is shown, for example that your license already covers its maximum number of tenants.
* **Removing a tenant:** removing a tenant on the **Tenants** page releases its activation and frees its place on your license. Existing backups are kept and nothing in the tenant changes.

## Share the license with your tenant's admins

If several admins in one tenant use TenuVault, the key holder can share the license with them. They then need no key of their own.

1. On the machine that holds the key, open **License**.
2. In the **Tenants** card, find the tenant.
3. Select **Let other admins in this tenant use this license**.

Anyone who then signs in to this tenant with the same TenuVault app registration is licensed automatically. The key stays on the key holder's machine. Clear the checkbox to stop sharing.

Things to know:

* Sharing is on by default for Pro licenses and off by default for MSP licenses, since an MSP's customer tenants are usually not its own.
* Only the machine that holds the key can change sharing.
* To turn sharing on, TenuVault needs a recent sign-in to the tenant as proof. If it shows **Sign in to this tenant again to share the license with it.**, sign in to the tenant again and retry.
* Only admins who sign in through the app registration you shared from are licensed. To control who that is, restrict sign-in to a group. See [App registration and delegated permissions](/security/permissions/#restrict-sign-in-to-a-group).
* Each admin's machine counts as one of the tenant's 5 installations.

### For admins licensed through their organization

You do not need to enter a key. On the welcome screen, click **Start free with Community** and sign in to your tenant. TenuVault finds the shared license at sign-in and the **License** page shows **Licensed through your organization**.

TenuVault proves your sign-in to the licensing service with a fresh Microsoft ID token, which it requests silently. If that is not possible, the tenant shows "Sign in to this tenant again to check your organization's license." Sign in to the tenant again and click **Retry**.

## Move a license to another machine

1. On the old machine, open **License** and click **Deactivate this machine**.
2. Confirm the prompt: "Deactivate this machine? Backups that require this license will stop. Your existing backups remain available. Save your license key so you can activate again."
3. On the new machine, enter the key on the **License** page and click **Activate**.

Deactivating releases every activation of that machine and removes the key from it. If you no longer have access to the old machine, release its installation in the customer portal instead (see below).

To read your existing backups on the new machine, import your backup recovery key. See [Encryption and recovery key](/security/encryption/).

## Change your license key

To use a different key, first click **Deactivate this machine**, then enter the new key. TenuVault does not accept a new key while the current one is active on this machine and shows "Deactivate this machine before entering a different license key."

## Manage your subscription

Click **Manage subscription** on the **License** page to open the customer portal at [polar.sh/ugurlabs/portal](https://polar.sh/ugurlabs/portal) in your browser. There you can manage your subscription and release installations you no longer use.

To upgrade from Community, click **Buy a license** on the **License** page, or go to [tenuvault.com/desktop#pricing](https://tenuvault.com/desktop#pricing).

## License messages

| Message | What to do |
| --- | --- |
| This license key is not valid for TenuVault. | Check that you copied the whole key from your purchase email. |
| This license key is not valid, or it has been revoked or has expired. | Check your subscription in the customer portal. |
| This license already covers its maximum number of tenants. | Upgrade, or remove a tenant from TenuVault on the machine that uses it. |
| This tenant already has 5 active installations. | Deactivate an installation in the app or in the customer portal. |
| This license has no activations left. | Deactivate an installation in the customer portal. |
| This installation is no longer activated. | No action needed. It activates again the next time the tenant is used. |
| Your organization has no license for this tenant. | Ask the key holder to share the license with the tenant, or add your own key. |
| TenuVault Community covers one tenant, and it is used for tenant `<tenant ID>`. | Add a Pro or MSP license, or remove the other tenant to use the free plan here. |
| The licensing service is unavailable. Please try again later. | Wait and click **Retry**. Active tenants keep working offline. |
| Your Microsoft sign-in could not be verified by the licensing service. | Sign in to the tenant again and retry. |

## Related pages

* [Plans and features](/licensing/)
* [Choose a plan on first launch](/getting-started/first-launch/)
* [Manage tenants](/tenants/)
* [Network connections and data flows](/security/data-flows/)
