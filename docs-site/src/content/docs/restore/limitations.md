---
title: "What cannot be restored and restore write history"
description: Items TenuVault cannot restore automatically, and how to resolve restore writes with an unknown outcome.
faq:
  - question: "Why can't TenuVault restore Win32 and line-of-business apps?"
    answer: "Intune does not let apps download installer files, so a backup holds only the app details and assignments. Get the original installer from its trusted source and upload it again through Intune's app workflow. Store, web and Microsoft 365 apps restore without an installer."
  - question: "Are Apple enrollment tokens included in a backup?"
    answer: "No. Intune does not export Apple enrollment and content tokens. The token details and enrollment profiles are kept for reference. Renew or upload the token through Apple Business Manager or Apple School Manager and Intune."
  - question: "Why does a profile with a masked OMA-URI value need a new backup?"
    answer: "The backup holds the masked value (****) instead of the secret, and restoring it would send **** to devices. Run a new backup, then restore from it."
  - question: "What happens when the outcome of a restore write is unknown?"
    answer: "TenuVault records every restore write in an encrypted journal on your device and blocks an identical write whose outcome is uncertain. Check the object in Intune, then confirm the write as applied or not applied under Settings > Storage and recovery > Restore write history before you retry."
---

Most Intune items restore directly from a backup. A few cannot, because Intune does not export everything needed to recreate them. This page lists those cases and explains **Restore write history**, which protects you from duplicate writes when a restore is interrupted.

## Items that cannot be restored

The restore wizard marks these items as **Cannot be restored** (or greys them out on **Choose what to restore**) and shows the reason under the item.

| Item | Reason shown | What to do |
| --- | --- | --- |
| Apps that use an installer file, such as Win32, line-of-business and MSI apps | "Intune does not let apps download installer files. Upload the installer again to restore this app." | Get the original installer from its trusted source and upload it through Intune's app workflow. |
| Apple automated device enrollment tokens and profiles | "The Apple token must be uploaded again in Intune. Its enrollment profiles are kept for reference." | Renew or upload the token through Apple Business Manager or Apple School Manager and Intune. Use the backed-up profiles as a reference. |
| Device configuration profiles with a masked OMA-URI secret | "This backup holds a masked OMA-URI value (****). Create a new backup to restore it; restoring would send **** to devices." | Run a new backup, then restore from it. |
| The tenant default enrollment configuration | "This is the tenant default. Restore updates it in place." | Use **Replace in place**. The default cannot be copied. |
| The default Company Portal branding | "This is the default branding. Restore updates it in place." | Use **Replace in place**. |
| Compliance policies whose snapshot has no block action | "This compliance snapshot is missing its required block action. Create a new complete backup before restoring." | Run a new, complete backup and restore from it. |
| Unverified legacy snapshots | "This snapshot is not authenticated. Review its content and restore a copy; replacement is blocked." | Review the snapshot content and restore a copy instead of replacing. |
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

### What backups cannot contain

Intune does not export some data, so no backup can hold it:

* Installer payloads of apps
* Apple enrollment and content tokens
* Private keys and other secret material that the Microsoft Graph API does not return

Built-in scope tags and built-in Intune roles are not backed up, because they exist in every tenant.

### Other behavior to know about

