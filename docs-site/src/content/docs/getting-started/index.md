---
title: "Get started: your first Intune backup"
description: Install TenuVault and take your first Microsoft Intune backup in a few minutes, on Windows or macOS.
---

This section takes you from a fresh computer to a first successful Intune backup. Follow the pages in order; each one ends where the next one starts.

For an overview before you start, see [Intune backup](https://www.tenuvault.com/intune-backup) on the product site.

## Before you begin

Check the [Requirements](/getting-started/requirements/) first. In short, you need:

* A Windows or macOS computer.
* An admin account with an Intune role, such as Intune Administrator.
* Someone who can create an app registration and grant admin consent in Microsoft Entra ID, once per tenant.
* Outbound HTTPS access to Microsoft and to `www.tenuvault.com`.

<figure class="docs-screenshot">
  <a href="/images/screenshots/dashboard.webp" aria-label="Open full-size screenshot: dashboard">
    <img src="/images/screenshots/dashboard.webp" alt="After setup: the dashboard brings backup status, protected policies and drift into one view" width="2880" height="2000" loading="lazy" decoding="async" />
  </a>
  <figcaption>After setup: the dashboard brings backup status, protected policies and drift into one view. Example tenant data. Select the image to view it full size.</figcaption>
</figure>

## Setup checklist

| Step | What you do | Where |
| --- | --- | --- |
| 1 | Download and install TenuVault. | [Install and update TenuVault](/getting-started/install/) |
| 2 | Start TenuVault and select **Connect your tenant**. A new tenant starts a 14 day Pro trial by itself, no card or email; you can also enter a license key. | [Start TenuVault for the first time](/getting-started/first-launch/) |
| 3 | On the **Connect** step, select **Set up with Microsoft sign-in** and sign in once with your own admin account. TenuVault creates the app registration in your tenant and signs you in. | [Create the app registration](/getting-started/app-registration/) |
| 4 | Only when another administrator created the app registration: paste the two lines they sent and sign in to your tenant with your own admin account. | [Sign in to your tenant](/getting-started/connect-tenant/) |
| 5 | Choose whether backups stay on this device or go to your Azure storage account. | [Choose where backups are stored](/getting-started/choose-storage/) |
| 6 | Run the first backup, then turn on automatic backups. | [Run your first backup](/getting-started/first-backup/) |

:::note
Steps 3 to 6 happen in the app's guided setup, **Set up TenuVault**, which walks you through **Connect**, **Sign in**, **Storage** and **First backup**. The setup saves your progress, so you can close TenuVault, for example while another administrator creates the app registration, and continue later. The pages in this section explain each screen in detail.
:::

## After your first backup

* [Back up Win32 installer content from Intune with free App Backup](/apps/app-backup/), separately from configuration backups.
* [Schedule backups](/backups/schedules/) so they run without you.
* [Save your recovery key](/security/encryption/) somewhere safe, if backups stay on this device.
* Add the other admins of the tenant with [Work with other admins in one tenant](/getting-started/multiple-admins/).
* Read [Security and privacy](/security/) to understand what TenuVault can access.
* Roll TenuVault out to other admins with [Deploy TenuVault in your organization](/deploy/).
