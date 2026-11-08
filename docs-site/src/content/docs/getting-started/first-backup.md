---
title: "Run your first backup"
description: Take your first backup, read the progress log and confirm it worked.
---

The last setup step takes a first backup, so you know sign-in, permissions and storage all work before you rely on TenuVault.

## Run it from the guided setup

The **First backup** step is headed **Take a first backup** and shows **&lt;tenant&gt; is connected.** It explains what the backup does:

* It reads your Intune policies, scripts and settings, and changes nothing in your tenant.
* Apps are left out by default to keep it quick. You can change what is backed up later in the backup scope.
* It usually takes a few minutes, longer for large tenants.

1. Select **Run first backup**.
2. Watch the progress bar and the log. TenuVault first lists every Intune type (**Reading Intune configuration...**), then saves each object (**Backing up &lt;type&gt;**). Select **Cancel backup** to stop it.
3. When the backup succeeds, the step shows **Your first backup is done** and **Next steps**, described below.
4. Select **Go to dashboard**.

The first backup uses the default scope, **Everything except apps**: policies, scripts, updates, enrollment and tenant settings. To include apps, run a manual backup with **Everything** from **Backup & Restore**, described below. See [What gets backed up](/backups/coverage/).

To do it later, select **Skip for now**. TenuVault opens the dashboard, and you can run the backup from **Backup & Restore** at any time.

If the first backup fails or you cancel it, select **Try again** to run it again, or **Go to Backup & Restore** to continue there.

### Next steps

After a successful first backup, the step offers two things:

* **Turn on automatic backups.** One button turns on a schedule for this tenant: **Back up every Sunday at 02:00** on Community, or **Back up daily at 02:00** on Pro and MSP. TenuVault backs up while it is open or in the tray. A backup missed while the computer was off runs the next time TenuVault starts. Change the day and time later in **Backup & Restore**, **Schedule**. See [Schedule backups](/backups/schedules/).
* **Save your recovery key**, if you have not saved it yet. Select **Save recovery key** and keep the file somewhere safe, such as your password manager. Without the recovery key, your backups cannot be read after a reinstall or on another computer. See [Save your recovery key](/getting-started/choose-storage/#save-your-recovery-key).

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

## Read the result

| Result | Meaning |
| --- | --- |
| **Backup completed successfully** | Every object in scope was saved. |
| **Backup completed with &lt;n&gt; warnings** | Most objects were saved, but some could not be read. The log lists each one with the reason. Older backups are kept because this backup is incomplete. |
| **Backup failed: no policies could be saved** | Nothing was saved. Check the log for the first error. |

The log ends with a summary such as **Backup completed: 214 policies in 1m 12s.** Each type also gets a line such as **Found 12 &lt;type&gt;** and **Backed up 12 &lt;type&gt;**.

After a successful manual backup on Community, a line beside the completion result appears once per machine and describes encrypted copies in your own Azure storage account and longer retention, included in TenuVault Pro and MSP.

## Common problems on the first backup

| Log or error message | Fix |
| --- | --- |
| **Save your current backup recovery key in Settings before the first encrypted Azure backup.** | Open **Settings** > **Storage and recovery** and select **Save recovery key**, then run the backup again from **Backup & Restore**. See [Save your recovery key](/getting-started/choose-storage/#save-your-recovery-key). |
| **Skipped &lt;type&gt;: access was denied. The app registration may lack the permission or admin consent, or your Intune role may not allow it.** | Your app registration is missing a permission TenuVault uses or its admin consent, or your Intune role does not cover this type. Open the app registration in Microsoft Entra, go to **API permissions** and select **Grant admin consent for &lt;your tenant&gt;**, or run the setup script again. Then sign out of the tenant in TenuVault and sign in again. If every permission already shows **Granted**, check that your Intune role covers these items. See [Create the app registration manually](/getting-started/app-registration/#3-add-the-delegated-permissions). |
| **Could not read &lt;type&gt;: ...** | The log shows the error Microsoft Graph returned. If it is an access error, check that your Intune role includes this type. |
| A banner asks you to sign in again | Your Microsoft session ended. Select **Sign in** in the banner, then run the backup again. |
| **You do not have write access to storage account &lt;name&gt; ...** | See [Storage errors](/getting-started/choose-storage/#storage-errors). |

## You are done

TenuVault is set up. Next:

* [Schedule backups](/backups/schedules/), if you did not turn on automatic backups in **Next steps**. Community tenants can back up weekly; Pro and MSP can also back up daily.
* Keep TenuVault running in the menu bar on macOS or the tray on Windows so schedules run. See [Settings reference](/settings/#background-runner).
* Learn how to [restore Intune policies](/restore/) and [detect drift](/drift/).

Once you have a successful backup, [practice an Intune restore](https://www.tenuvault.com/guides/intune-restore-drill) before you need one in an incident.

## Related pages

* [Set up and schedule Microsoft Intune backups](https://www.tenuvault.com/guides/intune-backup-setup): the setup guide, on the product site
