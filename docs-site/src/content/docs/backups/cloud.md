---
title: "Cloud backups in Azure"
description: Scheduled Intune backups that run in an Azure Automation runbook in your own subscription, with a managed identity, so no admin computer has to be on or signed in.
---

Scheduled backups normally run in the TenuVault app on an admin's computer. That computer has to be on, signed in, and still hold a valid Microsoft session. **Cloud backups** move the schedule into your own Azure subscription: a PowerShell runbook in an Azure Automation account reads Intune with a managed identity, seals the backup with your recovery key, and writes it to the same storage account as your other backups. Nothing runs in a TenuVault tenant and no backup reaches a TenuVault server.

## Computer, Backup Reader or cloud: which runner when

|  | On this computer (your sign-in) | On this computer (Backup Reader) | In Azure (cloud backups) |
| --- | --- | --- | --- |
| Runs while the computer is off | No | No | Yes |
| Survives Conditional Access sign-in frequency | No | Yes | Yes |
| Identity that reads Intune | You, delegated | Read-only app registration, certificate on the computer | Automation managed identity, read-only app roles |
| Storage | This device or your Azure account | Same | Your Azure account only |
| Encrypted OMA-URI values | In plain text | In plain text; masked (`****`) if Microsoft refuses the read | Same as the Backup Reader |
| Deletes old backups (retention) | Yes | No, the next sign-in backup does | No, same |
| Extra moving parts | Tray and background launch | Yearly certificate renewal per computer | Automation account, Key Vault secret, failure alert |
| Plans | All (weekly on Community) | Pro and MSP | Pro and MSP |

Use cloud backups when several admins share one tenant's backups, when no computer is reliably on at backup time, or when sign-in frequency would otherwise need an exception. Keep computer backups when try-out local backups are enough. Both runners can be on at once; each makes its own backups into the same storage.

## What gets created

Setup creates or reuses, in your subscription:

| Resource | Purpose |
| --- | --- |
| Resource group `rg-tenuvault-backups` | Holds the cloud backup resources. Reuse the storage account's group. |
| Automation account `aa-tenuvault` with a system assigned managed identity | Runs the runbook. One account serves one Entra tenant: a managed identity belongs to its own tenant and cannot read Intune in another, so an MSP sets up an account in each customer tenant's subscription. |
| Runbook `Invoke-TenuVaultBackup` (PowerShell 7.2) | Reads Intune and writes one backup per run, in the desktop backup format. 7.2 is required: the default 5.1 runtime lacks the cryptography types the sealing uses. |
| Automation variables with a per-tenant suffix | Tenant id, storage account, Key Vault, scope. No secrets in variables. Set `TenuVaultIncludeConditionalAccess` to `true` (and grant the managed identity `Policy.Read.All`) to include [Conditional Access](/backups/conditional-access/). |
| Key Vault `kv-tenuvault-<suffix>` (RBAC) | Holds the recovery key as the secret `tenuvault-recovery-key`. The identity only reads secrets. |
| Custom role **TenuVault Backup Writer** on the `intune-backups` container | Read and write blobs, no delete. The runbook cannot remove backups. |
| Schedule `TenuVaultBackup-<tenant>` and its runbook link | Daily or weekly, in the timezone you choose. |
| Optional Azure Monitor action group and metric alert | Emails you when Automation jobs fail. Setup refuses to finish without an explicit choice. |

