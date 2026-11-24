---
title: "Run your first backup"
description: Take your first backup, read its results and confirm it worked.
---

The last setup step takes a first backup, so you know sign-in, permissions and storage all work before you rely on TenuVault.

## Run it from the guided setup

Select **Start first backup** on **Where should backups go?**. The backup starts automatically and the progress bar shows what TenuVault is saving. Select **Cancel backup** to stop it.

When **Your first backup is done** appears, you can review the counts and duration, expand **See backup details**, or set up the options below. Select **Go to dashboard** when you are ready to leave setup. The diagnostics question below the card is optional. On the Dashboard, **Turn on daily backups** (or **Set up automatic backups** on Community) opens Schedule, and **View backup** opens the saved backup. The first-backup card stays until you dismiss it or a second backup succeeds.

<figure class="docs-screenshot">
  <a href="/images/screenshots/setup-first-backup.webp" aria-label="Open the first backup screenshot">
    <img src="/images/screenshots/setup-first-backup.webp" alt="First backup completion card with counts, duration and a Go to dashboard button" width="1440" height="900" loading="lazy" decoding="async" />
  </a>
  <figcaption>Review the backup and choose when to open the dashboard.</figcaption>
</figure>

The first backup uses the default scope, **Everything except apps**: policies, scripts, updates, enrollment and tenant settings. To include apps, run a manual backup with **Everything** from **Backup & Restore**, described below. See [What gets backed up](/backups/coverage/).

To do it later, select **Skip for now**. TenuVault opens the dashboard, and you can run the backup from **Backup & Restore** at any time.

If the first backup fails or you cancel it, select **Try again** to run it again, or **Go to Backup & Restore** to continue there. Under a first backup that failed or could not start, **Stuck here? Book a free setup call** opens the [free setup call](/getting-started/#free-setup-call) page in your browser. A backup you cancelled does not show it.

### Next steps

After a successful first backup, the step offers two things:

* **Turn on weekly backups** schedules backups on Sundays at 02:00 on Community. **Turn on daily backups** schedules backups at 02:00 on Pro and MSP. TenuVault backs up while it is open or in the tray. A backup missed while the computer was off runs the next time TenuVault starts. Change the day and time later in **Backup & Restore**, **Schedule**. See [Schedule backups](/backups/schedules/).
* **Save your recovery key**, for backups on this device, if you have not saved it yet. Keep the file somewhere safe, such as your password manager. Without the recovery key, backups on this device cannot be read after a reinstall or on another computer. See [Save your recovery key](/getting-started/choose-storage/#save-your-recovery-key). For a tenant with Azure storage this step is left out, because Azure backups do not need the key.

When a schedule is already on or the key is already saved, the step says so instead.

## Run it from Backup & Restore

1. Open **Backup & Restore** and select the tenant.
2. Select **Run Backup**.
3. In **Back up &lt;tenant&gt;**, choose what to back up:
   * **Everything except apps**
   * **Everything**: also app details and assignments. Installer files are never included.
   * **Custom**: choose areas and individual types.
4. Optional: select **Also use this for automatic backups of &lt;tenant&gt;** to save this choice for scheduled backups.
5. Select **Start backup**.

For more on manual backups, see [Run a backup](/backups/).

<figure class="docs-screenshot">
  <a href="/images/screenshots/backup-scope.webp" aria-label="Open full-size screenshot: backup scope">
    <img src="/images/screenshots/backup-scope.webp" alt="Run Backup opens the scope picker before anything starts" width="1632" height="708" loading="lazy" decoding="async" />
  </a>
  <figcaption>Run Backup opens the scope picker before anything starts. Example tenant data. Select the image to view it full size.</figcaption>
</figure>

## Read the result

| Result | Meaning |
| --- | --- |
| **Backup completed successfully** | Every object in scope was saved. |
| **Backup completed with &lt;n&gt; warnings** | Most objects were saved, but some could not be read. **Details** lists the affected types and reasons. Older backups are kept because this backup is incomplete. |
| **Backup failed: no policies could be saved** | Nothing was saved. Open **Details** on the result or check the raw log for the first error. |
| **Backup failed: nothing could be read** | Every selected type was left out, for example for a missing permission or a product the tenant has no license for. The error names the main cause, and **Details** lists the reason per type. |

Below the result, TenuVault shows:

* **Policies saved**, **Types backed up** and **Duration**, plus inventory such as Autopilot devices, which is counted apart from policies
* Separate counts for missing access, read failures and save failures. **Details** groups affected types by service.
* every type that was backed up, with the number of objects saved
* **&lt;n&gt; types had nothing to back up**, which you can expand to see the types your tenant has none of
* **Show raw log**, the full technical log with **Copy log**, for support

The raw log ends with a summary such as **Backup completed: 214 policies in 1m 12s.** and shows times in your local time zone.

After a successful manual backup on Community, a line beside the completion result appears once per machine and describes backups in your own Azure storage account, which every admin with access sees, and longer retention, included in TenuVault Pro and MSP.

## Common problems on the first backup

| Message | Fix |
| --- | --- |
| **Skipped &lt;type&gt;: access was denied. The app registration may lack the permission or admin consent, or your Intune role may not allow it.** | Your app registration is missing a permission TenuVault uses or its admin consent, or your Intune role does not cover this type. Open the app registration in Microsoft Entra, go to **API permissions** and select **Grant admin consent for &lt;your tenant&gt;**, or run the setup script again. Then sign out of the tenant in TenuVault and sign in again. If every permission already shows **Granted**, check that your Intune role covers these items. See [Create the app registration manually](/getting-started/app-registration/#3-add-the-delegated-permissions). |
| **Could not read &lt;type&gt;** | **Details** shows the error Microsoft Graph returned. If it is an access error, check that your Intune role includes this type. |
| A banner asks you to sign in again | Your Microsoft session ended. Select **Sign in** in the banner, then run the backup again. |
| **You do not have write access to storage account &lt;name&gt; ...** | See [Storage errors](/getting-started/choose-storage/#storage-errors). |

## You are done

TenuVault is set up. Next:

* [Schedule backups](/backups/schedules/), if you did not turn on automatic backups in **Next steps**. Community tenants can back up weekly; Pro and MSP can also back up daily.
* Keep TenuVault running in the menu bar on macOS or the tray on Windows so schedules run. See [Settings reference](/settings/#background-runner).
* Learn how to [restore supported configuration](/restore/) and [detect drift](/drift/).

Once you have a successful backup, [practice an Intune restore](https://www.tenuvault.com/guides/intune-restore-drill) before you need one in an incident.

## Related pages

* [Set up and schedule Microsoft Intune backups](https://www.tenuvault.com/guides/intune-backup-setup): the setup guide, on the product site

## Your chosen services

The first backup step names the services selected during setup. The first backup covers the selected areas for [Defender](/backups/defender/), [Entra ID](/backups/entra/) or [Intune](/backups/intune/). Conditional Access is included when its switch is on under Entra ID. The default scope leaves out Intune app details.
