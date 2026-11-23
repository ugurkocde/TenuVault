---
title: "What cannot be restored and restore write history"
description: Items TenuVault cannot restore automatically, and how to resolve restore writes with an unknown outcome.
faq:
  - question: "Can I restore a Win32 app from a configuration backup?"
    answer: "A configuration backup contains app details and assignments, not the installer, so it cannot recreate a Win32 app by itself. If you captured the installer with the separate App Backup feature, use Restore to tenant on that captured backup to create a new, unassigned Win32 app. Unsupported apps need their original installer and Intune's upload workflow."
  - question: "Are Apple enrollment tokens included in a backup?"
    answer: "No. Intune does not export Apple enrollment and content tokens. The token details and enrollment profiles are kept for reference. Renew or upload the token through Apple Business Manager or Apple School Manager and Intune."
  - question: "Why does a profile with a masked OMA-URI value need a new backup?"
    answer: "The backup holds the masked value (****) instead of the secret, and restoring it would send **** to devices. Run a new backup, then restore from it."
  - question: "What happens when the outcome of a restore write is unknown?"
    answer: "TenuVault records every restore write in an encrypted journal on your device and blocks an identical write whose outcome is uncertain. Check the object in the affected service’s admin center, then confirm the write as applied or not applied under Settings > Storage and recovery > Restore write history before you retry."
---

Most Intune items restore directly from a backup. A few cannot, because Intune does not export everything needed to recreate them. This page lists those cases and explains **Restore write history**, which protects you from duplicate writes when a restore is interrupted.

[App Backup](/apps/app-backup/) covers installer content separately. Its Windows preview retrieves supported Win32 installers on an enrolled PC and restores captured backups as new, unassigned apps to the same tenant on every plan, or to another connected tenant with Pro or MSP for that tenant. The configuration-backup wizard described below does not use those installer captures; start that restore from **App Backup → Backups → Restore to tenant…**. Earlier administrator-selected archives remain exportable, but do not qualify as captured backups for restore.

Availability depends on the service and policy type. Start with the limits for [Defender](/restore/defender/), [Entra ID](/restore/identity/) or [Intune](/restore/intune/).

## Items that cannot be restored

The **Backup & Restore** configuration wizard marks these items as **Cannot be restored** (or greys them out on **Choose what to restore**) and shows the reason under the item.

