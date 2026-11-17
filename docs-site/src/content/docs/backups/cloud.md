---
title: "Cloud backups in Azure"
description: Scheduled Intune backups that run in an Azure Automation runbook in your own subscription, with a managed identity, so no admin computer has to be on or signed in.
---

Scheduled backups normally run in the TenuVault app on an admin's computer. That computer has to be on, signed in, and still hold a valid Microsoft session. **Cloud backups** move the schedule into your own Azure subscription: a PowerShell runbook in an Azure Automation account reads Intune with a managed identity and writes the backup to the same storage account as your other backups. Nothing runs in a TenuVault tenant and no backup reaches a TenuVault server.

## Computer, Backup Reader or cloud: which runner when

|  | On this computer (your sign-in) | On this computer (Backup Reader) | In Azure (cloud backups) |
| --- | --- | --- | --- |
| Runs while the computer is off | No | No | Yes |
| Survives Conditional Access sign-in frequency | No | Yes | Yes |
| Identity that reads Intune | You, delegated | Read-only app registration, certificate on the computer | Automation managed identity, read-only app roles |
| Storage | This device or your Azure account | Same | Your Azure account only |
| Encrypted OMA-URI values | In plain text | In plain text; masked (`****`) if Microsoft refuses the read | Same as the Backup Reader |
| Deletes old backups (retention) | Yes | No, the next sign-in backup does | No, same |
| Extra moving parts | Tray and background launch | Yearly certificate renewal per computer | Automation account, failure alert |
| Plans | All (weekly on Community) | Pro and MSP | Pro and MSP |

Use cloud backups when several admins share one tenant's backups, when no computer is reliably on at backup time, or when sign-in frequency would otherwise need an exception. Keep computer backups when try-out local backups are enough. Both runners can be on at once; each makes its own backups into the same storage.

## What gets created

Setup creates or reuses, in your subscription:

| Resource | Purpose |
| --- | --- |
| Resource group `rg-tenuvault-backups` | Holds the cloud backup resources. Reuse the storage account's group. |
| Automation account `aa-tenuvault` with a system assigned managed identity | Runs the runbook. One account serves one Entra tenant: a managed identity belongs to its own tenant and cannot read Intune in another, so an MSP sets up an account in each customer tenant's subscription. |
| Runbook `Invoke-TenuVaultBackup` (PowerShell 7.2) | Reads Intune and writes one backup per run, in the desktop backup format. 7.2 is required: the default 5.1 runtime lacks the .NET JSON parser the runbook uses. |
| Automation variables with a per-tenant suffix | Tenant id, storage account, scope. No secrets in variables. Set `TenuVaultIncludeConditionalAccess` to `true` (and grant the managed identity `Policy.Read.All`) to include [Conditional Access](/backups/conditional-access/). |
| Custom role **TenuVault Backup Writer** on the `intune-backups` container | Read and write blobs, no delete. The runbook cannot remove backups. |
| Schedule `TenuVaultBackup-<tenant>` and its runbook link | Daily or weekly, in the timezone you choose. |
| Optional Azure Monitor action group and metric alert | Emails you when Automation jobs fail. Setup refuses to finish without an explicit choice. |

