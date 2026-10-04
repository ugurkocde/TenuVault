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
| Free trial | | 30 days | 30 days |

To start a trial or buy a plan, go to [tenuvault.com/desktop#pricing](https://tenuvault.com/desktop#pricing), or click **Try Pro or MSP free for 30 days** on the welcome screen or **Start 30 day free trial** on the **License** page. Your license key arrives by email right after checkout, and you are not charged until the trial ends.

## Features by plan

| Feature | Community | Pro | MSP |
| --- | --- | --- | --- |
| Manual backups | Yes | Yes | Yes |
| Weekly scheduled backups | Yes | Yes | Yes |
| Daily scheduled backups | | Yes | Yes |
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
| Native non-CIS framework comparisons | Yes | Yes | Yes |
| Framework PDF reports and CSV or JSON exports (except CIS) | Yes | Yes | Yes |
| Administrator-imported Microsoft, STIG and Custom comparisons | Yes | Yes | Yes |
| CIS comparisons and their reports (coming soon) | No | Yes | Yes |
| Share the license with other admins in your tenant | | Yes, on by default | Yes, off by default |
| Cross tenant dashboard, including **Check all** for drift | | | Yes |
| Actions across several tenants: **Backup Selected**, **Copy to other tenants instead** when restoring, **Also deploy to** in OpenIntuneBaseline | | | Yes |

:::note[Included in 0.2.0]
Community includes New Deployment, Existing Deployment comparison, Policy Validation and deployment of new policies for every OpenIntuneBaseline platform, and framework PDF, CSV and JSON reports for every framework except CIS. Audit-log access requires Pro or MSP. CIS remains unavailable on every plan while its commercial-use agreement is pending.
:::

TenuVault enforces these limits in the app itself, not just in the interface. When you try a feature your plan does not include, the app shows which plan includes it, for example: "Replacing items in place: included in TenuVault Pro and MSP. Upgrade on the License page." Features that need a higher plan are marked with a plan badge in the app.

Actions across several tenants need the MSP plan on every tenant they touch.

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
