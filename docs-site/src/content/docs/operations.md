---
title: "Operations"
description: Run the scheduled health review of stale backups, work through its findings, and set up opt-in notifications.
---

The **Operations** hub holds one screen for the tenant selected in the tenant switcher: **Health review**. A health review checks whether the tenant's backups are fresh enough and records findings when they are stale, missing, or cannot be read. It also turns work signals stored by the other hubs into findings, as described below. Reviews can run on a schedule and can notify endpoints you configure.

Open **Operations** in the sidebar. Without a connected tenant the page says "Connect or select a tenant to use operations." and the review does not run.

## What your plan includes

| Screen | Community | Pro | MSP |
| --- | --- | --- | --- |
| Health review | No | Yes | Yes |
| Customer triage across tenants | No | No | Yes |

On a plan that does not include the health review, the screen shows a locked preview that describes what it does, with **See plans**, and any stored review results stay readable read only. See [Plans and features](/licensing/).

## What a review checks

A review reads the tenant's stored backup listing and checks the age of the latest complete backup:

* Healthy below 24 hours, and critical after 48 hours. The page shows these thresholds under **Schedule**.
* A tenant with no complete backup gets a finding, and recent failed or incomplete backups are named in its reason.
* When backups cannot be read, for example while you are signed out, the finding is marked **Unknown evidence** with the reason. Unknown is never shown as passing.

A review also checks work signals stored by the other hubs. Each signal becomes a finding with its own severity:

* Pending baseline upgrades, including an upgrade that is available, an upgrade with unresolved conflicts, an unfinished upgrade, and an install whose source is unknown.
* Deviations from adopted golden standards, a pending standard upgrade, a stale or missing deviation assessment, and an unfinished adoption.
* Open conflicts and hygiene findings.
* Baseline scores whose saved comparison is older than 30 days.

Work signals come from records already stored on this computer, and a signal family appears only when the tenant plan includes that screen. The review does not read policy content live to build them. A signal that is stale or was never collected stays **Unknown**, never passing, and when a stored record cannot be read the review records **Work signals unknown**, names the source it could not read, links to that screen, and leaves earlier signal findings unchanged.

Each review records its outcome and summary. Findings stay stored between reviews: a finding resolves when a later review reads fresh evidence, and reopens when the problem returns.

## Run a review now

1. Select the tenant in the tenant switcher.
2. Open **Operations** in the sidebar.
3. In **Schedule**, click **Review now**. While it runs the button shows "Reviewing".

The tiles at the top then show **Last review** with its outcome, **Scheduling readiness**, and **Open findings** with the counts per severity, including how many rest on unknown evidence. A first review that runs late after missed windows is marked as a catch-up and names how many windows were missed.

## Schedule reviews

1. Tick **Review on a schedule**.
2. Choose the interval in **Every**: 6 hours, 12 hours, 24 hours, 48 hours, or 7 days.

The readiness tile shows whether scheduling is **Ready**, **Off**, **Sign-in required** or **Not licensed**, with the reason and the next due time. Reviews run only while TenuVault runs; the last review time is always shown, so a review that could not run is visible instead of silent.

## Work through findings

The **Findings** list shows each open finding with its severity, title, reason, and when it was first seen, last checked, and when its evidence was read. **Open** after the reason goes to the screen the finding comes from. When no finding is open, the list says whether no review has run yet, or names the time of the latest review and whether it completed or could only read part of the evidence. Click **Export CSV** or **Export JSON** above the list to save the findings currently shown, including resolved findings only while they are shown.

1. To hand a finding to someone, type their name in **Owner** and click **Save owner**.
2. To record that a finding is being handled, click **Acknowledge**. Acknowledged findings carry the admin who acknowledged them.
3. Click **Show** followed by the number of resolved findings to include resolved findings in the list, and the same button again, now **Hide resolved**, to hide them. A resolved finding names the fresh evidence time that resolved it.

## Notifications

Notifications are off until you add an endpoint. They are sent only for new findings, once per finding until it resolves and reopens. A notification never contains tokens, credentials, policy content, finding titles or owners.

### Notify on this computer

1. In **Notifications**, click **Notify on this computer**.
2. Use **Turn off** and **Turn on** on the endpoint to pause or resume it, and **Remove** to delete it.

Local notifications show only counts on this computer.

### Add a webhook

1. In **Notifications**, click **Add webhook**.
2. Enter a **Name** and the **https URL** of an endpoint you control, for example your ticketing or chat system.
3. Optionally enter a **Secret header name (optional)** and its **Secret header value**. The value is stored encrypted on this computer and is never shown again after saving.
4. Choose the **Minimum severity**, and tick **Include the tenant display name** or **Include tenant and record IDs (otherwise replaced by short references)** only when you want that detail in the payload.
5. Click **Preview payload** to see exactly the JSON body a webhook receives, built from the current findings, before you save.
6. Click **Add webhook**.

For each endpoint you can set its **Minimum severity**, click **Send test** to check delivery, **Turn off** or **Turn on**, and **Remove**. Webhook endpoints also offer **Include tenant name** and **Include tenant and record IDs**, and **Preview payload** to see what would be sent. The endpoint lists its last delivery, including failures with the number of attempts.

## Customer triage (MSP)

With MSP, **Customer triage** shows the stored health review status of each licensed customer tenant, with the owners of open findings.

1. Click **Load customers**, or **Refresh** after the first load.
2. Read each customer's last review, outcome, open findings, schedule and owners in the table.

A tenant that was never reviewed is shown as unknown. Tenants without an MSP license or without sign-in are listed as not included.

## Limits

* The review checks backup freshness and stored work signals. It does not check policy content live.
* Scheduled reviews run only while TenuVault runs. Missed windows run as one catch-up review and are marked as such.
* Notifications go only to endpoints you configure, and only for new findings. Nothing is sent to a TenuVault server.