Microsoft Graph application roles are the one part Azure role assignments and ARM templates cannot grant. A Global Administrator assigns the read-only roles below to the managed identity. They are the same set as the [Backup Reader](/backups/backup-reader/#permissions):

`DeviceManagementConfiguration.Read.All`, `DeviceManagementApps.Read.All`, `DeviceManagementServiceConfig.Read.All`, `DeviceManagementScripts.Read.All`, `DeviceManagementRBAC.Read.All`, and optionally `DeviceManagementManagedDevices.Read.All`.

Without the optional device inventory role, cloud backups leave out device categories and device clean-up rules and record that in the backup, exactly like Backup Reader backups. Manual and desktop backups include them.

## How cloud backups are protected

The runbook writes every backup file, `metadata.json` and the status file as plain JSON, the same format the app writes to Azure. TenuVault does not encrypt backups in your storage account: Azure encrypts the account at rest, and your Azure role assignments decide who can read and write the `intune-backups` container. Anyone who can write there is trusted like an Intune admin, and anyone who can read there can read every backup, including the values of encrypted OMA-URI settings, which backups hold in plain text so restores stay complete. Grant blob data roles on the storage account only to your Intune admin group, keep soft delete on (the storage setup script turns it on) and consider blob versioning.

Cloud backups need no recovery key and no Key Vault. Backups on a device are still encrypted with the device's key; the recovery key is only about those, and about Azure backups made before this change.

## Upgrade from an earlier setup

Setups made with a runbook before 1.2.0 created a Key Vault `kv-tenuvault-<suffix>`, stored the recovery key in it, and sealed every cloud backup with that key. To move to plain backups, run the setup script again with the same values. That also works for a setup made with the template: pass its resource group and Automation account, plus `-GraphRolesGranted` when the Graph roles are already assigned. The script republishes the runbook, rewrites the tenant's Automation variables in place, removes the old `TenuVaultKeyVault-<tenant>` variable and names the old vault at the end. It removes that variable only after it reads the published runbook back from Azure and finds version 1.2.0 or later. When the import or publish did not take effect, for example because a `-Confirm` prompt was declined, the older runbook keeps its variable, and the script says why and asks you to run it again. Roles and backups stay as they are, and the schedule is set again from the values you pass. While the last run still reports an older runbook, the Schedule tab says so.

* **The old Key Vault**: this setup no longer needs it once the upgrade finished. Delete it once no TenuVault setup in this or any other Automation account still has a `TenuVaultKeyVault` variable. The script checks its own Automation account first: while another tenant there still has a `TenuVaultKeyVault-<tenant>` variable, or when the variables cannot be read, it names the vault as one to keep (with the tenants that still have the variable), and you run the setup for those tenants too. Other Automation accounts you check yourself. Deleting the vault also removes its role assignments. `-Remove` reports the same way.
* **Backups made before the upgrade** stay sealed with the recovery key that was in the vault and keep opening in TenuVault on a computer that has that key. Keep the exported key; on a new computer, use **Import recovery key** in the notice on **Backup & Restore**, or **Settings** > **Storage and recovery** > **Import a recovery key**, to open those older backups. New backups need no key. See [Older encrypted Azure backups](/security/encryption/#older-encrypted-azure-backups).

## Set it up

You need: the tenant on Pro or MSP with backups in your Azure storage account (Schedule tab, step 1), and an Azure administrator who can create Automation accounts and role assignments (Owner, or Contributor plus User Access Administrator, on the Automation resource group and, when it differs, on the storage account's resource group). In the storage resource group, setup also needs `Microsoft.Authorization/roleAssignments/write` and, when it creates the Backup Writer role or adds that group to its assignable scopes, `Microsoft.Authorization/roleDefinitions/write`; it checks those before creating Azure resources. The administrator also holds a blob data role such as Storage Blob Data Contributor on the storage account, because setup checks and creates the backup container with that signed-in account (management roles alone do not include data access). Creating the resource group itself needs a subscription level role such as Contributor on the subscription; without one, pass an existing group with `-ResourceGroupName`, and a Global Administrator for the Graph roles. One person can hold all of these.

### In the app: choose the time, hand off, paste the result

1. Open **Backup & Restore**, then **Schedule**. In step 1 confirm the tenant's backups go to your Azure storage account.
2. In step 3 choose **In Azure, no computer needed** (marked **Pro** on Community, where it explains what it needs). Pick the frequency, day and time. The calendar shows the coming runs. What is backed up follows step 2.
3. Create the resources with **Deploy to Azure** or with the copied setup command and scripts. Add `-AlertEmail you@contoso.com` to the command (or `-NoFailureAlert`).
4. Paste the block printed at the end of setup (or the template's `pasteIntoTenuVault` output) into the app. The Schedule tab then shows the Azure schedule, its next runs, and how the last cloud backup ended.

<figure class="docs-screenshot">
  <a href="/images/screenshots/backup-cloud.webp" aria-label="Open full-size screenshot: backup cloud">
    <img src="/images/screenshots/backup-cloud.webp" alt="Select In Azure, no computer needed to open the cloud setup handoff" width="2880" height="3600" loading="lazy" decoding="async" />
  </a>
  <figcaption>Select In Azure, no computer needed to open the cloud setup handoff. Example setup; no Azure resources were deployed. Select the image to view it full size.</figcaption>
</figure>

### The setup script

Download [`New-TenuVaultCloudBackup.ps1`](/downloads/New-TenuVaultCloudBackup.ps1) and [`Invoke-TenuVaultBackup.ps1`](/downloads/Invoke-TenuVaultBackup.ps1), keep the runbook in a `runbooks` folder next to the script, and run for example:

```powershell
./New-TenuVaultCloudBackup.ps1 -TenantId 11111111-1111-1111-1111-111111111111 -ResourceGroupName rg-tenuvault-backups -Location westeurope -StorageAccountName tvbkp1234567890ab -Frequency Daily -Time 02:00 -TimeZone Europe/Berlin -Scope policies -GrantGraphRoles -AlertEmail ops@contoso.com
```

Send a colleague this request if Azure and Entra are not yours:

> Please set up TenuVault cloud backups for our Intune tenant. Run `New-TenuVaultCloudBackup.ps1` with the command above (as Global Administrator, it assigns five read-only Graph application roles to the Automation account's managed identity and prints a consent receipt). Afterwards please send me the output block between the "paste into TenuVault" markers. Details and the permission list: https://docs.tenuvault.com/backups/cloud/

Running the script again with new values updates the variables, republishes the runbook and replaces the schedule. That is also the upgrade path for a newer runbook version.

### Deploy to Azure

The **Deploy to Azure** button in the app opens the template `resources/cloud-backup/azuredeploy.json` from the TenuVault repository in the Azure portal. The link cannot carry the choices made in the app with it: fill in tenant, storage account, frequency, day, timezone, scope and the first run time in the template as well, including the `excludedFolders` parameter when step 2 is a custom choice, since scope alone does not carry custom exclusions (its defaults are daily and everything except apps, and the first run's time of day becomes the schedule), and deploy it into the storage account's resource group. One scope difference applies to both setup paths: even the **Everything** scope leaves out device categories and device clean-up rules unless the device inventory role above is granted, through the template's `includeDeviceCategories` parameter or the script's `-IncludeDeviceCategories`. Cloud backups record that as a permission exclusion, never silently. The outputs name the managed identity and list the Graph roles a Global Administrator still has to assign: until then every run fails with access denied, on purpose, and the failure alert is up to you. The setup script remains the fuller path.

### Test it now

Do not wait for the first night. In the portal, open the Automation account, **Runbooks > Invoke-TenuVaultBackup > Start**, set `TENANTKEY` to the value from the setup output and `TRIGGER` to `Manual`, and watch the job. A successful run prints one "Found" and one "Backed up" line per type and ends with "Backup completed". The backup then appears in **Backup History** in TenuVault, marked **Manual**, with `Source: TenuVault Cloud Backup` in its details. Without `TRIGGER` it is marked **Scheduled**, like the runs the schedule starts.

### Manual and scheduled runs

From runbook 1.4.0 on, the runbook has an optional `TRIGGER` parameter, and Backup History shows each cloud backup as **Manual** or **Scheduled**. An older runbook has no `TRIGGER` field in the Start pane; run the setup script again to update it.

* To record a run you start by hand as **Manual**, start it with `TENANTKEY` and `TRIGGER` set to `Manual` (any case). Its change report then leaves out "after a scheduled backup".
* A run without `TRIGGER`, or with it empty, is recorded as **Scheduled**. The schedule link passes only `TENANTKEY`, so every scheduled run counts as scheduled, in setups made before 1.4.0 too, and nothing about the schedule changes. A run started by hand without `TRIGGER` also shows as **Scheduled**.
* Any other value is recorded as **Scheduled**, and the job output names the value in a warning. The backup itself is not affected.
* The setup script's "Test it now" hint says to set `TRIGGER` only when it read the published runbook back as 1.4.0 or later. Otherwise it says the run will show as **Scheduled** and to run the script again so the runbook is published.

Azure Automation does not tell a runbook whether its schedule or a person started it, so the parameter is how a run started by hand says so. Backups made before keep the trigger they recorded.

## How cloud backups show up in TenuVault

* **Backup History** lists them like any backup: same folders, same files, same compare, drift and restore. A profile whose encrypted OMA-URI value Microsoft refused to return is stored masked and marked not restorable from that backup, as in Backup Reader backups.
* The **Schedule** tab status shows the Azure schedule and the last cloud run the runbook recorded. The runbook writes `cloud-backup-status-<tenant>.json` into the backup container as each run ends, including runs that stop before or while reading or claiming their folder; that is all the app reads. Writing that file is best effort: a run cannot record anything when it gets no storage token, when the identity's blob role on the container was removed, when the storage firewall rejects the Automation account, or when the storage account is unavailable. The run then logs why and the tab keeps showing the previous result. So when the Schedule tab shows an older result than you expect, check the Automation account's job history and the failure alert; they are the record for those runs, and job output and errors stay in the Automation account.
* The **audit log** gets no entries from cloud runs: they never open the audit container. The Automation job list and the Entra managed identity sign-in log are the record.
* **Notifications**: with the [Azure watcher](/notifications/#alerts-while-this-computer-is-off-the-azure-watcher) set up in the same storage account, every cloud run is reported through your Teams, webhook and email channels as **Backup failed**, **Backup completed with warnings** or **Backup succeeded**, with no computer on. The alert's **Trigger** reads **Cloud backup schedule**, or **Cloud backup, started by hand** for a run started with `TRIGGER` set to `Manual` (backup runbook 1.4.0 and watcher runbook 1.5.0 or later; an older watcher shows every run as the schedule). Failed jobs are also reported by the Azure Monitor alert from setup.

### The result note

The watcher never opens backups or the status file: backups from runbooks before 1.2.0 are sealed with your recovery key, which the watcher never has, and policy content stays out of its reach. So that it can still alert, each run ends by writing one small note to `tenuvault-backup-results/cloud-backup-outcomes/` in your storage account: the status, the backup folder name, the number of policies saved, the number of failures, the names of the types that could not be read (for example `Apps`), whether the run was started by hand, the run id and the time. It never contains policy content, policy or tenant names, or error messages. This is the same information a Teams card for the result shows. The watcher validates the note, sends the alert and deletes the note. Notes older than 7 days are deleted without an alert, so a watcher set up long after your first cloud backups does not send weeks of history; a failed backup among them still counts as failed for **No recent backup**. Notes that are not valid for the tenant, or larger than 4 KB, are deleted without being sent or downloaded.

Setup creates the `tenuvault-backup-results` container when it is missing and gives the cloud backup identity the same **TenuVault Backup Writer** role there: it can add notes, not delete anything. It is a container of its own on purpose: the identity gets no write access to the watcher's state. The watcher's setup gives the watcher read and delete access to it; a watcher set up before this version needs its setup run once more. Without the watcher, notes stay in that container unread; they are small and harmless, and the watcher picks them up when you set it up. A run that cannot write its note (no container, no role) logs why and finishes normally; the note never changes the backup's result. Runs set up before this version leave no note until you run the cloud backup setup again (or redeploy the template) to grant the role.
* **Retention** does not run in Azure, because the identity cannot delete. The next backup a desktop makes with an admin's sign-in applies retention to every backup of the tenant, cloud ones included. If a tenant backs up only from the cloud, run a desktop backup now and then. Do not substitute an age-based storage lifecycle rule: it has none of the desktop protections (newest backup kept, failed runs never counted, a hold for unlicensed runs) and deletes every backup once cloud runs have been stopped longer than its threshold, which is exactly when the backups matter.

## Change reports by email

A cloud backup can also produce a [change report](/reports/): what changed since the previous complete backup, setting by setting, with who made each change from the Intune audit log. The [Azure watcher](/notifications/#alerts-while-this-computer-is-off-the-azure-watcher) emails it, so the report arrives with no computer on. It is off unless you turn it on.

1. In the app, under **Change report by email** next to the schedule, choose **Which settings changed** or **With setting values**, and tick **Leave out who made each change** if you want user names out. The setup command then carries `-ChangeReport Names` or `-ChangeReport Full`, `-ChangeReportWithoutActors` (or `-ChangeReportWithoutActors:$false`), and `-TenantName` with the tenant's name as reports show it. In the template, set `changeReport` to `names` or `full`, `changeReportActors`, and `tenantName`.
2. Run the setup script (or redeploy the template) so the runbook (1.3.0 or later, 1.4.0 for the email wording below) and its settings are updated.
3. Set up the Azure watcher with verified mail, if you have not, or run its setup again so it has the version that sends reports (watcher runbook 1.4.0 or later). Reports go to the watcher's `-ReportRecipients` (template: `reportRecipients`), or to its `-MailRecipients` when you set none. Any address works, inside or outside your organization.

The setup script keeps an earlier choice: a rerun without `-ChangeReport` leaves the report level as it was, a rerun without `-ChangeReportWithoutActors` leaves the actors as they were, and a rerun without `-TenantName` keeps the saved name (`-TenantName ''` names the tenant by its id again). The name is kept to 200 characters, and very long policy or tenant names are shortened in the email so the report is still sent. The app's command carries them only when you pick a level in that hand-off (**Keep the current choice** is the default), so pasting a newer command to upgrade the runbook never turns a report off. To turn reports off, choose **Off** (`-ChangeReport Off`). The template always writes both settings, so a template redeploy sets them to its parameters, off by default.

After every cloud backup that completes without warnings, the runbook compares it with the newest earlier complete backup of the tenant in the same storage account, made in the cloud or by the desktop app. Complete means recorded as succeeded with no failures. It only compares with a backup whose `metadata.json` or ownership marker names this tenant, the same rule restore uses. A storage account shared by several tenants is fine: folders whose ownership marker names another tenant are skipped without reading their manifest. The runbook looks at up to 500 earlier folders and reads at most 30 manifests, and reads no backup file larger than 32 MiB, the limit the app uses, or one that does not arrive within 90 seconds: such a manifest is skipped with a line in the job output, and such a policy file is listed under **Not compared** in the report. It reads both backups as plain JSON, reads the readable setting names from Microsoft Graph and the Intune audit events between the two backups (with the permissions it already has), and writes the report to `tenuvault-backup-results/cloud-change-reports/<backup folder>.json`. The watcher sends it on its next run from its verified mailbox, with the report attached as an HTML file (opens in any browser and prints to PDF) and as Markdown, then deletes it.

What to know before you turn it on:

* **The report is plain JSON**, like the backups it compares, and Azure encrypts it at rest. It holds policy and setting names and, with **With setting values**, their values. Secret values (passwords, keys, encrypted OMA-URI values) are never included. It stays until the watcher sends it, or 7 days at most. Anyone your role assignments let read `tenuvault-backup-results` can read it, and so can everyone who receives the email.
* **Older sealed backups are skipped.** Backups made before runbook 1.2.0, and Azure backups made by desktop versions before plain Azure backups, are sealed with a key the runbook does not have. The runbook never opens them: it compares with the newest earlier complete plain backup instead. When there is none, the run makes no report and its output says how many sealed backups it skipped. Right after an upgrade, the first report therefore arrives with the second plain backup.
* **Who made each change** is included by default. To leave user names out, add `-ChangeReportWithoutActors` to the setup command (template: `changeReportActors` false). Conditional Access changes have no actors in cloud reports: the Entra audit log needs a permission the cloud identity does not have.
* A backup that completed with warnings gets no report, and neither does the first plain backup of a tenant. The runbook output says why ("No change report: the backup completed with warnings"). A report that cannot be made never changes the backup's own result.
* Reports wait while the watcher's mail is not verified, and are deleted unsent after 7 days. If the watcher sent a report but could not delete it, it records the report in its state, never sends it again, retries the delete on later runs and shows the failure as its last error. Once 200 sent reports wait for their delete, new reports wait too, and the heartbeat says so, until the watcher can delete again (run its setup once more to restore its access). Waiting reports keep their original 7 day expiry: one that expires while it waits is deleted unsent, and the heartbeat says how many. A report the watcher refuses (larger than 4 MB, not valid JSON, for another tenant, or with a field it does not accept) is deleted unsent too, and the job output and heartbeat say how many and why. Delivery is at least once: in the rare case that the watcher can neither record nor delete a sent report, the next run may send it once more.
* The report HTML uses the TenuVault design; [PDF branding](/settings/#pdf-branding) applies to desktop reports only.
* Each report adds a few Graph reads per changed Settings Catalog setting and a few seconds to the run.
* When the Intune audit log cannot be read, the report is still sent and names no one. The email and the attached report say why in words that fit an email, for example "Who made them is unknown. Microsoft Graph throttled the Intune audit log request." There is nothing to generate again: the next cloud backup's report covers the following period as usual.

## License note

Cloud backups only exist where a tenant's backups already go to Azure storage, which needs Pro or MSP, and setup is guided from the app under that licence. The runbook itself runs in your subscription and cannot check your TenuVault licence at 02:00. Keep the tenant licensed: without an active Pro or MSP license for the tenant you are not entitled to keep using the cloud runner, and desktop features such as restore stay gated as usual.

## Change or remove

Change the time, scope or storage by running the setup script again with the new values, then paste its new output block into the app (**Update from setup output**). There is no schedule editor in the app for Azure, because the Automation schedule is the one place that decides when a run starts; the portal link on the Schedule tab opens it.

To stop cloud backups for a tenant, run the setup script with `-Remove`: it deletes that tenant's schedule link, schedule and variables, and lists what stays (Automation account, roles, all backups) and which Graph roles to revoke when the account is no longer used. It then reads back what is left of the tenant's setup. Only a confirmed "not found" counts as gone, and variables count as gone only when a complete list of the Automation account's variables no longer shows them, because Az.Automation reports a refused or failed read of a single variable as "not found". When a lookup or the list fails (for example sign-in, network or a service error), it says the removal could not be verified and what it could not check. Only when the schedule link, the schedule and the variables are all confirmed gone, and no other tenant in the Automation account still has a `TenuVaultKeyVault` variable, does it advise deleting a Key Vault left by an earlier setup, once no TenuVault setup in this or any other Automation account still has a `TenuVaultKeyVault` variable; otherwise it says what is left and to keep the vault. **Forget on this computer** on the Schedule tab only removes this app's record; the Azure schedule keeps running, which the button says.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| Every job fails with access denied | The managed identity is missing a Graph role or the storage role, or a new assignment is still propagating. The job output names the type or the container. |
| Job fails reading the Key Vault secret | The Automation account still runs a runbook older than 1.2.0. Run the setup script again to update it; plain backups need no vault. |
| An older cloud backup does not open | It was made before runbook 1.2.0 and is sealed with the recovery key from the old Key Vault. Import that recovery key in TenuVault. Backups made after the upgrade open without a key. |
| Two backups in the same second, one fails | The folder claim refused the second writer, by design. It writes nothing and the next slot runs normally. |
| The app shows no cloud run | The pasted setup points at another storage account than the tenant uses in the app, or no run finished yet. Check the Automation job list first. |
| The Schedule tab shows an older cloud run than expected | The latest runs could not write their status: no storage token, the identity's role on `intune-backups` removed, the storage firewall rejecting the Automation account, or the storage account unavailable. Open the Automation account's job history and the failure alert: the job output names the storage error ("Could not record the cloud backup status"). Restore the role or allow the Automation account through the firewall, then start the runbook once. |
| No change report arrives | Check the runbook output of the backup: it says when there was no earlier complete plain backup of the tenant (and how many sealed ones it skipped) or the backup completed with warnings. Then check the watcher: reports wait while its mail is not verified, and the heartbeat's last error names a failed send. |
| Costs | Automation job minutes for one short run per slot and the storage you already pay for. Retention does not run in Azure, so watch container growth. |

## Related pages

* [Schedule backups](/backups/schedules/)
* [Intune backup without a server](https://www.tenuvault.com/guides/intune-backup-without-a-server)
* [Backup storage and retention](/backups/storage/)
* [Backup Reader for scheduled backups](/backups/backup-reader/)
* [Conditional Access and TenuVault](/security/conditional-access/)