* **Android Enterprise enrollment profiles** that are recreated get a new enrollment token that is valid for 90 days. A replace in place keeps the live token.
* **Types with limited assignment restore.** Windows Autopilot deployment profiles, Apple user enrollment profiles, terms and conditions and Intune roles cannot have their assignments replaced in place. See [Restore modes and assignments](/restore/modes/#types-that-need-assignments-reconciled-in-intune).
* **Exclusions.** Enrollment configurations and terms and conditions do not accept exclusion assignments, so exclusions are left out when their assignments are restored.
* **Cross-tenant copies** are always unassigned and get the Default scope tag. See [Restore to another tenant](/restore/cross-tenant/).

## Incomplete restores

Many Intune objects are created in several steps: the object first, then its settings, categories, localized messages or assignments. If the object is created or updated but a later step fails, the result is an incomplete object, not a success. The results list shows "Incomplete object: *ID*."

* When the failure is safe to retry, **Retry failed items** repairs the remaining steps against the same object instead of creating another one. Repair is available for one hour in the same app session.
* For a replace in place, the repair first checks that the live object has not changed since the failure. If it has, the repair stops with "The live object changed after the failed restore. Review it and start a fresh replacement."
* If the repair window has passed or the app was restarted, the retry reports "Repair is unavailable or expired. Check the existing object in Intune; do not create another copy." Complete the object in Intune.

## Restore write history

When TenuVault sends a write to Microsoft Graph and the response is lost (a timeout, dropped connection or server error), it cannot know whether Intune applied the change. Repeating the write blindly could create a duplicate object. TenuVault therefore records every restore write in an encrypted journal on your device, and blocks an identical write whose outcome is uncertain until you resolve it.

A blocked write fails with "A previous write has an uncertain outcome. Reconcile it in Settings before retrying." In the wizard, affected items show "Outcome unknown. Check Intune before attempting another restore." or "Check this item in Intune before retrying; a write may already have completed."

The journal stores the method, target path, tenant, time, a short policy name and the object ID when known. It never stores full request payloads or access tokens. OpenIntuneBaseline deployments and drift fixes use the same protection.

### Open the history

1. Go to **Settings** > **Storage and recovery**.
2. Under **Restore history tenant**, select the tenant.
3. The **Restore write history** card lists every recorded write for that tenant, newest first. Click **Refresh history** to reload it.

Opening or changing the history requires the tenant's stored sign-in, an active license, and live Intune management access for that tenant. Records of other tenants are never shown.

Each record shows the policy name (or "Object name unavailable"), the time, its state, the tenant, the request method and path, and the object ID if known. States are:

| State | Meaning |
| --- | --- |
| `complete` | The write succeeded. |
| `uncertain` | The response was lost. The same write is blocked until you resolve it. |
| `reconciled` | You confirmed the write was applied and recorded its object ID. |

### Resolve an uncertain write

1. Open the Intune admin center for the tenant shown in the record and look for the object named in the record.
2. Choose the action that matches what you found:
   * **Confirm applied**: the object exists. Enter its object ID when asked. A later retry reuses this result instead of sending the write again.
   * **Confirm not applied**: the object does not exist. Confirm "I checked the target tenant in Intune and confirmed this request was NOT applied. Allow another attempt?" The next retry sends the write again.
3. Retry the restore from the wizard.

:::caution
Do not confirm a write as not applied just because its response was lost. Check Intune first. Confirming wrongly can create a duplicate object.
:::

### Fix a reconciled write

Reconciled records offer two actions:

* **Correct applied ID** fixes a mistaken object ID without allowing another create. After you enter the corrected ID, the next retry reads the object and verifies its creation fields before any follow-up writes.
* **Allow a new operation** clears the record so an identical request can be sent again. Use it only for a genuinely new operation, and never while you are resuming a repair.

When a retry reuses a reconciled creation, TenuVault reads the object in the recorded tenant and checks its ID and the fields from the original request before continuing. If they do not match or cannot be read, it stops with "The reconciled object does not match the original creation request, or its fields cannot be verified. No follow-up writes were sent. Review the ID and complete recovery manually in Intune." Some policy types then need manual completion in Intune.

### Journal size

The journal keeps up to 1,000 records. When it is full, TenuVault removes completed records and reconciliations older than one hour. Uncertain writes are never removed. If only uncertain and recent records remain, restores stop with "Restore journal is full. Review write history in Settings before continuing; recent reconciliations stay protected for one hour." Resolve the uncertain records to continue.

## Related pages

* [Restore items](/restore/)
* [Disaster recovery](/restore/disaster-recovery/)
* [What gets backed up](/backups/coverage/)
* [Troubleshooting](/troubleshooting/)
