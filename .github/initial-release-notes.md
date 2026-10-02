# Meet TenuVault 0.2.0

## Changes

**The first official public release of TenuVault.**

Back up, restore and review your Microsoft Intune configuration from a desktop app for **Windows and macOS**. Keep your backups in storage you control, see exactly what changed, and recover with a reviewed plan.

[Get started](https://docs.tenuvault.com/getting-started/) · [Documentation](https://docs.tenuvault.com/) · [Plans and features](https://docs.tenuvault.com/licensing/) · [Website](https://tenuvault.com)

![TenuVault dashboard](https://raw.githubusercontent.com/ugurkocde/TenuVault/v0.2.0/docs/screenshots/dashboard-light.webp)
*Dashboard preview with fictional demo data.*

## Download TenuVault

| Platform | Download |
| :--- | :--- |
| **Windows** | [Setup for x64 and Arm64](https://github.com/ugurkocde/TenuVault/releases/download/v0.2.0/TenuVault-0.2.0-win.exe) |
| **macOS · Apple silicon** | [Download DMG](https://github.com/ugurkocde/TenuVault/releases/download/v0.2.0/TenuVault-0.2.0-mac-arm64.dmg) |
| **macOS · Intel** | [Download DMG](https://github.com/ugurkocde/TenuVault/releases/download/v0.2.0/TenuVault-0.2.0-mac-x64.dmg) |
| **Managed Windows deployment** | [x64 MSI for Intune and Configuration Manager](https://github.com/ugurkocde/TenuVault/releases/download/v0.2.0/TenuVault-0.2.0-win-x64.msi) |

Windows installers are signed. macOS apps are signed and notarized by Apple. Architecture-specific Windows installers and macOS ZIP files are also available under **Assets**.

## 🗄️ Back up your Intune configuration

- **On-demand backups** with a scope picker for the configuration you want to protect.
- **Broad configuration coverage:** Settings Catalog, device configuration, Administrative Templates, compliance, endpoint security, scripts and remediations, update profiles, apps and app protection, enrollment, and tenant administration. Supported assignments are included with their policies.
- **Scheduled backups:** weekly scheduling in Community, with daily scheduling in Pro and MSP. Run in the background while the app is open or in the system tray, with optional start at login and catch-up after a missed schedule.
- **Storage you control:** encrypted backups on your device, or your own Azure storage account with Pro and MSP.
- **Backup history and retention:** browse snapshots, inspect individual objects, choose retention, and export complete backups as ZIP files.

[Explore backup coverage →](https://docs.tenuvault.com/backups/coverage/)

## ↩️ Restore with a clear view of the changes

- **Create separate policy copies** to inspect or recover configuration without replacing the original policy.
- **Restore multiple items, replace supported policies in place, recreate deleted items, and restore supported assignments** with Pro and MSP.
- **Review before applying:** see which items match, which will be overwritten, and which need to be recreated.
- **Dependency-aware recovery:** restore supporting objects before the policies that reference them and review per-item results.
- **Recovery readiness:** identify missing mappings, external artifacts and manual steps before a restore.
- **Cross-tenant copies for MSPs:** copy configuration into connected target tenants as unassigned policies, with reviewed dependencies.
- **Portable recovery:** save and import recovery keys and import complete backup ZIP exports into local storage for review and restore.

[Explore restore and recovery →](https://docs.tenuvault.com/restore/)

## 🔎 Detect drift and understand what changed

- Compare backup snapshots and inspect added, removed and modified configuration down to individual settings.
- Filter findings and export results as **JSON or CSV**.
- Restore an earlier version as a copy, or revert supported drifted policies in place with Pro and MSP.
- Use the tenant dashboard to see backup health, recent activity, protected policies and drift status.

[Explore drift detection →](https://docs.tenuvault.com/drift/)

## 🧩 Deploy and maintain OpenIntuneBaseline

- **New Deployment**, **Existing Deployment comparison** and **Policy Validation** for Windows, macOS, Windows 365 and BYOD.
- Load the current upstream OpenIntuneBaseline content, review the selection, and back up before deployment.
- Create new policies unassigned, with per-run undo.
- Update outdated policies in place and fix policy drift with Pro and MSP.
- Deploy to additional connected tenants with MSP.

[Explore OpenIntuneBaseline →](https://docs.tenuvault.com/baselines/quick-start/)

## 📐 Compare configuration with security frameworks

- **Ten built-in technical mappings:** NIST CSF 2.0, NIST SP 800-53 Rev. 5, NIST SP 800-171 Rev. 2 and Rev. 3, ASD Essential Eight, Cyber Essentials, ISO/IEC 27001:2022, SOC 2, BSI IT-Grundschutz and UK MOD Def Stan 05-138.
- Compare against the **UK NCSC Device Security Guidance** Windows pack.
- Import your own reviewed policy packs for **Microsoft Security Baselines, DISA STIG and Custom Baselines**.
- Inspect expected and observed settings, source policies, assignment evidence and collection gaps.
- Export **PDF reports, CSV and JSON** locally. These non-CIS comparisons and reports are included in Community.
- For supported imported policy packs, create missing settings as new, unassigned policies.

Framework results describe configuration evidence. They do not certify compliance or prove device enforcement. **CIS Benchmarks and CIS Controls are marked Coming soon and are unavailable in this release.**

[Explore framework coverage →](https://docs.tenuvault.com/baselines/frameworks/)

## 🛠️ Build your own company baseline

With **My baselines** in Pro and MSP:

- Start from OpenIntuneBaseline or the Settings Catalog policies in a complete tenant backup.
- Edit settings and policies in versioned baselines, with change notes and retained history.
- Compare your baseline with a tenant or supported framework.
- Review upstream OIB updates with a three-way comparison that preserves your customizations and highlights conflicts.
- Deploy through a reviewed change set, with a backup first, write verification and reviewed rollback.

[Explore My baselines →](https://docs.tenuvault.com/baselines/custom-baselines/)

## 📋 Review governance, changes and operational health

Pro and MSP include dedicated workspaces for:

- **Baseline scores:** summarize saved native framework comparisons, show evaluated coverage and unknowns separately, and follow comparable assessment trends.
- **Conflicts and hygiene:** find candidate conflicting settings, duplicate profiles, unassigned policies and broken references. Record acknowledgements or false positives with a reason, without automatically changing policies.
- **Standards and customizations:** record organization-specific baseline choices. MSP adds reusable, versioned standards with separate customer overlays and exceptions.
- **Dev to Prod:** promote selected Settings Catalog policies between tenants through reviewed change sets, with a backup and a fresh target check before applying. Assignments are excluded.
- **Baseline upgrades:** compare upstream updates with your local changes, resolve conflicts, and apply through a confirmed change set with backup and read-back.
- **Health review:** schedule checks for stale backups and opt into notifications to an endpoint you configure, with a preview of what is sent. Reviews run while TenuVault is running.

## 🏢 Work across tenants and keep operation history

- Connect tenants with guided setup, switch between them, and organize them with names and tags.
- See sign-in, licensing, storage and scheduling status from the **All tenants** overview.
- Run **Backup Selected** and **Check all** drift comparisons across tenants with MSP.
- Review TenuVault's operation history with Pro and MSP: actor, action, affected resource and success, partial or failure results.
- Search, filter and export that history as JSON or CSV.
- Share a Pro or MSP license with other admins in the same tenant without sharing the license key.

[Explore tenant management →](https://docs.tenuvault.com/tenants/) · [Explore the audit log →](https://docs.tenuvault.com/audit-log/)

## 🔐 Built for your admin workstation

- Sign in with your own admin account through an app registration in your tenant, without a client secret. Your MFA and Conditional Access requirements apply.
- Tenant configuration and Microsoft access tokens stay between your device, Microsoft and your chosen storage. License verification is handled separately.
- Local backups use **AES-256-GCM**, with key protection from Windows DPAPI or the macOS Keychain.
- Export a recovery-key bundle so encrypted backups can be recovered on another device.
- Deploy through your organization's tooling and control automatic updates with Windows or macOS policy.

[Explore security and data flows →](https://docs.tenuvault.com/security/)

## 🔄 Stable releases and optional nightlies

Stable **0.2.0** is the default channel. To try previews between stable releases, enable **Settings → Updates → Get nightly builds**. When a download is ready, choose **Restart and update**.

Turn nightly builds off to return to the current stable release, even when it is older than the installed nightly. Switching channels replaces the pending update with the release from your selected channel.

**Managed deployment:** Windows MSI installations do not self-update. Deploy newer MSI versions through your software distribution process. Administrator update policies also apply to the setup installer and macOS app.

## Start free

**Community** includes one tenant, manual and weekly backups, encrypted local storage, backup comparisons, drift detection, single-item copy restore, OIB deployment of new policies, and non-CIS framework comparisons and reports.

**Pro** adds daily backups, Azure storage, advanced restore, audit-log access, OIB maintenance and My baselines for two tenants. **MSP** adds multi-tenant workflows and the tenant capacity in your subscription. Pro and MSP offer a **30-day trial**.

[Compare plans](https://docs.tenuvault.com/licensing/) · [Install and connect your first tenant](https://docs.tenuvault.com/getting-started/)

> **Recovery scope:** Microsoft Graph cannot export every installer payload, certificate, token or secret. Some configuration requires manual recovery or has type-specific restore limits. Review [backup coverage](https://docs.tenuvault.com/backups/coverage/) and [restore limitations](https://docs.tenuvault.com/restore/limitations/) when planning recovery. Scheduled backups require the device and app to be running.
