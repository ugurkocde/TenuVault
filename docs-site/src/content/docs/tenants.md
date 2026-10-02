---
title: "Manage tenants"
description: Add, switch, monitor, rename, tag and remove the Intune tenants TenuVault works with.
---

A tenant in TenuVault is one Microsoft Intune tenant you have signed in to, together with the place its backups are stored. This page covers how you add tenants, switch between them, read the dashboards and remove a tenant you no longer need.

## Where you work with tenants

| Place | How to open it | What it is for |
| --- | --- | --- |
| Tenant switcher | Top of the sidebar | Choose the tenant every page works on |
| **Dashboard** | Sidebar | Backup overview of the selected tenant |
| **All tenants** | Sidebar, when two or more tenants are connected | Status of every connected tenant at a glance |
| **Tenants** | Sidebar | The **Tenant Management** page: rename, tag, refresh, back up and remove tenants |
| **Settings** | Sidebar | Sign in again and change where a tenant's backups are stored |
| **License** | Sidebar | License state of each tenant and license sharing |

## Switch between tenants

The Dashboard, Backup & Restore, Drift Detection and Audit Log pages work on one tenant at a time: the tenant selected in the switcher at the top of the sidebar.

1. Click the tenant switcher. It shows the selected tenant's name and domain.
2. Under **Tenants**, select the tenant you want. A check mark shows the current one.

The switcher marks tenants your license does not cover right now with a warning icon, and shows **Not licensed** under the selected tenant's name when it applies. The menu also has **All tenants** (when two or more tenants are connected) and **Connect a tenant**.

The **Backup & Restore** page has its own **Select tenant** list. Choosing a tenant there changes the same selection.

## Add a tenant

You can add a tenant in two ways. Both need the tenant ID or domain and the application (client) ID of the app registration you created in that tenant. See [Create the app registration](/getting-started/app-registration/) if you have not created one yet.

### With the setup wizard

Choose **Connect a tenant** in the tenant switcher or on the **All tenants** page. The wizard walks you through signing in, choosing storage and running a first backup. See [Sign in to your tenant](/getting-started/connect-tenant/).

### From the Tenants page

1. Open **Tenants** and click **Connect tenant**. The **Connect a tenant** dialog opens.
2. If you still need an app registration, expand **First time? Create an app registration** for the setup script.
3. Enter:
   * **Tenant id or domain**, for example `contoso.onmicrosoft.com`
   * **Application (client) id**, the GUID of your app registration
   * **Display name (optional)**, a name you want to see in TenuVault
4. Click **Sign in with Microsoft** and complete the sign-in in your browser.
5. After you are signed in, the dialog asks **Where should backups be stored?** Choose **This device, encrypted** or **Your Azure storage account, encrypted**. See [Choose where backups are stored](/getting-started/choose-storage/).
6. Click **Connect tenant**.

TenuVault checks the license when you sign in and again before it saves the tenant. If your license does not cover the tenant, the tenant is not added, the new sign-in is removed and the dialog shows the reason, starting with "The tenant was not added."

After the tenant is added, TenuVault reads its organization name, primary domain and policy counts from Microsoft Graph. If you connected the same tenant before with the same storage location, the custom name and tags you gave it are restored from that storage.

:::note
When no tenant is connected, the Dashboard shows **Protect your Intune policies** with two buttons: **Connect tenant** opens the dialog above and **Guided setup** opens the setup wizard.
:::

## The tenant dashboard

The **Dashboard** shows the backup state of the tenant selected in the switcher. Its header shows the tenant name and "Backup overview for" the tenant's domain.

Use the **Reporting period** list to choose **Last 24 hours**, **Last 7 days** (the default) or **Last 30 days**. The period applies to **Success Rate** and **Backup Status**. The dashboard reloads every 30 seconds; the refresh button reloads it right away, and **Last updated** shows when it last did.

| Tile | What it shows |
| --- | --- |
| **Last backup** | How long ago the newest backup ran, its date and item count, and its state: **Running**, **Completed**, **Completed with warnings**, **Incomplete**, **Failed** or **Status unknown**. Also shows **Tenant Health** (see below), the number of backups stored, and the buttons **Run Backup** (or **Sign in** when you are not signed in) and **Restore policies**. |
| **Success Rate** | Successful backups as a share of finished backups in the period, against a 95% target. Backups completed with warnings, incomplete backups and failed backups count as not successful. Shows **No data** when no backup finished in the period. |
| **Next Backup** | Time until the next automatic backup, the schedule and the result of the last automatic backup. **Set up automatic backups** or **Edit schedule** opens the schedule. See [Schedule backups](/backups/schedules/). |
| **Policies protected** | The number of items in the newest complete backup, with a breakdown for settings catalog, device configurations, compliance policies and app protection policies. |
| **Backup Status** | Successful backups in the period, plus counts for **Failed**, **Running** and **Scheduled**. |
| **Drift** | When backups of this tenant were last compared, and whether the comparison worked. **Check drift** opens [Drift detection](/drift/). |
| **License** | **Licensed**, **Free plan**, **Not licensed** or **Not checked**, the plan name and how the tenant is licensed. **Manage license** or **Check license** opens the License page. |
| **Storage** | **This device** or the Azure storage account name, and the account you are **Signed in as**. |
| **Recent Activity** | The five newest events for the tenant from backups and the audit log. **View All Activity** opens the [Audit log](/audit-log/). |
| **Quick Actions** | Shortcuts to **Run Backup**, **Restore policies**, **Connect tenant** and **Settings**. |

**Tenant Health** is based on the newest complete, successful backup:

| Health | When |
| --- | --- |
| **Healthy** | The newest complete backup is less than 24 hours old |
| **Warning** | The newest complete backup is 24 to 48 hours old, there is no complete backup and none failed, or the backups cannot be read |
| **Critical** | The newest complete backup is more than 48 hours old, or there is no complete backup and at least one backup failed or was incomplete |

