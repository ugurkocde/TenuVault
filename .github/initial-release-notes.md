## Changes

### Desktop backup and recovery

TenuVault brings Intune backup, restore and drift detection into a desktop application for Windows and macOS. Administrators can keep configuration backups on their own machine, compare snapshots, and review restore operations from one interface. The documentation shipped with this source explains supported policy types, permissions, storage and recovery procedures.

### Release channels

Signed Windows installers and signed, notarized macOS builds are distributed from this repository. Stable is the default for stable installations. Enable **Settings > Updates > Get nightly builds** to receive previews between stable releases, such as `0.2.1-nightly.…` after `0.2.0`.

Turn the option off to download the current stable release immediately, even if its version is older than the installed nightly. Changing channels cancels a pending download and replaces any ready update from the previous channel. Select **Restart and update** when the selected release is ready, or let it install when you quit. Ordinary updates within a channel do not downgrade the application.

Windows MSI installations are managed deployments and do not self-update. Deploy a newer MSI through your normal software distribution process. Automatic updates for the setup installer and macOS application also respect the administrator's update policy.

### Repository migration and upgrade notes

This is the first release from the new TenuVault desktop repository, which starts with a clean source history. Earlier development builds point to the previous repository for updates. Install a build from this repository to move to the new update feed; the application identity and package name are unchanged.

The original PowerShell tool is maintained separately at [TenuVault-PowerShell](https://github.com/ugurkocde/TenuVault-PowerShell). The website and desktop licensing service remain separate from this repository.

### Launch verification

While this repository is private, unauthenticated update checks cannot reach its releases. Public-feed access and a complete installed-app update cycle still need verification after the repository is made public. A successful release build and application smoke test do not establish that end-to-end result.