Microsoft Graph application roles are the one part Azure role assignments and ARM templates cannot grant. A Global Administrator assigns the read-only roles below to the managed identity. They are the same set as the [Backup Reader](/backups/backup-reader/#permissions):

`DeviceManagementConfiguration.Read.All`, `DeviceManagementApps.Read.All`, `DeviceManagementServiceConfig.Read.All`, `DeviceManagementScripts.Read.All`, `DeviceManagementRBAC.Read.All`, and optionally `DeviceManagementManagedDevices.Read.All`.

Without the optional device inventory role, cloud backups leave out device categories and device clean-up rules and record that in the backup, exactly like Backup Reader backups. Manual and desktop backups include them.

## The recovery key in Key Vault

Desktop backups to Azure are sealed with your backup recovery key before upload. The runbook seals exactly the same way, which is why cloud backups decrypt in the app without any conversion. It needs the current recovery key, read from Key Vault at the start of every run.

Treat that secret like the recovery key it is: **anyone who can read it can read every backup sealed with this key for this tenant.** Setup adds you (Secrets Officer) and the managed identity (Secrets User) on the vault it creates. Effective access is wider than those two assignments when roles are inherited from the resource group or subscription, or when an existing vault is reused, so review who can actually read secrets on the vault (Access control, Check access) instead of trusting the list setup printed. Keep it tight, keep the exported key where you already keep it, and when you rotate recovery keys by importing a new one in the app, update the Key Vault secret too, or cloud backups keep sealing with the old key (still readable while that key stays in your keyring, and listed as sealed with an older key).

The key is pasted at the setup script's hidden prompt or into the template's secure parameter. It is never a command line argument, never printed, and never stored in an Automation variable.

## Set it up

You need: the tenant on Pro or MSP with backups in your Azure storage account (Schedule tab, step 1), the recovery key saved, and an Azure administrator who can create Automation accounts and role assignments (Owner, or Contributor plus User Access Administrator, on the Automation resource group and, when it differs, on the storage account's resource group). In the storage resource group, setup also needs `Microsoft.Authorization/roleAssignments/write` and, when it creates the Backup Writer role or adds that group to its assignable scopes, `Microsoft.Authorization/roleDefinitions/write`; it checks those before creating Azure resources. The administrator also holds a blob data role such as Storage Blob Data Contributor on the storage account, because setup checks and creates the backup container with that signed-in account (management roles alone do not include data access). Creating the resource group itself needs a subscription level role such as Contributor on the subscription; without one, pass an existing group with `-ResourceGroupName`, and a Global Administrator for the Graph roles. One person can hold all of these.

### In the app: choose the time, hand off, paste the result

1. Open **Backup & Restore**, then **Schedule**. In step 1 confirm the tenant's backups go to your Azure storage account.
2. In step 3 choose **In Azure, no computer needed** (marked **Pro** on Community, where it explains what it needs). Pick the frequency, day and time. The calendar shows the coming runs. What is backed up follows step 2.
3. Create the resources with **Deploy to Azure** or with the copied setup command and scripts. Add `-AlertEmail you@contoso.com` to the command (or `-NoFailureAlert`), and paste the recovery key when the script asks.
4. Paste the block printed at the end of setup (or the template's `pasteIntoTenuVault` output) into the app. The Schedule tab then shows the Azure schedule, its next runs, and how the last cloud backup ended.

### The setup script

Download [`New-TenuVaultCloudBackup.ps1`](/downloads/New-TenuVaultCloudBackup.ps1) and [`Invoke-TenuVaultBackup.ps1`](/downloads/Invoke-TenuVaultBackup.ps1), keep the runbook in a `runbooks` folder next to the script, and run for example:

```powershell
./New-TenuVaultCloudBackup.ps1 -TenantId 11111111-1111-1111-1111-111111111111 -ResourceGroupName rg-tenuvault-backups -Location westeurope -StorageAccountName tvbkp1234567890ab -Frequency Daily -Time 02:00 -TimeZone Europe/Berlin -Scope policies -GrantGraphRoles -AlertEmail ops@contoso.com
```

Send a colleague this request if Azure and Entra are not yours:

> Please set up TenuVault cloud backups for our Intune tenant. Run `New-TenuVaultCloudBackup.ps1` with the command above (as Global Administrator, it assigns five read-only Graph application roles to the Automation account's managed identity and prints a consent receipt). When it prompts for the recovery key I will provide it; it is stored only in the new Key Vault. Afterwards please send me the output block between the "paste into TenuVault" markers. Details and the permission list: https://docs.tenuvault.com/backups/cloud/

Running the script again with new values updates the variables, republishes the runbook and replaces the schedule. That is also the upgrade path for a newer runbook version.

### Deploy to Azure

The **Deploy to Azure** button in the app opens the template `resources/cloud-backup/azuredeploy.json` from the TenuVault repository in the Azure portal. The link cannot carry the choices made in the app with it: fill in tenant, storage account, recovery key, frequency, day, timezone, scope and the first run time in the template as well, including the `excludedFolders` parameter when step 2 is a custom choice, since scope alone does not carry custom exclusions (its defaults are daily and everything except apps, and the first run's time of day becomes the schedule), and deploy it into the storage account's resource group. One scope difference applies to both setup paths: even the **Everything** scope leaves out device categories and device clean-up rules unless the device inventory role above is granted, through the template's `includeDeviceCategories` parameter or the script's `-IncludeDeviceCategories`. Cloud backups record that as a permission exclusion, never silently. The outputs name the managed identity and list the Graph roles a Global Administrator still has to assign: until then every run fails with access denied, on purpose, and the failure alert is up to you. The setup script remains the fuller path.

### Test it now

Do not wait for the first night. In the portal, open the Automation account, **Runbooks > Invoke-TenuVaultBackup > Start**, set `TENANTKEY` to the value from the setup output, and watch the job. A successful run prints one "Found" and one "Backed up" line per type and ends with "Backup completed". The backup then appears in **Backup History** in TenuVault, marked as scheduled, with `Source: TenuVault Cloud Backup` in its details.

## How cloud backups show up in TenuVault

* **Backup History** lists them like any backup: same folders, same sealed files, same compare, drift and restore. A profile whose encrypted OMA-URI value Microsoft refused to return is stored masked and marked not restorable from that backup, as in Backup Reader backups.
* The **Schedule** tab status shows the Azure schedule and the last cloud run the runbook recorded. The runbook writes a sealed `cloud-backup-status-<tenant>.json` into the backup container as each run ends, including runs that stop while reading or claiming their folder; that is all the app reads. A run that fails before it could read the recovery key (no managed identity token, Key Vault unreachable or the secret missing) cannot record anything sealed, so the tab can still show the previous result. The Automation job list and the failure alert are the record for those, and job output and errors stay in the Automation account.
* The **audit log** gets no entries from cloud runs: they never open the audit container. The Automation job list and the Entra managed identity sign-in log are the record.
* **Notifications**: with the [Azure watcher](/notifications/#alerts-while-this-computer-is-off-the-azure-watcher) set up in the same storage account, every cloud run is reported through your Teams, webhook and email channels as **Backup failed**, **Backup completed with warnings** or **Backup succeeded**, with no computer on. Failed jobs are also reported by the Azure Monitor alert from setup.

### The result note

Backups and the status file are sealed with your recovery key, and the watcher never has it. So that it can still alert, each run ends by writing one small note that is **not** encrypted to `tenuvault-backup-results/cloud-backup-outcomes/` in your storage account: the status, the backup folder name, the number of policies saved, the number of failures, the names of the types that could not be read (for example `Apps`), the run id and the time. It never contains policy content, policy or tenant names, or error messages. This is the same information a Teams card for the result shows. The watcher validates the note, sends the alert and deletes the note. Notes older than 7 days are deleted without an alert, so a watcher set up long after your first cloud backups does not send weeks of history; a failed backup among them still counts as failed for **No recent backup**. Notes that are not valid for the tenant, or larger than 4 KB, are deleted without being sent or downloaded.

Setup creates the `tenuvault-backup-results` container when it is missing and gives the cloud backup identity the same **TenuVault Backup Writer** role there: it can add notes, not delete anything. It is a container of its own on purpose: the identity gets no write access to the watcher's state. The watcher's setup gives the watcher read and delete access to it; a watcher set up before this version needs its setup run once more. Without the watcher, notes stay in that container unread; they are small and harmless, and the watcher picks them up when you set it up. A run that cannot write its note (no container, no role) logs why and finishes normally; the note never changes the backup's result. Runs set up before this version leave no note until you run the cloud backup setup again (or redeploy the template) to grant the role.
* **Retention** does not run in Azure, because the identity cannot delete. The next backup a desktop makes with an admin's sign-in applies retention to every backup of the tenant, cloud ones included. If a tenant backs up only from the cloud, run a desktop backup now and then. Do not substitute an age-based storage lifecycle rule: it has none of the desktop protections (newest backup kept, failed runs never counted, a hold for unlicensed runs) and deletes every backup once cloud runs have been stopped longer than its threshold, which is exactly when the backups matter.

## Change reports by email

A cloud backup can also produce a [change report](/reports/): what changed since the previous complete backup, setting by setting, with who made each change from the Intune audit log. The [Azure watcher](/notifications/#alerts-while-this-computer-is-off-the-azure-watcher) emails it, so the report arrives with no computer on. It is off unless you turn it on.

1. In the app, under **Change report by email** next to the schedule, choose **Which settings changed** or **With setting values**. The setup command then carries `-ChangeReport Names` or `-ChangeReport Full`. In the template, set `changeReport` to `names` or `full`.
2. Run the setup script (or redeploy the template) so the runbook and its settings are updated.
3. Set up the Azure watcher with verified mail, if you have not, or run its setup again so it has the version that sends reports. Reports go to the watcher's `-ReportRecipients`, or to its `-MailRecipients` when you set none. Any address works, inside or outside your organization.

After every cloud backup that completes without warnings, the runbook compares it with the newest earlier complete backup of the tenant in the same storage account, made in the cloud or by the desktop app. It reads both with the recovery key, reads the readable setting names from Microsoft Graph and the Intune audit events between the two backups (with the permissions it already has), and writes the report to `tenuvault-backup-results/cloud-change-reports/<backup folder>.json`. The watcher sends it on its next run from its verified mailbox, with the report attached as an HTML file (opens in any browser and prints to PDF) and as Markdown, then deletes it.

What to know before you turn it on:

* **The report is not encrypted** with the recovery key while it waits in your storage account, because the watcher has no key. It holds policy and setting names and, with **With setting values**, their values. Secret values (passwords, keys, encrypted OMA-URI values) are never included. It stays until the watcher sends it, or 7 days at most. Anyone who can read that container can read it, and so can everyone who receives the email.
* **Who made each change** is included by default. To leave user names out, add `-ChangeReportWithoutActors` to the setup command (template: `changeReportActors` false). Conditional Access changes have no actors in cloud reports: the Entra audit log needs a permission the cloud identity does not have.
* A backup that completed with warnings gets no report, and neither does the first backup of a tenant. The runbook output says why.
* Reports wait while the watcher's mail is not verified, and are deleted unsent after 7 days.
* The report HTML uses the TenuVault design; [PDF branding](/settings/#pdf-branding) applies to desktop reports only.
* Each report adds a few Graph reads per changed Settings Catalog setting and a few seconds to the run.

## License note

Cloud backups only exist where a tenant's backups already go to Azure storage, which needs Pro or MSP, and setup is guided from the app under that licence. The runbook itself runs in your subscription and cannot check your TenuVault licence at 02:00. Keep the tenant licensed: without an active Pro or MSP license for the tenant you are not entitled to keep using the cloud runner, and desktop features such as restore stay gated as usual.

## Change or remove

Change the time, scope or storage by running the setup script again with the new values, then paste its new output block into the app (**Update from setup output**). There is no schedule editor in the app for Azure, because the Automation schedule is the one place that decides when a run starts; the portal link on the Schedule tab opens it.

To stop cloud backups for a tenant, run the setup script with `-Remove`: it deletes that tenant's schedule link, schedule and variables, and lists what stays (Automation account, Key Vault, roles, all backups) and which Graph roles to revoke when the account is no longer used. **Forget on this computer** on the Schedule tab only removes this app's record; the Azure schedule keeps running, which the button says.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| Every job fails with access denied | The managed identity is missing a Graph role or the storage role, or a new assignment is still propagating. The job output names the type or the container. |
| Job fails reading the Key Vault secret | The identity needs **Key Vault Secrets User** on the vault, and the secret must be the current TVK2 bundle. A value that is not a recovery key stops the run with that message. |
| The backup runs but TenuVault cannot open it | The vault secret and this device's keyring disagree. Import the recovery key of the vault secret, or update the secret to the current key. |
| Two backups in the same second, one fails | The folder claim refused the second writer, by design. It writes nothing and the next slot runs normally. |
| The app shows no cloud run | The pasted setup points at another storage account than the tenant uses in the app, or no run finished yet. Check the Automation job list first. |
| No change report arrives | Check the runbook output of the backup: it says when there was no earlier complete backup or the backup completed with warnings. Then check the watcher: reports wait while its mail is not verified, and the heartbeat's last error names a failed send. |
| Costs | Automation job minutes for one short run per slot, Key Vault operations, and the storage you already pay for. Retention does not run in Azure, so watch container growth. |

## Related pages

* [Schedule backups](/backups/schedules/)
* [Intune backup without a server](https://www.tenuvault.com/guides/intune-backup-without-a-server)
* [Backup storage and retention](/backups/storage/)
* [Backup Reader for scheduled backups](/backups/backup-reader/)
* [Conditional Access and TenuVault](/security/conditional-access/)
