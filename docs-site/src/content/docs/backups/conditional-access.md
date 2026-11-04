---
title: "Conditional Access backups"
description: Back up, restore and detect drift in Entra Conditional Access policies, named locations and authentication strengths, and the permissions each step needs.
faq:
  - question: "Does TenuVault back up Conditional Access policies?"
    answer: "Yes, as an opt-in service. Turn on Entra Conditional Access for the tenant in Settings, under Services and permissions. TenuVault then backs up Conditional Access policies, named locations and custom authentication strengths with every backup, keeps them as long as your retention allows, and compares them between backups like Intune policies."
  - question: "Which permissions does a Conditional Access backup need?"
    answer: "Backups need the delegated Policy.Read.All permission, which the TenuVault setup script already requests. Restores additionally need Policy.ReadWrite.ConditionalAccess, which the script adds only with -IncludeConditionalAccessRestore. Your account also needs an Entra role: Security Reader or Global Reader to back up, Conditional Access Administrator or Security Administrator to restore."
  - question: "Can a restore lock admins out?"
    answer: "TenuVault restores a policy in report-only mode when it creates it, and never turns on enforcement that a live policy does not have when it replaces it. Before writing, it checks the accounts, groups, named locations and authentication strengths the policy points to, and refuses a policy whose excluded account or group no longer exists."
  - question: "Are Microsoft-managed policies restored?"
    answer: "No. Microsoft creates and maintains them, so TenuVault backs them up for drift detection only and never recreates or overwrites them. Change their state or exclusions in Entra."
---

TenuVault backs up three Entra Conditional Access object types next to your Intune configuration, restores them, and shows how they changed between backups. It complements Microsoft's own Entra backup, which keeps a short history and does not cover Intune: TenuVault keeps Conditional Access with your Intune backups for as long as your retention allows.

## What is included

| Type | Notes |
| --- | --- |
| Conditional Access policies | Every setting: users and groups, roles, apps, conditions, grant and session controls, and state. Microsoft-managed policies are backed up for drift detection only. |
| Named locations | IP ranges and countries, trusted or not. |
| Authentication strengths | Custom authentication strengths with their method combinations and FIDO2 or certificate restrictions. Built-in strengths are the same in every tenant and are skipped. |

The users, groups and apps a policy points to are saved as references; the objects themselves are not part of the backup.

## Turn it on

Conditional Access is a separate service, off for every tenant until you turn it on, so an update never adds Entra policies to your backups unasked.

1. Open **Settings** > **Services and permissions**.
2. Choose the tenant and select **Include in backups** for **Entra Conditional Access**.
3. Check the badges next to it: **Backup** and **Restore** say whether the tenant's app registration has the permissions each needs, and which one is missing.

While the service is on but the app registration cannot read it, backups leave the three types out and name the missing permission in the backup log; they do not fail.

## Permissions

| Step | Delegated Microsoft Graph permission | Entra role of the signed-in admin |
| --- | --- | --- |
| Back up and detect drift | `Policy.Read.All` (requested by default) | Security Reader, Global Reader, Conditional Access Administrator or Security Administrator |
| Restore | `Policy.Read.All` and `Policy.ReadWrite.ConditionalAccess` (opt-in) | Conditional Access Administrator or Security Administrator |

To allow restores in a tenant you already connected, add the permission to its existing TenuVault app registration and grant admin consent. That needs a Global Administrator, Privileged Role Administrator or Cloud Application Administrator. **Services and permissions** offers both ways:

* **Open API permissions in Entra**, then **Add a permission** > **Microsoft Graph** > **Delegated permissions** > `Policy.ReadWrite.ConditionalAccess`, and **Grant admin consent**.
* **Copy Azure CLI commands**, filled in with the tenant and app registration:

```bash
az login --tenant <tenant ID> --allow-no-subscriptions
az ad app permission add --id <application (client) ID> --api 00000003-0000-0000-c000-000000000000 --api-permissions ad902697-1014-4ef5-81ef-2b4301988e8c=Scope
az ad app permission admin-consent --id <application (client) ID>
```

Do not run `New-TenuVaultDesktopApp.ps1` again for this: it always creates a new app registration. Use its `-IncludeConditionalAccessRestore` switch only when you set up a new one.

Then select **Check again** under **Services and permissions**. TenuVault reads the permissions from the sign-in it already has, so it asks Microsoft for nothing new. It cannot see roles you can activate with Privileged Identity Management until you activate them, so a restore your role does not allow is still refused by Microsoft, with a message that names the role.

## How restores stay safe

* **Report-only first.** A policy TenuVault creates, as a copy or because it was deleted, starts in report-only mode, or off when it was off. Check its sign-in impact in Entra, then turn it on.
* **No new enforcement.** Replacing a live policy writes the backed-up settings, but never more enforcement than the policy has now. Putting back an enabled policy that is now off writes report-only.
* **References are checked.** Microsoft Graph accepts IDs of users, groups and named locations that no longer exist without a warning. TenuVault checks them before writing, and refuses a policy whose excluded account or group is gone, because that exclusion (for example of an emergency access account) would protect nobody. A missing named location or authentication strength also stops the policy. What TenuVault has no permission to read, such as users without `User.Read.All`, is listed as a warning to check.
* **Restore order.** Named locations and authentication strengths are restored before policies, and a policy that points to one recreated in the same restore is pointed at the new one.
* **Microsoft-managed policies** are never recreated or overwritten.
* **Review before replacing.** The restore review lists what changes, and warns when a replace removes an exclusion or changes grant or session controls.
* **Other tenants.** A policy copied to another tenant cannot name users, groups or locations of this one. Copy its named locations and authentication strengths in the same run and recreate the users and groups first, or create the policy in Entra.

## Drift detection

Conditional Access changes appear in drift results like Intune changes. A deleted policy, a change to who a policy covers, its state, or its grant or session controls is reported as critical. Revert puts the backed-up version back with the same safety rules as a restore.

## Scheduled backups and sign-in frequency

The Backup Reader exists because Conditional Access session controls, such as sign-in frequency, end the admin sign-in that scheduled backups use at night. See [Conditional Access and TenuVault](/security/conditional-access/).

* To include Conditional Access in scheduled backups made by the [Backup Reader](/backups/backup-reader/), run its script with `-IncludeConditionalAccess`, which grants the read-only `Policy.Read.All` application permission. Without it, scheduled backups leave the three types out and manual backups include them. The Backup Reader never gets permission to change Conditional Access: restores always use your own sign-in.
* A restored policy with a sign-in frequency can, once enforced, end the TenuVault sign-in of the admins it covers. The restore result says so.
* A policy for workload identities can block the Backup Reader. The restore result says so when a restored policy targets workload identities.
* For [cloud backups in Azure](/backups/cloud/), set the Automation variable `TenuVaultIncludeConditionalAccess` to `true` and grant the managed identity `Policy.Read.All`.

## Related pages

* [What gets backed up](/backups/coverage/)
* [App registration and delegated permissions](/security/permissions/)
* [Restore modes and assignments](/restore/modes/)
