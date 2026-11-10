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

1. Click **I have a license key**.
2. Paste your key into **License key** and click **Save key**.
3. TenuVault opens **Set up TenuVault**. Your key is activated for the tenant when you sign in to it. See [Start TenuVault for the first time](/getting-started/first-launch/).

When tenant trials are on, the welcome screen explains that a new tenant starts with a Pro trial. When they are off, it offers **Try Pro free for 30 days, no card**. The **Storage** step of the setup offers both options for a tenant on Community.

### On the License page

1. Click **License** in the sidebar.
2. Paste your key into **License key**.
3. Click **Activate**.

### Start the email trial (when tenant trials are unavailable)

On Community, the **License** page shows **Try Pro free for 30 days, no card needed.**

1. Enter your work email address.
2. Click **Start free trial**. TenuVault asks tenuvault.com to email you a Pro trial key and shows **Check your inbox** with the address, plus the hint "Copy the key from your email and return to TenuVault: it activates by itself. Or paste it here." under **License key**.
3. Copy the key from the email and return to TenuVault. TenuVault finds the key on the clipboard and activates it. Or paste it into **License key** and click **Activate**.

While it waits for the trial key, TenuVault checks the clipboard when its window gets focus. Only text shaped like a TenuVault key, starting with `TENU-`, is ever read back; other clipboard content is ignored.

The key usually arrives within a minute, sometimes up to 15. Check your junk folder if it does not. **Buy now** opens the checkout in your browser instead, and **Compare plans** opens the plans page. Below it, **Need an invoice instead of a card?** explains that yearly Pro and MSP plans are available by quote, purchase order and invoice, payable by bank transfer, with a link to email [support@tenuvault.com](mailto:support@tenuvault.com). The same note appears on the trial panel and when a saved key is no longer active. A link also explains that eligible nonprofits can use Pro at no cost. **Start 30 day free trial** in other places, such as the second tenant dialog or the CIS Benchmarks preview, opens this form.

If you are already signed in to one or more tenants, TenuVault activates the key for them right away and shows **License activated.** If you are not signed in to a tenant yet, it shows **License key saved. It activates for a tenant when you sign in to it.**

