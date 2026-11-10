---
title: "Plans and features"
description: Compare the Community, Pro and MSP plans and see which features each includes.
---

TenuVault has three plans: Community, which is free, and the paid Pro and MSP plans. Every tenant you connect is licensed on its own, and the plan decides how many tenants you can use and which features are available for them.

## Plans at a glance

| | Community | Pro | MSP |
| --- | --- | --- | --- |
| Price | Free, no license key needed | Paid subscription | Paid subscription |
| Tenants | 1 | 2 (for example production and test) | The number of tenants in your subscription. New subscriptions include 5; existing subscriptions keep their quantity (minimum 3) |
| Installations per tenant | | 5 | 5 |
| Free trial | | Per tenant, no card | Through the Pro trial |

## Free trial, no card needed

When tenant trials are enabled, connecting a new tenant starts its Pro trial automatically, with no card and no email needed. The License page shows the end date and days remaining from the server. An existing Community tenant can choose **Try Pro free**. Each tenant can use one trial within the service's retention period. Another installation joins the running trial at its existing end date.

In the last five days, or up to fourteen days after expiry, choose **Need more time? Extend your trial** on the License page. This extension is available once per tenant. After expiry, the extension starts from the time you request it.

The app reminds you five days and one day before the end, with the changes that apply to your setup. Afterwards, one tenant continues on Community Free. Backups and settings are kept, and Community keeps thirty days of backup history. Saved daily schedules run weekly, Azure backups pause, and paid automation pauses. With several trial tenants, you choose which continues on Community and can defer that choice. See [When paid coverage ends](#when-paid-coverage-ends).

You can optionally submit an email address on the trial card or License page for setup tips and a reminder. The address is sent only when you press the button. Change or remove it in the app during the trial, or use the unsubscribe link in each email at any time. See the [privacy policy](https://www.tenuvault.com/privacy).

When tenant trials are unavailable, the existing email form remains available. It emails a thirty-day trial key. Existing email trial keys retain their original end dates and reminders.

## Buy a plan

Click **Buy now** on [tenuvault.com/pricing](https://tenuvault.com/pricing) or on the **License** page. The checkout asks for payment right away, monthly or yearly, and your license key arrives by email after checkout. Payments are not refundable, so start with the free trial if you want to evaluate first.

Use an email address at checkout that should own billing and keep the key, such as a shared IT or finance mailbox. The key, the invoices and the customer portal belong to that address, and the customer portal is where you see the full key again if it is lost (the app shows only its last four characters). Who enters the key does not matter: it is tied to the Microsoft tenant signed in to TenuVault, so a different admin can activate it.

If your organization buys through procurement, yearly Pro and MSP plans are also available by quote, purchase order and invoice. Email [support@tenuvault.com](mailto:support@tenuvault.com) for a PDF quote; after your order you receive an invoice from Ugurlabs UG, payable by bank transfer.

Eligible nonprofits can use Pro at no cost. Email [support@tenuvault.com](mailto:support@tenuvault.com) to request it.

## Features by plan

| Feature | Community | Pro | MSP |
| --- | --- | --- | --- |
| Manual backups | Yes | Yes | Yes |
| Weekly scheduled backups | Yes | Yes | Yes |
| Daily scheduled backups | | Yes | Yes |
| [Backup Reader](/backups/backup-reader/): scheduled backups that keep running when sign-in frequency ends your session | | Yes | Yes |
| [Cloud backups](/backups/cloud/): scheduled backups that run in your own Azure Automation account | | Yes | Yes |
| Backups encrypted on this device | Yes | Yes | Yes |
| Backups in your own Azure storage account | | Yes | Yes |
| Backup history | Up to 30 days | 7 days to 365 days, or forever | 7 days to 365 days, or forever |
| Compare backups and detect drift | Yes | Yes | Yes |
| Restore one item as a copy | Yes | Yes | Yes |
| Restore several items at once | | Yes | Yes |
| Replace items in place | | Yes | Yes |
| Restore assignments | | Yes | Yes |
| One click revert of drifted policies | | Yes | Yes |
| Audit log: view, search, export (JSON, CSV) and remove entries older than 90 days | | Yes | Yes |
| OpenIntuneBaseline: New Deployment, Existing Deployment comparison and Policy Validation for Windows, macOS, Windows 365 and BYOD | Yes | Yes | Yes |
| OpenIntuneBaseline: deploy new policies, with undo | Yes | Yes | Yes |
| OpenIntuneBaseline: update outdated policies in place and **Fix drift** | | Yes | Yes |
| OpenIntuneBaseline: **Customize** your own baseline under My baselines | | Yes | Yes |
| Native framework comparisons | Yes | Yes | Yes |
| Framework PDF reports and CSV or JSON exports (except CIS Benchmarks) | Yes | Yes | Yes |
| Administrator-imported Microsoft, STIG and Custom comparisons | Yes | Yes | Yes |
| [CIS Benchmarks](/baselines/cis-benchmarks/) assessments, remediation, PDF reports and CSV or JSON exports | | Yes | Yes |
| Dashboard baseline scores | | Yes | Yes |
| Policy conflict and hygiene explorer | | Yes | Yes |
| Baseline upgrades that keep your customizations | | Yes | Yes |
| Dev to Prod settings promotion | | Yes | Yes |
| [Sync](/sync/) settings to other tenants | | Yes (the two tenants of your license) | Yes |
| Scheduled health review and notifications | | Yes | Yes |
| [Change reports](/reports/): what changed and who changed it, as PDF, Markdown or JSON, and by email after every scheduled backup | | Yes | Yes |
| Organization baseline customizations | | Yes | Yes |
| Custom baselines from OpenIntuneBaseline or a tenant snapshot | | Yes | Yes |
| Full white-label PDF reports | | Yes | Yes |
| Reusable golden standards for customers | | | Yes |
| Portfolio views across customer tenants | | | Yes |
| Share the license with other admins in your tenant | | Yes, on by default | Yes, off by default |
| **Check all** for drift across tenants (the [All tenants overview](/tenants/#the-all-tenants-overview) itself appears on any plan once two tenants are connected) | | | Yes |
| Actions across several tenants: **Backup Selected**, **Copy to other tenants instead** when restoring, **Also deploy to** in OpenIntuneBaseline | | | Yes |

:::note[Included in 0.2.0]
Community includes New Deployment, Existing Deployment comparison, Policy Validation and deployment of new policies for every OpenIntuneBaseline platform, and framework PDF, CSV and JSON reports for every framework except CIS Benchmarks. Audit-log access requires Pro or MSP. After a plan ends, saved CIS Benchmarks assessments stay readable and applied CIS deployments can still be rolled back; new CIS assessments, deployments and exports need Pro or MSP. CIS Controls is not available yet on any plan.
:::

TenuVault enforces these limits in the app itself, not just in the interface. When you try a feature your plan does not include, the app shows which plan includes it, for example: "Replacing items in place: included in TenuVault Pro and MSP. Upgrade on the License page." Features that need a higher plan are marked with a plan badge in the app. The badges in the sidebar follow the plan of the selected tenant once you are signed in to it. With no tenant selected, or a selected tenant you are not signed in to, they follow the license key on this computer, or Community without one. While a plan is still being checked, for example right after you sign in, no badge shows.

Actions across several tenants need the MSP plan on every tenant they touch.

## What Pro adds

Pro covers two tenants and includes daily scheduled backups, the optional [Backup Reader](/backups/backup-reader/) for scheduled backups under strict Conditional Access, custom backup history, your own Azure storage, restoring several items at once, replacing items in place, restoring assignments, reverting drifted policies and the audit log. It also includes dashboard baseline scores, the policy conflict and hygiene explorer, baseline upgrades that keep your customizations, Dev to Prod settings promotion, [Sync](/sync/) between the two tenants of your license, scheduled health reviews, organization customizations, custom baselines and full white-label PDF reports with your logo and colors. It includes [CIS Benchmarks](/baselines/cis-benchmarks/): assessments, remediation and reports against benchmark packs delivered to licensed installations. Community keeps its existing backup, restore, drift, OpenIntuneBaseline and non-CIS framework features.

## How tenants are counted

* **Community** covers the first tenant you use on a machine without a license. If you remove that tenant from TenuVault, the free plan is available for another tenant.
* **Pro and MSP** count tenants across every machine that uses the same license key. A tenant counts from the first time it is activated, and removing it from TenuVault frees its place on the license.
* **Installations:** each tenant can be active on up to 5 installations of TenuVault at the same time. Deactivate an installation you no longer use to free its place.

If you lower the number of tenants on an MSP subscription, the tenants that were activated first stay licensed.

## If a license ends

When a subscription ends or a license is revoked, the licensing service refuses the next check. An affected tenant can continue on Community if the free plan is available on that machine. When several connected tenants lack coverage and no Community tenant has been chosen, backups pause until the admin chooses which tenant continues on the free plan. You can decide later or add a license instead. Your backups are kept.

If the licensing service is only unreachable, nothing changes: active tenants keep their plan offline for up to 14 days after their last successful check.

## Organization licenses

A license key holder can share the license with the other admins of a tenant. Those admins then need no key: when they sign in to the tenant through the same app registration, TenuVault licenses them automatically and the **License** page shows **Active through your organization**. The key never reaches their machines.

See [Activate and manage your license](/licensing/manage/) for how to turn sharing on or off.

## Related pages

* [Activate and manage your license](/licensing/manage/)
* [Start TenuVault for the first time](/getting-started/first-launch/)
* [Network connections and data flows](/security/data-flows/)

## When paid coverage ends

A saved daily schedule runs weekly on Community at its saved time. The weekday comes from the first slot after coverage ended. The daily schedule stays saved and resumes daily when Pro returns. You can pause and resume the saved schedule on Community. You can also change its saved time. Creating a daily schedule or changing a weekly schedule to daily needs Pro. TenuVault checks for renewed coverage in the background, including while the app is in the tray.

Azure storage schedules pause with **Paused: Azure storage needs Pro**. Choose **Switch to weekly local backups** and confirm to save future backups on this computer. Your saved schedule stays unchanged. If backups were missed while paused, the most recent due slot is caught up under the normal retry rules. Missed weeks are not queued as separate backups. The Azure account settings are kept on this computer across restarts. Choose **Switch back to saved Azure storage**, or select the saved account in **Change storage**, to list or restore existing Azure backups. On Community, new backups pause again while Azure is selected. With Pro, Azure backups resume. Community cannot set up a new Azure account. Tenant profile edits stay on this computer while Azure storage needs Pro.

An operating system notification announces the weekly fallback or a paused Azure schedule once. A pending Community choice also sends a notification asking you to open TenuVault and choose a tenant to resume backups.

Configured alerts, scheduled health reviews and automatic change reports pause on Community. Their pages say **Paused on Community** and link to License. Their configuration stays saved.

After coverage is known to have ended, if more than one connected tenant lacks coverage and Community has no tenant yet, choose which tenant continues on Community. Backups pause while the choice is pending. Tenants whose coverage cannot be checked are shown but cannot be chosen yet. Use **Retry** in the picker to check them again.

The Community choice is final. Other tenants stay locked, and their backups are kept. Add a license to use them again. Fresh installations without coverage history still assign Community to the first tenant used.

You can close the picker with **Decide later** without choosing. A notice and **Choose tenant** buttons let you return during the same session. The picker opens again after restarting the app. **Add a license instead** opens License so you can buy Pro or enter a key.