:::note
The Drift tile and the audit part of Recent Activity come from the audit log. The audit log is part of Pro and MSP, so on Community these show only backup activity.
:::

## The All tenants overview

When two or more tenants are connected, the sidebar shows **All tenants** at the top, and TenuVault opens on this page when it starts.

The top row counts **Tenants connected**, **Signed in**, **Licensed** and **Automatic backups on**. Below it, each tenant has a card with:

* **Signed in** or **Not signed in**
* **Account**: the admin signed in to the tenant
* **License**: how the tenant is licensed, **Community (free)**, **Not licensed**, or **License checked at first use** for a tenant whose license has not been checked yet
* **Storage**: where the tenant's backups go
* **Automatic backups**: the schedule and next run, or **No automatic backups**
* **Last backup**: the last automatic backup and whether it failed, or the last backup

The buttons on each card:

| Button | What it does |
| --- | --- |
| **Sign in** | Shown when no admin is signed in. Opens the sign-in settings for the tenant. |
| **Check license** | Shown when you are signed in but the tenant is not licensed. Opens the License page. |
| **Back up now** | Opens the backup dialog for the tenant. Available when you are signed in and the tenant is licensed. See [Run a backup](/backups/). |
| **Backups** | Selects the tenant and opens Backup & Restore |
| **Drift** | Selects the tenant and opens Drift Detection |

Click a tenant's name, or its arrow button, to select it and open its dashboard. **Connect a tenant** opens the setup wizard.

## The Tenant Management page

Open **Tenants** in the sidebar. Use the search box to filter by name or domain, and the grid and list buttons to switch views.

In the grid view, each tenant card shows the tenant's initials, name, domain, tags, live counts of **Compliance Policies** and **Configuration Profiles** read from Intune, the **Backup storage**, when data was last refreshed (**Last sync**) and the next automatic backup. **Backup Now** opens the backup dialog.

The list view shows the same tenants as a table with the columns **Tenant**, **Status**, **Region**, **Policies**, **Tags**, **Last Backup**, **Plan**, **Drift** and **Actions**.

### Refresh a tenant's details

Click the refresh button on a tenant card, or choose **Refresh Data** in the actions menu of the list view. TenuVault reads the organization name, primary domain and policy counts from Microsoft Graph again. A name you set yourself is kept.

### Rename a tenant

1. Click the pencil next to the tenant's name, or choose **Edit Name** in the tenant's actions menu.
2. Type the new name and press Enter, or click the check mark. Press Escape to cancel.

The name is saved in TenuVault and in the tenant's backup storage, so it comes back if you connect the tenant again later.

### Tag tenants

Tags help you organize many tenants, for example by environment or compliance scope.

1. Choose **Manage Tags** in the tenant's actions menu.
2. In **Available Tags**, click tags to add or remove them. Click **Custom Tag** to type your own and click **Add**.
3. Use **Quick categories** to apply a set at once: **Production Setup**, **Non-Production**, **Compliance**, or **Clear All**.
4. Click **Save Tags**.

Like the name, tags are saved in the tenant's backup storage.

### Act on several tenants

Select tenants with **Select tenant** on each card, or with the check boxes in the list view. A bar shows how many are selected, with two actions:

* **Tag Selected** sets the tags you choose on every selected tenant, replacing their current tags.
* **Backup Selected** backs up every selected tenant after you confirm. Each tenant uses its saved backup choice (see [Choose what to back up](/backups/#choose-what-to-back-up)). This needs the MSP plan.

In the list view, **Check all** in the **Drift** column compares each tenant's two newest backups and shows **No drift**, the number of changes and critical changes, **Not available** (hover for the reason) or **Not checked**. This needs the MSP plan. See [Drift detection](/drift/).

## Sign in again or change storage

Open **Settings** and go to the **Sign-in** section. The **Tenants** card lists every tenant with the signed-in account and its backup storage.

* **Sign in** or **Sign in again** renews the tenant's sign-in.
* **Change storage** chooses a new location for the tenant's future backups. See [Backup storage and retention](/backups/storage/#change-where-a-tenants-backups-go).

When a background request needs you to sign in again, for example after the session expired or Conditional Access asks for a new sign-in, a banner appears at the top of the window with a **Sign in** button. TenuVault never starts a sign-in without you asking.

On the Backup & Restore, Drift Detection and Audit Log pages, a notice tells you when the selected tenant is not signed in or not licensed, with **Open sign-in settings** and **Open license**.

## Remove a tenant

1. Open **Tenants**.
2. Open the tenant's actions menu and choose **Delete Tenant**.
3. Confirm the prompt.

Removing a tenant:

* signs you out of the tenant
* removes its automatic backup schedule
* frees its place on your license

Existing backups are kept in their storage location, and nothing in the tenant itself changes. To use the backups again, connect the tenant again with the same storage.

## Share your license with other admins

If a tenant is licensed with your license key, the **Tenants** card on the **License** page shows **Let other admins in this tenant use this license** for it. When it is on, anyone who signs in to that tenant with the same app registration is licensed automatically, and your key stays on your machine. If TenuVault asks you to, sign in to the tenant again so it can share the license. See [Activate and manage your license](/licensing/manage/).

## Plan requirements

| Action | Community | Pro | MSP |
| --- | --- | --- | --- |
| Connect tenants | 1 tenant | 2 tenants | Subscribed quantity |
| Dashboard, All tenants overview, rename, tags | Yes | Yes | Yes |
| **Backup Selected** across several tenants | No | No | Yes |
| **Check all** drift across tenants | No | No | Yes |

See [Plans and features](/licensing/) for the full comparison.