If the key cannot be activated for any of your signed-in tenants, it is not saved and the reason is shown. See [License messages](#license-messages).

## Read the License page

The sidebar shows **Community** for a machine using the Community plan, or **Key saved** when a saved key is waiting for its first activation, including before you sign in to a tenant. If a saved key is refused or its cached activation can no longer be verified, the chip shows **Inactive** unless another paid license is active. The License page shows **License key inactive** with the reason. A refusal stays visible after a restart and when the tenant falls back to Community; Community remains available for one tenant. A successful key activation clears the refusal.

The neutral Community notice appears only on the start page: the **Dashboard** for one tenant, or the **All tenants** overview when several are connected. Click **Dismiss** to hide it on this machine for 30 days. License coverage, key expiry and offline verification warnings still appear on every page. The dashboard's **License** tile also opens the **License** page.

The top card shows your plan, for example **Pro plan active**, and how many tenants your license covers and how many are active on this machine. Your key is shown masked, with only its last four characters visible.

When the licensing service supplies a key expiry date, the top card also shows **License valid until** with the date. With several tenants, this is the earliest key expiry. Each tenant's License fact on the overview also shows its own **Valid until** date. Automatically renewing subscription keys may have no expiry date, so these lines stay hidden.

An amber warning appears 30 days before a license key expires and links to the **License** page. It names the key or, for a license shared by your organization, that license, and Pro or MSP features stop on that date unless the license is renewed. When the licensing service is unreachable and a cached verification runs out sooner, that warning is shown first. If the key has expired while a cached verification is still current, the warning says so. Once the service confirms the key has expired, Community can cover one tenant. When several connected tenants lack coverage and no Community tenant has been chosen, backups pause until the admin chooses one. You can decide later or add a license instead.

The **Tenants** card lists every tenant on this machine with its license state:

| Badge | Meaning |
| --- | --- |
| **Active, Pro** or **Active, MSP** | The tenant is licensed with your key. **Works offline until** shows when the cached verification expires if TenuVault cannot refresh it. This is separate from the license key's expiry. |
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

You do not need to enter a key. On the welcome screen, click **Connect your tenant** and sign in to your tenant in **Set up TenuVault**. TenuVault finds the shared license at sign-in and the **License** page shows **Licensed through your organization**.

TenuVault proves your sign-in to the licensing service with a fresh Microsoft ID token, which it requests silently. If that is not possible, the tenant shows "Sign in to this tenant again to check your organization's license." Sign in to the tenant again and click **Retry**.

## Move a license to another machine

1. On the old machine, open **License** and click **Deactivate this machine**.
2. Confirm the prompt: "Deactivate this machine? Backups that require this license will stop. Your existing backups remain available. Save your license key so you can activate again."
3. On the new machine, enter the key on the **License** page and click **Activate**.

Deactivating releases every activation of that machine and removes the key from it. If you no longer have access to the old machine, release its installation in the customer portal instead (see below).

Azure backups are readable on the new machine as soon as you choose the same storage account. To read backups kept on the old device, or Azure backups an earlier TenuVault version encrypted, import your backup recovery key. See [Encryption and recovery key](/security/encryption/).

## Change your license key

## After an email trial

For an email trial key, the top card shows **Pro trial active** and **Your Pro trial ends on** with the date and the days left. On day 20 and on day 27 a reminder appears at the top of every page with **Buy Pro**, which opens the checkout, and **Details**, which opens the **License** page. Unless you have bought a plan, tenuvault.com also emails you 5 days and 1 day before the trial ends. **Dismiss** hides an in-app reminder on this machine; the day 27 reminder still appears after you dismissed the day 20 one. The trial end is not counted as **License valid until**, so the generic 30 day expiry warning is not shown for the trial key. It still appears for another license, such as one shared by your organization.

To keep Pro:

1. Click **Buy Pro** in the reminder, or **Buy Pro** or **Buy MSP** on the **License** page, and complete the checkout. The checkout asks for payment right away; there is no second trial.
2. Your new license key arrives by email.
3. On the **License** page, click **Enter your new key**, paste the key and click **Use this key**. TenuVault activates the new key for every tenant the trial key covers on this machine, and for signed-in tenants that are not licensed yet, and only then releases the trial key. If the new key is refused for a tenant the trial key covers, nothing changes: the trial key stays active and the reason is shown. Tenants licensed through your organization keep that license.

If you do nothing, the trial key expires at the end of day 30, also when TenuVault is offline. Nothing is charged. One tenant continues on Community, the free plan for one tenant; a second tenant is no longer covered. Pro features turn off, and your backups stay where they are. When several connected tenants lack coverage and no Community tenant is selected yet, TenuVault asks which one continues on Community. See [When paid coverage ends](#when-paid-coverage-ends) for schedules and paused features.

To use a different key while one is active, click **Use a different key** next to the saved key on the **License** page and paste the new key. The new key is activated first, for every tenant the saved key covers on this machine; only then is the saved key released. If the new key does not cover one of those tenants, nothing changes and the reason is shown. Replacing a running trial key with **Enter your new key** works the same way, and so does **Enter a new key** for a saved key that is no longer active, for example after the trial ended. Licenses shared by your organization stay in place through every swap.

## Tenant trials

When enabled, a new connection starts a Pro trial without a card or email. Existing Community tenants can opt in on the License page. Joining from another installation keeps the tenant's original end date. Days remaining and the end date appear on the License page.

Choose **Need more time? Extend your trial** during the last five days or within fourteen days after expiry. You can extend once. Only the installation that started the trial offers **Use Community instead**. TenuVault asks you to confirm first: ending early uses up the trial, and it cannot be started again for that tenant.

The optional email field sends nothing until you press **Email me setup tips and a reminder before the trial ends**. You can change or remove the saved address in the app during the trial on the License page of any installation that joined it, or unsubscribe at any time using the link in each email. See the [privacy policy](https://www.tenuvault.com/privacy).

At the end, backups and settings are kept. Community keeps thirty days of history, daily schedules run weekly, and Azure backups, alerts, health review and change reports pause. One tenant continues on Community. With several trial tenants, choose which, or decide later. Buy Pro and enter the purchase key to restore paid features and the saved daily schedule. Once a tenant has used its trial, the License page offers **Buy Pro** instead of another trial.

When tenant trials are off, the email trial form and existing email trial keys continue working as before.

## Manage your subscription

Click **Manage subscription** on the **License** page to open the customer portal at [polar.sh/ugurlabs/portal](https://polar.sh/ugurlabs/portal) in your browser. There you can manage your subscription and release installations you no longer use.

To upgrade from Community, start the free trial or click **Buy now** on the **License** page, or go to [tenuvault.com/pricing](https://tenuvault.com/pricing).

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
| This computer's clock is ahead. | Set the correct date and time, then retry. |
| The license could not be verified: it was not signed by the TenuVault licensing service this app trusts. | Update TenuVault. If it persists, a proxy may be rewriting licensing responses. See [Troubleshooting](/troubleshooting/#license). |
| The licensing service is busy with many requests from your network. | Wait the time shown and retry. |

## Related pages

* [Plans and features](/licensing/)
* [Start TenuVault for the first time](/getting-started/first-launch/)
* [Manage tenants](/tenants/)
* [Network connections and data flows](/security/data-flows/)

## When paid coverage ends

A saved daily schedule runs weekly on Community at its saved time. The weekday comes from the first slot after coverage ended. The daily schedule stays saved and resumes daily when Pro returns. You can pause and resume the saved schedule on Community. You can also change its saved time. Creating a daily schedule or changing a weekly schedule to daily needs Pro. TenuVault checks for renewed coverage in the background, including while the app is in the tray.

Azure storage schedules pause with **Paused: Azure storage needs Pro**. Choose **Switch to weekly local backups** and confirm to save future backups on this computer. Your saved schedule stays unchanged. If backups were missed while paused, the most recent due slot is caught up under the normal retry rules. Missed weeks are not queued as separate backups. The Azure account settings are kept on this computer across restarts. Choose **Switch back to saved Azure storage**, or select the saved account in **Change storage**, to list or restore existing Azure backups. On Community, new backups pause again while Azure is selected. With Pro, Azure backups resume. Community cannot set up a new Azure account. Tenant profile edits stay on this computer while Azure storage needs Pro.

An operating system notification announces the weekly fallback or a paused Azure schedule once. A pending Community choice also sends a notification asking you to open TenuVault and choose a tenant to resume backups.

Configured alerts, scheduled health reviews and automatic change reports pause on Community. Their pages say **Paused on Community** and link to License. Their configuration stays saved.

After coverage is known to have ended, if more than one connected tenant lacks coverage and Community has no tenant yet, choose which tenant continues on Community. Backups pause while the choice is pending. Tenants whose coverage cannot be checked are shown but cannot be chosen yet. Use **Retry** in the picker to check them again.

The Community choice is final. Other tenants stay locked, and their backups are kept. Add a license to use them again. Fresh installations without coverage history still assign Community to the first tenant used.

You can close the picker with **Decide later** without choosing. A notice and **Choose tenant** buttons let you return during the same session. The picker opens again after restarting the app. **Add a license instead** opens License so you can buy Pro or enter a key.

### More time and purchasing help

A trial key works for a tenant that has not had a Pro trial yet. If the tenant already used a tenant trial or another emailed trial key, TenuVault keeps the saved key and any existing coverage. The key can still work for another eligible tenant. Buy Pro to continue, or write to [support@tenuvault.com](mailto:support@tenuvault.com?subject=TenuVault%20Pro%3A%20quote%20or%20invoice) for a quote or an invoice.

Trial notices offer Buy Pro, a self-service extension when available, and a way to contact us.
Use **Extend trial** in a notice or on the License page. The button shows the extension length
reported by the licensing service. Before the extension window, the notice shows when it opens
when the service supplies that date. You can extend once; after extending, the new end date appears.

Need a quote or an invoice for your purchasing team? Write to [support@tenuvault.com](mailto:support@tenuvault.com?subject=TenuVault%20Pro%3A%20quote%20or%20invoice).
You can ask questions there too. The link does not send tenant or account details.

While TenuVault runs in the tray, a system notification reminds you when a tenant trial has
one day left and when it ends. Clicking opens the License page. Each notice appears at most once
per trial end date, including across restarts. Extending re-arms the reminder for the new date.
Paid tenants and tenants covered by an organization license do not receive these notices.

TenuVault keeps a short tally of Pro features used during the trial on this computer to show it in the trial notices. It is never sent.
