---
title: "Run your first backup"
description: Take your first backup, read the progress log and confirm it worked.
---

The last setup step takes a first backup, so you know sign-in, permissions and storage all work before you rely on TenuVault.

## Run it from the guided setup

On the **First backup** step, TenuVault shows **Your tenant is connected.**

1. Select **Run first backup**.
2. Watch the progress bar and the log. TenuVault first lists every Intune type (**Reading Intune configuration...**), then saves each object (**Backing up &lt;type&gt;**).
3. When the backup ends, select **Go to Backup & Restore** to see it.

The first backup uses the default scope, **Everything except apps**: policies, scripts, updates, enrollment and tenant settings. To include apps, run a manual backup with **Everything** from **Backup & Restore**, described below. See [What gets backed up](/backups/coverage/).

To do it later, select **Skip for now**. TenuVault opens **Tenants**, and you can run the backup from **Backup & Restore** at any time.

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

* [Schedule backups](/backups/schedules/). Community tenants can back up weekly; Pro and MSP can also back up daily.
* Keep TenuVault running in the tray so schedules run. See [Settings reference](/settings/#background-and-retention).
* Learn how to [restore items](/restore/) and [detect drift](/drift/).
