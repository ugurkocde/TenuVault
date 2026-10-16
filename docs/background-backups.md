# Background execution

Install background launch in Settings on a packaged Windows or macOS app. This is a per-user
launcher, not a system service: it runs under the same logged-in OS account that owns the encrypted
credentials and backup keys. Installation and removal use the OS task APIs; no password is stored.

Windows uses a Task Scheduler task with an interactive, limited principal, a logon trigger and a
five-minute repeating trigger. macOS uses a user LaunchAgent restricted to the Aqua session, loaded
at login and every five minutes. Both launch the installed executable with `--hidden`. Repeated
launches use the app's single-instance lock and do not open another window or backup engine.

The existing scheduler catches up the latest missed slot after launch. It serializes scheduled runs,
and the backup engine prevents concurrent jobs for the same tenant. A failed scheduled backup is recorded and
retried 15 minutes after the attempt finishes, up to three attempts per slot, then at the next scheduled
slot; reopening the process does not reset its last attempt. Microsoft
credentials, current plan entitlement and the configured storage must remain available. Expired
sessions requiring interaction fail with a sign-in request; no OS task bypasses Conditional Access,
MFA, licensing, or encryption.

The launcher does not run while logged off, asleep or powered off. After restart it resumes when the
same user logs in. It does not provide a headless service identity or guaranteed execution at an exact
wall-clock time. Wake timers and unattended sign-in are not installed. Linux and development builds
do not offer this control.

To stop automatic relaunch, remove background launch and turn off Start at login before quitting the app. Removal leaves the
backup schedules intact and does not terminate an active backup. Turning off Start at login alone
does not remove the separate periodic task. Reinstall the launcher after moving the application.

Tests cover platform configuration, user-session restrictions, installation/removal boundaries,
unsupported platforms, scheduler catch-up, overlap and failed runs. Full OS logoff and restart
behavior requires testing on the target installed operating system; it is not simulated by a successful
unit test or packaging check.

The macOS agent runs a short-lived `/bin/sh` helper; it does not own the TenuVault
process. The helper exits when this user already runs the app's executable (`ps -o comm=`),
and otherwise runs `/usr/bin/open -n -g -j` with `--hidden` through Launch Services.
A plain `open` of a running app sends it a reopen event, which Electron reports as
`activate` and which shows and focuses the window, so the helper never sends one: when
the process check misses (it compares `argv[0]`) or the app starts in between, the new
instance loses the single-instance lock and exits. At startup the app replaces the
reopening agent of earlier builds for the same bundle, and puts it back if launchd
refuses the replacement. Removal unloads this helper, so active app
work continues. Reinstall detects a moved application bundle and replaces its stale
helper definition. Removing a pre-release direct-process agent disables future loads
and deletes its definition without unloading the running app. After removal, sign out
and back in before reinstalling to clear that obsolete session definition safely.