| Item | Reason shown | What to do |
| --- | --- | --- |
| Apps that use an installer file, such as Win32, line-of-business and MSI apps | "Intune does not let apps download installer files. Upload the installer again to restore this app." | This message applies to the metadata-only restore wizard. For a supported Win32 app captured earlier, use [App Backup's restore flow](/apps/app-backup/#restore-to-the-same-or-another-tenant). Otherwise obtain the original installer from its trusted source and upload it through Intune. |
| Apple automated device enrollment tokens and profiles | "The Apple token must be uploaded again in Intune. Its enrollment profiles are kept for reference." | Renew or upload the token through Apple Business Manager or Apple School Manager and Intune. Use the backed-up profiles as a reference. |
| Windows Autopilot devices that are not registered in the tenant, and every Autopilot device with **Create copies** or **Copy to other tenants instead** | "This device is not registered in Windows Autopilot in this tenant. Backups cannot include its hardware hash, so it cannot be registered again from a backup: import it again with its hardware hash, then restore it to bring back its group tag, user and device name." | Import the device again in Intune with its hardware hash, from the file you imported it with or from your OEM or reseller. Then restore it with **Replace in place**: TenuVault finds it by its serial number and puts its group tag, user and device name back. |
| Device configuration profiles with a masked OMA-URI secret | "This backup holds a masked OMA-URI value (****). Create a new backup to restore it; restoring would send **** to devices." | Run a new backup, then restore from it. |
| The tenant default enrollment configuration | "This is the tenant default. Restore updates it in place." | Use **Replace in place**. The default cannot be copied. |
| The default Company Portal branding | "This is the default branding. Restore updates it in place." | Use **Replace in place**. |
| Compliance policy settings, with **Create copies** or **Copy to other tenants instead** | "This is a tenant-wide setting, not a policy. Restore replaces it in place in the same tenant; it cannot be created as a copy or copied to another tenant." | Use **Replace in place** in the same tenant. For another tenant, set them in that tenant's Intune admin center under **Endpoint security** > **Device compliance** > **Compliance policy settings**, using the backed-up values as a reference. |
| Compliance policies whose snapshot has no block action | "This compliance snapshot is missing its required block action. Create a new complete backup before restoring." | Run a new, complete backup and restore from it. |
| Backups in Azure storage that do not record their tenant, with **Replace in place**, **Restore assignments**, **Revert** or **Recreate** | "This backup does not record its tenant. Restore it as a copy instead." | Restore an unassigned copy. Backups made by TenuVault record their tenant; this affects only backups from very old versions. See [When replace in place is blocked](/restore/modes/#when-replace-in-place-is-blocked). |
| A backup whose ownership marker is damaged | "This backup's ownership record is damaged, so TenuVault cannot tell which tenant it belongs to." | Restore from another backup. TenuVault never treats a damaged marker as a backup without a tenant. |
| Azure backups an earlier TenuVault version encrypted, on a device without its key | "This backup was encrypted by an earlier TenuVault version. Import the recovery key of the device that made it to open it." | Import the recovery key of the device that made the backup, or restore from a newer backup. See [Older encrypted Azure backups](/security/encryption/#older-encrypted-azure-backups). |
| A file in the backup that is not a known Intune type | "This backup file is not an Intune type TenuVault can restore." | Recreate the object manually in Intune. |
| A snapshot TenuVault cannot read | "The backup file could not be read." or "This snapshot could not be assessed." | See [Troubleshooting](/troubleshooting/#restore). |

### Apps that restore without an installer

These app types do not need an installer file, so TenuVault can recreate them:

* Web links and Windows web apps
* iOS store apps and iOS volume-purchased (VPP) apps
* Android store apps
* Microsoft Store apps (WinGet)
* Microsoft 365 Apps for Windows and for macOS
* Microsoft Edge for Windows and for macOS
* Microsoft Defender for macOS
* Microsoft Store for Business apps
* Enterprise App Catalog apps, as long as the catalog package still exists in Intune

App categories, app dependencies and supersedence links are restored with the app.

### What configuration backups cannot contain

The Microsoft Graph configuration backup does not include:

* Installer payloads of apps. Supported Win32 payloads can instead be captured separately through [App Backup](/apps/app-backup/#what-happens-behind-the-backup-button).
* Apple enrollment and content tokens
* Windows Autopilot hardware hashes, which Microsoft Graph returns only while a device is imported
* Private keys and other secret material that the Microsoft Graph API does not return

Built-in scope tags and built-in Intune roles are not backed up, because they exist in every tenant.

### Other behavior to know about

* **Android Enterprise enrollment profiles** that are recreated get a new enrollment token that is valid for 90 days. A replace in place keeps the live token.
* **Types with limited assignment restore.** Windows Autopilot deployment profiles, Apple user enrollment profiles, terms and conditions and Intune roles cannot have their assignments replaced in place. See [Restore modes and assignments](/restore/modes/#types-that-need-assignments-reconciled-in-intune).
* **Windows Autopilot devices** restore in place only: the group tag, the assigned user and its friendly name, and the device name. A device with no user in the backup has its user unassigned. Intune sets a friendly name only together with a user and cannot clear one on its own, so a friendly name the backup holds without a user, or leaves empty while it keeps a user, stays as it is; the restore review shows it. Intune applies the changes within a few minutes, so the device can show its old values right after the restore. See [Windows Autopilot devices](/backups/coverage/#windows-autopilot-devices).
* **Exclusions.** Enrollment configurations and terms and conditions do not accept exclusion assignments, so exclusions are left out when their assignments are restored.
* **Cross-tenant copies** are always unassigned and get the Default scope tag. See [Restore to another tenant](/restore/cross-tenant/).
* **Compliance policy settings.** Replace in place writes only the settings that differ from the tenant. A compliance status validity period the backup holds as 0 (never set) or outside 1 to 120 days is never written; the tenant keeps its value and the review says so. See [Compliance policy settings](/restore/modes/#compliance-policy-settings).
* **Password policies.** Restoring an assigned macOS or Windows policy with password settings can make users on targeted devices set a new local password. See [Password policies can force a password change](/restore/modes/#password-policies-can-force-a-password-change).

## Backup completeness checks

Before a restore writes anything, TenuVault reads the backup's recorded status and item manifest. A full restore of a backup recorded as failed, that could not read some items or has no recorded completion status, and a backup whose files are missing from or not listed in its manifest are refused with a message that tells you to restore from a complete backup instead. Selected items from a backup that stopped early can still be restored on their own: a backup recorded as failed allows this only for the items its manifest lists, and a failed backup that lists no items is refused. Each restored file is also checked against the fingerprint the backup recorded for it. A file whose content no longer matches fails with "This backup file does not match its recorded fingerprint. It was not restored." Backups made before item fingerprints existed are restored without this check.

Before an item is created, TenuVault also checks that the other items its content references, such as an app category, a scope tag or a notification template, still exist in the tenant or were recreated earlier in the same restore. If a referenced item is missing, the item fails before anything is written. Restore the referenced item first, or reconcile the item in Intune.

## Incomplete restores

Many Intune objects are created in several steps: the object first, then its settings, categories, localized messages or assignments. If the object is created or updated but a later step fails, the result is an incomplete object, not a success. The results list shows "Incomplete object: *ID*."

* When the failure is safe to retry, **Retry failed items** repairs the remaining steps against the same object instead of creating another one. Repair is available for one hour in the same app session.
* For a replace in place, the repair first checks that the live object has not changed since the failure. If it has, the repair stops with "The live object changed after the failed restore. Review it and start a fresh replacement."
* If the repair window has passed or the app was restarted, the retry reports "Repair is unavailable or expired. Check the existing object in Intune; do not create another copy." Complete the object in Intune.

## Restore write history

When TenuVault sends a write to Microsoft Graph and the response is lost (a timeout, dropped connection or server error), it cannot know whether the service applied the change. Repeating the write blindly could create a duplicate object. TenuVault therefore records every restore write in an encrypted journal on your device, and blocks an identical write whose outcome is uncertain until you resolve it.

A blocked write fails with "A previous write has an uncertain outcome. Reconcile it in Settings before retrying." The wizard names the admin center where you can check the affected object before retrying.

The journal stores the method, target path, tenant, time, a short policy name and the object ID when known. It never stores full request payloads or access tokens. OpenIntuneBaseline deployments and drift fixes use the same protection.

### Open the history

1. Go to **Settings** > **Storage and recovery**.
2. Under **Restore history tenant**, select the tenant.
3. The **Restore write history** card lists every recorded write for that tenant, newest first. Click **Refresh history** to reload it. If the refresh fails, the previous records stay visible with an error.

Opening or changing the history requires the tenant's stored sign-in, an active license, and live management access to a service the tenant backs up: Intune, or Entra Conditional Access when Intune is turned off for the tenant under **Settings** > **Services and permissions**. Records of other tenants are never shown.

Each record shows the policy name (or "Object name unavailable"), the time, its state, the tenant, the request method and path, and the object ID if known. States are:

| State | Meaning |
| --- | --- |
| `complete` | The write succeeded. |
| `uncertain` | The response was lost. The same write is blocked until you resolve it. |
| `reconciled` | You confirmed the write was applied and recorded its object ID. |

### Resolve an uncertain write

1. Open the admin center for the affected service in the tenant shown in the record and look for the object named in the record.
2. Choose the action that matches what you found:
   * **Confirm applied**: the object exists. Enter its object ID in the inline form and choose **Save applied ID**. The ID must be a GUID. A later retry reuses this result instead of sending the write again.
   * **Confirm not applied**: the object does not exist. Confirm that you checked the target tenant in the named admin center and that the request was not applied. The next retry sends the write again.
3. Retry the restore from the wizard.

Invalid IDs and failed requests show an error in the form. The form stays open so you can correct the ID or try saving again. After a failed save, focus returns to the input. **Cancel** or **Escape** closes the form without saving while no save is in progress. Closing the form returns focus to the record's recovery button or, if the entry is gone, to **Refresh history**, including after a successful save.

:::caution
Do not confirm a write as not applied just because its response was lost. Check the object in the named admin center first. Confirming wrongly can create a duplicate object.
:::

### Fix a reconciled write

Reconciled records offer two actions:

* **Correct applied ID** fixes a mistaken object ID without allowing another create. The inline form starts with the recorded ID. Enter the corrected GUID and choose **Save applied ID**. The next retry reads the object and verifies its creation fields before any follow-up writes.
* **Allow a new operation** clears the record so an identical request can be sent again. Use it only for a genuinely new operation, and never while you are resuming a repair.

When a retry reuses a reconciled creation, TenuVault reads the object in the recorded tenant and checks its ID and the fields from the original request before continuing. If they do not match or cannot be read, it stops with "The reconciled object does not match the original creation request, or its fields cannot be verified. No follow-up writes were sent. Review the ID and complete recovery manually in the admin center named in the message."

### Journal size

The journal keeps up to 1,000 records. When it is full, TenuVault removes completed records and reconciliations older than one hour. Uncertain writes are never removed. If only uncertain and recent records remain, restores stop with "Restore journal is full. Review write history in Settings before continuing; recent reconciliations stay protected for one hour." Resolve the uncertain records to continue.

## Related pages

* [Intune restore](https://www.tenuvault.com/intune-restore): what restores automatically and what does not, on the product site
* [Restore Intune policies](/restore/)
* [Disaster recovery](/restore/disaster-recovery/)
* [What gets backed up](/backups/coverage/)
* [Multi Admin Approval and TenuVault](/restore/multi-admin-approval/)
* [Troubleshooting](/troubleshooting/)

### Missing change details

A job that stops unexpectedly can contain both recorded item outcomes and items whose write outcome is uncertain or unattempted. Review uncertain items in the affected service’s admin center before retrying. Older audit entries can show **Change details unavailable**. See [Audit Log](/audit-log/) for the fields kept in new events.

## Directory objects that are never restored

These exclusions also apply to staged directory recovery. The preview reports the reason for each affected row.

| Object or relationship | Reason |
| --- | --- |
| Application and enterprise-app secrets or private keys | Credentials were never backed up. Create replacement credentials with the application owner. |
| Federated identity credentials | Trust credentials must be re-established by the owner. |
| User passwords and authentication methods | Sign-in credentials were never backed up. Set up sign-in again in Entra. |
| Members of dynamic groups | The membership rule determines members. Direct membership writes are refused. |
| Microsoft first-party service principals | Microsoft manages these service identities. |
| Activated PIM instances | An activation is not replayed as a permanent role assignment or eligibility. |
| Objects synchronized from on-premises | The source directory owns them, including identities with retained synchronization identity. |
| Devices | A device object is created by device registration. |
| Domains | Ownership and federation need separate verification and setup. |

Mail-enabled security groups and distribution groups cannot be recreated through the directory Graph flow. Microsoft 365 recovery covers its directory object only. Teams, SharePoint and mailbox content are excluded. Only the admitted closed directory subsets are available. See [Directory recovery](/restore/identity/#users-and-groups).

## Directory restore boundaries

Directory restore supports disabled cloud member creation, existing cloud member display names, static security-group creation/nonempty descriptions, manager assignment and ordinary user member/owner relationships. See [the per-operation boundaries](/restore/identity/#users-and-groups). Each removal needs the group's exact choice and an individual approval. Exact member removal is not performed for Conditional Access targeted groups because membership changes can affect policy enforcement and safe remaining membership cannot be established across concurrent edits or replication delay. Remove those members in Microsoft Entra. Unreadable targeting blocks removal; ordinary security-group removals remain admitted. Account state, recycle recovery, guests, licenses, Microsoft 365 groups, dynamic rules, role-assignable or Conditional Access excluded groups, nested principals and other unverified fields remain blocked with reasons.

Passwords and authentication methods, application secrets/private keys, federated identity credentials, dynamic members, Microsoft first-party service principals, activated PIM instances, synced objects, devices and domains are never restored. Recreation gets a new ID; review policy targets and external integrations before activation. Application recreation would also get a new app ID, but is not enabled here.

The lab leaves only soft-deleted test groups, which Entra permanently removes after 30 days. They are audited by ID and deletion date. Test users are permanently removed; earlier runs' deleted groups are never restored by a later run.

Clearing a group description is blocked because a live null restore did not consistently match read-back.

Group link restore also refuses a resource with any current directory membership, including parent groups, directory roles and administrative units. This avoids granting inherited privilege through an unverified ancestor. The lookup uses existing group read access.

User display-name and manager changes are blocked when Conditional Access group targeting or exclusions exist or cannot be completely read. Their dynamic-membership effects need a separate verified review. Every access addition and manager change also has separate privilege and security-response approvals.

Application restore uses individual review. Only operations with matching documentation, live fixture read-back and production integration tests are admitted. Application registration updates are limited to nonempty displayName and description. Owner restore remains blocked because the lab verifies only fixture service-principal owners, while the production owner resolver handles users. Delegated consent remains blocked after inconsistent live lifecycle results, including a later HTTP 400 deletion after an earlier complete matched cycle. Enterprise app metadata and app role assignment restore remain blocked after HTTP 400 in live round trips. Creation, other metadata fields and app policy bindings remain blocked. Recycle recovery can revive credentials and access and cannot be admitted by checking IDs alone. Recreated registrations get a new app ID and break every client using the old one. Gallery apps need verified template provenance, which current backups lack. SSO, SAML signing keys, provisioning secrets and all credentials require setup again. See [application restore](/restore/identity/#app-registrations-enterprise-apps-and-consent).


## Saved directory restores

A saved Users, Groups or Applications restore owns the live target across its batches. A newer backup cannot bypass that ownership. Microsoft Graph throttling is deferred until the displayed earliest retry time; cancelling does not erase that deadline. A dispatched request with no confirmed result stays uncertain and is never resent automatically.

Use the saved page ID with **Confirm saved page results** for read-only reconciliation, including after backup retention or restore opt-out. Only a unique matching read-back confirms application. Old values or an empty lookup do not establish that an uncertain request failed. Group aliases cannot uniquely identify an unanswered create, so such a create can remain locked.

**Discard saved restore** is available only when the page is idle and has no uncertain step. Discard releases its locks and permanently prevents that page from sending again, while keeping applied changes and throttle deadlines. It does not roll back tenant changes. Enable the relevant area with Backup and restore access before previewing or sending any new write.

The 30 minute directory consistency rule applies only to confirming TenuVault's own uncertain relationship writes, both additions and removals, when its journal has an acknowledged opposite write for the same member and object within that window. Matching reads remain uncertain until the window passes. Acknowledged results survive same-session save retries. Preview reads can still be stale after TenuVault's own write; run a fresh preview when needed.

Role assignments, role eligibility and assignment schedules, PIM for Groups and administrative unit relationships have a separate review. Restoring roles and PIM is not available yet. You can review what would change. Expired schedules and activated instances cannot be replayed. Older administrative unit backups that contain only scoped membership IDs cannot recover a removed scoped role member. Restricted management administrative units are excluded from relationship restore. The restriction itself is fixed at unit creation.
