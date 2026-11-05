---
title: "Get started: your first Intune backup"
description: Install TenuVault and take your first encrypted Microsoft Intune backup in about 10 minutes, on Windows or macOS.
---

This section takes you from a fresh computer to a first successful Intune backup. Follow the pages in order; each one ends where the next one starts.

## Before you begin

Check the [Requirements](/getting-started/requirements/) first. In short, you need:

* A Windows or macOS computer.
* An admin account with an Intune role, such as Intune Administrator.
* Someone who can create an app registration and grant admin consent in Microsoft Entra ID, once per tenant.
* Outbound HTTPS access to Microsoft and to www.tenuvault.com.

## Setup checklist

| Step | What you do | Where |
| --- | --- | --- |
| 1 | Download and install TenuVault. | [Install and update TenuVault](/getting-started/install/) |
| 2 | Start TenuVault and select **Connect your tenant**. Optionally start the free Pro trial or enter a license key. | [Start TenuVault for the first time](/getting-started/first-launch/) |
| 3 | On the **Prepare** step, run the setup script that creates the app registration in your tenant, and copy the two lines it prints. | [Create the app registration](/getting-started/app-registration/) |
| 4 | Paste the two lines and sign in to your tenant with your own admin account. | [Sign in to your tenant](/getting-started/connect-tenant/) |
| 5 | Choose whether backups stay on this device or go to your Azure storage account, and save your recovery key. | [Choose where backups are stored](/getting-started/choose-storage/) |
| 6 | Run the first backup, then turn on automatic backups. | [Run your first backup](/getting-started/first-backup/) |

:::note
Steps 3 to 6 happen in the app's guided setup, **Set up TenuVault**, which walks you through **Prepare**, **Sign in**, **Storage** and **First backup**. The setup saves your progress, so you can close TenuVault, for example while another administrator creates the app registration, and continue later. The pages in this section explain each screen in detail.
:::

## After your first backup

* [Schedule backups](/backups/schedules/) so they run without you.
* [Save your recovery key](/security/encryption/) somewhere safe, if you have not already.
* Read [Security and privacy](/security/) to understand what TenuVault can access.
* Roll TenuVault out to other admins with [Deploy TenuVault in your organization](/deploy/).
