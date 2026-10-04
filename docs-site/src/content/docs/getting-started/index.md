---
title: "Getting started"
description: Go from nothing to your first encrypted Intune backup in about fifteen minutes.
---

This section takes you from a fresh computer to a first successful Intune backup. Follow the pages in order; each one ends where the next one starts.

## Before you begin

Check the [Requirements](/getting-started/requirements/) first. In short, you need:

* A Windows or macOS computer.
* An admin account with an Intune role, such as Intune Administrator.
* Someone who can create an app registration and grant admin consent in Microsoft Entra ID, once per tenant.
* Outbound HTTPS access to Microsoft and to tenuvault.com.

## Setup checklist

| Step | What you do | Where |
| --- | --- | --- |
| 1 | Download and install TenuVault. | [Install and update TenuVault](/getting-started/install/) |
| 2 | Run the setup script that creates the app registration in your tenant, and note the client ID it prints. | [Create the app registration](/getting-started/app-registration/) |
| 3 | Start TenuVault and choose Community, buy Pro or MSP, or enter a license key. | [Choose a plan on first launch](/getting-started/first-launch/) |
| 4 | Sign in to your tenant with your own admin account. | [Sign in to your tenant](/getting-started/connect-tenant/) |
| 5 | Choose whether backups stay on this device or go to your Azure storage account, and save your recovery key. | [Choose where backups are stored](/getting-started/choose-storage/) |
| 6 | Run the first backup and check the result. | [Run your first backup](/getting-started/first-backup/) |

:::note
Steps 3 to 6 happen in the app's guided setup, **Set up TenuVault**, which walks you through **Prepare**, **Sign in**, **Storage** and **First backup**. The pages in this section explain each screen in detail.
:::

## After your first backup

* [Schedule backups](/backups/schedules/) so they run without you.
* [Save your recovery key](/security/encryption/) somewhere safe, if you have not already.
* Read [Security and privacy](/security/) to understand what TenuVault can access.
* Roll TenuVault out to other admins with [Deploy TenuVault in your organization](/deploy/).
