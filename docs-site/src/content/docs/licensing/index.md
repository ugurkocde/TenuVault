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
| Free trial | | 30 days, no card | Through the Pro trial, or 30 days with a card |

## Free trial, no card needed

Enter your email address on the **License** page or the welcome screen in TenuVault, or at [tenuvault.com/trial](https://tenuvault.com/trial). A Pro license key for 30 days arrives by email, usually within a minute. You need no payment card, and nothing is charged when the trial ends: the trial key stops working and TenuVault continues on Community. Each email address gets one trial; asking again sends the same key again.

TenuVault reminds you in the app on day 20 and day 27 of the trial, with a **Buy Pro** button that opens the checkout. Unless you have bought a plan, you also get an email 5 days and 1 day before the trial ends, with a link to buy and a link to stop these emails. To keep Pro or move to MSP, buy a plan and enter the new key on the **License** page; see [Activate and manage your license](/licensing/manage/#after-your-trial).

The trial covers two tenants, like Pro. To evaluate MSP with more tenants, the MSP checkout on [tenuvault.com/pricing](https://tenuvault.com/pricing) also offers a 30 day subscription trial that needs a card, or email [support@tenuvault.com](mailto:support@tenuvault.com).

## Buy a plan

Click **Buy now** on [tenuvault.com/pricing](https://tenuvault.com/pricing) or on the **License** page. The checkout asks for payment right away, monthly or yearly, and your license key arrives by email after checkout. Payments are not refundable, so start with the free trial if you want to evaluate first.

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
| Scheduled health review and notifications | | Yes | Yes |
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

Pro covers two tenants and includes daily scheduled backups, the optional [Backup Reader](/backups/backup-reader/) for scheduled backups under strict Conditional Access, custom backup history, your own Azure storage, restoring several items at once, replacing items in place, restoring assignments, reverting drifted policies and the audit log. It also includes dashboard baseline scores, the policy conflict and hygiene explorer, baseline upgrades that keep your customizations, Dev to Prod settings promotion, scheduled health reviews, organization customizations, custom baselines and full white-label PDF reports with your logo and colors. It includes [CIS Benchmarks](/baselines/cis-benchmarks/): assessments, remediation and reports against benchmark packs delivered to licensed installations. Community keeps its existing backup, restore, drift, OpenIntuneBaseline and non-CIS framework features.

## How tenants are counted

* **Community** covers the first tenant you use on a machine without a license. If you remove that tenant from TenuVault, the free plan is available for another tenant.
* **Pro and MSP** count tenants across every machine that uses the same license key. A tenant counts from the first time it is activated, and removing it from TenuVault frees its place on the license.
* **Installations:** each tenant can be active on up to 5 installations of TenuVault at the same time. Deactivate an installation you no longer use to free its place.

If you lower the number of tenants on an MSP subscription, the tenants that were activated first stay licensed.

## If a license ends

When a subscription ends or a license is revoked, the licensing service refuses the next check and the affected tenant falls back to Community, provided no other tenant on that machine already uses the free plan. Your backups remain available.

If the licensing service is only unreachable, nothing changes: active tenants keep their plan offline for up to 14 days after their last successful check.

## Organization licenses

A license key holder can share the license with the other admins of a tenant. Those admins then need no key: when they sign in to the tenant through the same app registration, TenuVault licenses them automatically and the **License** page shows **Active through your organization**. The key never reaches their machines.

See [Activate and manage your license](/licensing/manage/) for how to turn sharing on or off.

## Related pages

* [Activate and manage your license](/licensing/manage/)
* [Choose a plan on first launch](/getting-started/first-launch/)
* [Network connections and data flows](/security/data-flows/)
