# Reverse trial: every new tenant starts on Pro for 14 days

## Goal

Every tenant newly connected in the app gets 14 days of Pro automatically: no email, no card, no form.
The admin can extend once by 14 days (28 days in total). Afterwards the tenant falls back to Community
Free. Nothing the admin already has is deleted, and nothing stops without being announced first. One
trial per Entra tenant, enforced by the license server.

Non-goals: no telemetry (the trust and privacy pages keep saying "no telemetry"), no change to paid
plans or prices.

## Existing customers and keys

- **Not affected:**
  - paid Pro and MSP keys, including the free (100% discount) MSP licenses;
  - email trial keys already issued, which keep their 30 days and end on their original date;
  - existing Community tenants, which get no automatic trial, only an optional one-click "Try Pro for
    14 days".
- **Affected, for the better:** the Phase 0 downgrade rules apply to everyone whose Pro ends (current
  email trials and lapsed paid keys), once they run the Phase 0 release.
- **Tenants that had an email trial:** once their key has ended they may use the one-click opt-in
  once (decision 4). From launch on, activating a trial key on a tenant marks that tenant's trial as
  used, so new double trials are not possible.
- **Guards for existing users:**
  - Recording a conversion (`converted_at`) or a used trial is best effort. It can never fail or
    delay a paid activation or refresh.
  - If the trial table cannot be read, `/tenant` answers exactly as today (`tenant_not_licensed` for
    a tenant without an organization license), never with a new error.
  - Route tests cover the organization license path and the paid `activate` path with the trial
    table missing, unreachable and empty.
  - `TENANT_TRIAL_ENABLED=false` stops new trials without changing anything else.

## Design

How it works today, which the design builds on:

- A tenant without a key calls `POST /api/desktop-license/tenant` with a verified Microsoft ID token.
  The tenant comes from the token's `tid`. Without an organization license the server refuses with
  `tenant_not_licensed`, and the app then puts the tenant on Community locally. The app stores
  nothing for a Community tenant and rechecks every 6 hours.
- The app accepts an entitlement token only when it matches a stored activation: the same tenant ID,
  install ID and activation ID (`service.ts:288`).
- A refused refresh with a lapsed reason (`expired`, `tenant_not_licensed`, and so on) drops the
  activation and moves the tenant to Community. Network errors never do.

The reverse trial adds a third kind of activation next to `key` and `tenant`:

- New `/tenant` actions start, refresh, extend and end a trial. The server keeps one row per tenant in
  a new Supabase table, keyed by an HMAC of the tenant ID.
- `start_trial` answers with a signed v2 token (`plan: "pro"`, `trial: true`, `keyExp` = trial end)
  and an activation ID. The app stores it as an activation with `source: "trial"`.
- The 6 hourly refresh renews the token while the trial runs. When it has ended, the server refuses
  with `expired`, and the app falls back to Community through the existing path. The app also ends a
  trial at `keyExp` offline, as it does today.
- No Polar customer or license key is created, because Polar customers need an email.

## Phase 0: announce and soften the downgrade (app, its own release, as soon as possible)

Needed for today's email trial users as well, whose trials start ending in early December. Today a
daily schedule is refused on every run, and alerts, health review and change reports stop silently.

1. **A daily schedule runs weekly on Community instead of being refused.**
   - Today: `index.ts:727-742` refuses every scheduled run of a daily schedule with
     `PlanRequired("dailySchedule")`.
   - New: on Community the schedule runs once a week at its saved time. The weekday is the weekday of
     the first slot after the plan ended, stored with the schedule as `fallbackWeekday`.
   - The saved daily schedule is kept, so buying Pro restores it and clears `fallbackWeekday`.
   - The schedule shows "Runs weekly on Community (daily needs Pro)". One notice is shown when the
     fallback starts.
2. **Azure storage tenants get a paused state and a way out.**
   - Community cannot write to Azure storage, so scheduled runs stop. That rule stays.
   - The schedule shows "Paused: Azure storage needs Pro" instead of a failure on every run.
   - One click offers "Switch to weekly local backups". Listing and single-item restore from Azure
     stay available, as today.
3. **Features that stop say so.**
   - Notifications and alerts, health review and change reports return early without a trace today
     (`notifications/producers.ts`, `health-review/service.ts:383-389`, `reports/index.ts:539-543`).
   - Each of these pages shows "Paused on Community" with a link to the plan.
4. **The admin picks the Community tenant.**
   - Today the first unlicensed tenant to be used claims `license.communityTenant`
     (`service.ts:1204-1215`), and it can only change by removing that tenant.
   - New: when a plan ends and more than one tenant is left without cover, a picker asks which
     tenant continues on Community.
   - The other tenants stay locked as today. Their backups are not deleted, and the app says so:
     "Backups of this tenant are kept. Add a license to use it again."
5. **Tests:** fake-timer tests for a trial key and a paid key that end, with a daily schedule, an
   Azure storage tenant and two tenants. Renderer tests for the notices and the picker.

Not in Phase 0 (see "Follow-ups"): changes to retention, and read-only access to locked tenants.

## Phase 1: server (website repo)

1. **Migration `desktop_tenant_trials`** (RLS on, no policies, like the other tables):
   - `tenant_hash` text PK: HMAC-SHA256(`TENANT_TRIAL_PEPPER`, lowercase tenant ID)
   - `install_hash`: HMAC of the install that started the trial, for the per-install cap
   - `started_at`, `ends_at`, `extended_at`, `ended_early_at`, `converted_at`
   - `source` (`auto` | `opt-in` | `key`), `app_version`
   - Rows are deleted 24 months after `ends_at`, matching `desktop_trial_signups`.
   - `TENANT_TRIAL_PEPPER` is a sensitive Vercel variable. It must never be rotated: a new value
     makes every tenant look new.
2. **`/tenant` route, new actions.** All need the verified ID token, as the route does today.
   - `start_trial`:
     - no row for the tenant: create it and answer with the trial entitlement and activation ID;
     - a running trial exists (another install or admin of the same tenant): join it, with the same
       end date;
     - otherwise refuse with `trial_unavailable` and a reason: `used` (a trial ended or was ended
       early), `licensed` (the tenant has an organization license mapping), `install_limit` (this
       install already started 2 trials), `disabled` (kill switch), `app_update_required`.
   - `refresh` with a trial activation ID: a new token while the trial runs, `expired` after it.
   - `extend_trial`: once per tenant, +14 days, in the last 5 days of the trial or the first 14 days
     after its end.
   - `end_trial`: the admin chose "Use Community instead". Sets `ended_early_at`. The trial counts as
     used.
   - `trial_contact` (see Phase 2.4): stores an optional email address for the trial.
3. **Rules and constants:**
   - `TENANT_TRIAL_DAYS = 14` and `TENANT_TRIAL_EXTENSION_DAYS = 14`, in one place on the server. The
     app shows days left from `keyExp` and never hard-codes the length.
   - `TENANT_TRIAL_MIN_APP_VERSION` is the Phase 2 release. Only that release and later call
     `start_trial`, and it contains Phase 0.
   - The server cannot see whether a tenant uses an unshared paid key, so that check is in the app:
     it never calls `start_trial` for a tenant that has a key or an activation.
   - The per-install cap is a courtesy limit. An install ID can be reset by wiping app data, so
     nothing relies on it.
4. **Token and activation:**
   - The existing v2 payload: `plan: "pro"`, `tenants: 2`, `trial: true`, `keyExp`, the raw tenant
     and install ID as in every token today, `sub: "trial:<first 16 chars of tenant_hash>"`.
   - `act`: `trial-<first 32 chars of HMAC(tenant ID + install ID)>`. It is derived, so the server
     stores nothing per install.
   - Token lifetime: min(14 days, time to `keyExp`).
5. **Conversion and used trials (both best effort):**
   - When `activate` or a share links a paid key to a tenant, set `converted_at` on its trial row.
   - When an email trial key is activated on a tenant, upsert a row with `source = 'key'`.
6. **Checkout:** `customerFromEntitlement` (`desktop-trial/checkout.ts:75`) looks up the Polar key in
   `sub`. For a `trial:` subject it returns null without calling Polar, so the checkout opens without
   a prefilled customer. Add a test.
7. **Operations:**
   - Kill switch `TENANT_TRIAL_ENABLED`. When off, `start_trial` answers `disabled`; running trials
     continue to their end.
   - The health check fails in production when the pepper is missing.
   - The 15 minute licensing probe (`probeLicensing`) also checks that the trial table can be read.
     The GitHub canary is not extended: it has no Microsoft sign-in, which `/tenant` requires.
   - Rate limits as on the other license routes.
   - Update `contract/desktop-license-contract.json` in both repos together. The daily CI check
     compares them.
8. **Tests:** route tests for every action and refusal reason, joining a running trial, the HMAC,
   the guards from "Existing customers and keys", and that tenant IDs never appear in logs (extend
   `observability.test.ts`).

## Phase 2: app (desktop repo)

1. **When a trial starts:**
   - Automatically, only when a tenant is connected for the first time in this install (it is not in
     the stored `seen` list and holds no Community claim) and has no key or activation.
   - If the server is unreachable or refuses, the tenant continues on Community as today. There is no
     silent retry later: the tenant then counts as existing and gets the one-click button.
   - Existing Community tenants: a one-click "Try Pro for 14 days" on the License page and in plan
     prompts (`start_trial`, source `opt-in`). A refusal shows its reason, for example "This tenant
     already had a Pro trial."
2. **License service:** a third activation source `trial` beside `key` and `tenant`, stored with the
   activation ID from the server. A key activation for the tenant replaces it.
3. **Welcome and onboarding:**
   - `ActivationScreen` copy: "Connect your tenant. New tenants get 14 days of Pro, no card needed."
   - After connecting, a card says: "Pro trial started. 14 days left. Afterwards this tenant
     continues on Community Free. Nothing is deleted and you won't be charged." Buttons: "Got it"
     and "Use Community instead" (`end_trial`).
   - The in-app email trial form (`TrialOrKey`) is removed; "I have a license key" stays.
   - Every hard-coded "30 day" text (for example `PlanPromptButton`) takes the length from the
     server answer or says "free trial".
4. **Optional email, at launch:**
   - The trial card has an optional field, prefilled with the signed-in address but sent only when
     the admin presses the button: "Email me setup tips and a reminder before the trial ends".
   - It calls `trial_contact`. The server stores the address in `desktop_trial_signups` with status
     `tenant-trial`, linked by `tenant_hash`, with the trial end date.
   - The getting-started series and the reminders (5 days and 1 day before the end, and after the
     end) run from that row. Both crons get a branch for rows without a Polar key: they read the
     trial row instead of the key state.
5. **During the trial:**
   - A persistent nav badge "Pro trial · 9 days" that opens the License page.
   - Reminders 5 days and 1 day before the end for tenant trials. Running email trial keys keep
     `[10, 3]`. The reminder lists what will change for this user, computed from their setup: "Your
     daily schedule becomes weekly", "Alerts pause", "You will choose one tenant for Community".
   - "Need more time? Extend 14 days" in the last 5 days and up to 14 days after the end.
6. **At the end:** a one-time screen with the same list, the Phase 0 picker and Azure choice, and the
   buttons "Buy Pro" (existing checkout with `src=app-trial-end`) and "Continue on Community".
7. **Tests:**
   - License service: start, join, each refusal reason, offline expiry, extension, ending early,
     replacement by a key, and no automatic start for seen tenants. Keep the 90/85 coverage floor.
   - Renderer: the card, the badge, the reminders and the trial-end screen.
   - A new fixture `test/fixtures/license/<version>/app-state-tenant-trial.json`.

## Phase 3: copy, docs and privacy (both repos)

- **Privacy page:** new subsection "Pro trial without email" under license checks.
  - Stored: the HMAC of the tenant ID, the HMAC of the installation ID, the trial dates, the app
    version, how it started, and the email address only if the admin chose to send it.
  - Purpose: one trial per tenant, the per-install limit, and the emails the admin asked for. Legal
    basis: legitimate interest, and consent for the emails. Deleted 24 months after the trial ends.
  - Also fix an existing gap: the "trial ended" email is sent but not mentioned in `#free-trial`.
- **Trust page:** no change. "No telemetry" stays true, because starting a trial is a license check.
- **Pricing page:** "Every new tenant starts with 14 days of Pro. No card. Falls back to Community
  Free." The Pro card's "Start free trial" goes to `/trial`.
- **Website trial page and form:**
  - `/trial` becomes "Download, connect your tenant, Pro starts automatically", with Download as the
    main button.
  - The email form becomes optional and changes purpose: "Email me the download link and setup
    guide". It no longer creates a Polar trial key. The address goes to `desktop_trial_signups` with
    status `download-link` and starts the getting-started emails, adjusted to "install and connect
    your tenant".
  - `POST /api/desktop-trial` from older app versions (0.4.x, which still show the in-app email form)
    keeps issuing 30-day keys until most installs run the Phase 2 release (the update feed counts
    show this). After that it answers "Update TenuVault to start your trial".
  - Keys already sent keep working until they expire.
- **All other "30 days" texts:** the pricing page, emails, docs and FAQ say 14 days, or "free trial"
  where the length doesn't matter.
- **Docs site:**
  - `licensing/index.md:19`: "Each email address gets one trial" becomes "one trial per tenant".
  - `licensing/manage.md:116-128`: what happens after the trial (the Phase 0 rules).
- **Internal docs:** website `docs/desktop-trial.md` and `docs/licensing-checks.md`, app
  `docs/license-network-checks.md`.

## Rollout

1. Release A: Phase 0, as soon as it is ready.
2. Server: Phase 1 deployed with `TENANT_TRIAL_ENABLED=false`, and the contract updated in both repos.
3. Release B: Phase 2, together with the Phase 3 website and docs changes.
4. Turn the flag on once Release B is out and the end-to-end run below has passed. No wait for
   adoption is needed, because only Release B and later can start a trial.
5. Kill switch: turn the flag off. No new trials start, and running trials end normally.

## End-to-end verification before turning the flag on

There is no Electron UI test harness, so this is a scripted manual run with the lab tenants, against
a Vercel preview with its own Supabase. Trial dates are changed by editing the row in that preview
database.

1. A fresh install (a VM or a cleaned app-data folder):
   - connect a tenant: the trial starts, the card and the badge show 14 days;
   - connect a second tenant: a second trial starts;
   - a third tenant is refused with `install_limit` and continues as today.
2. A second fresh install on the first tenant joins the running trial with the same end date.
3. Set `ends_at` to 5 days ahead, then 1 day, then the past:
   - both reminders, the extension (the end moves by 14 days, and a second extension is refused);
   - the trial-end screen, the picker, the daily schedule now weekly, the Azure paused state and its
     switch, the paused notices;
   - the backup folder listing is the same before and after.
4. Offline: disconnect the network before `keyExp` and confirm the trial still ends on time.
5. After the end, a reinstall on the same tenant is refused as `used`.
6. "Use Community instead" ends the trial at once, and the tenant cannot start another.
7. Buy Pro in a Polar sandbox checkout during a trial: the key activates, the row is marked
   converted, the badge is gone and the daily schedule is daily again.
8. The optional email: the address is stored only after the button is pressed, and the reminder
   emails follow the trial row.
9. An older app build calling `start_trial` gets `app_update_required`.
10. An existing Community install updated to Release B gets no automatic trial, only the button.
11. Real screenshots of each new screen for the PRs, with the lab tenants only.

## Measuring it

Added to the weekly report, aggregated only. The baseline figures stay in the report, not in this
file.

- trials started (auto, opt-in, joined), per website download;
- ended early, extended, converted, still running;
- share of trials that left an email address.

Review 4 weeks after the flag goes on, against the 4 weeks before:

- **Target:** at least 3 times as many trials per download, and at least 30% of trials leave an email.
- **Stop rule:** turn the flag off if, 8 weeks in, purchases per download are lower than in the
  8 weeks before, or if users report lost backups or schedules after a trial.

## Decisions (recommended defaults in bold)

1. "Use Community instead": **uses up the trial**. The alternative is to allow one later opt-in.
2. Trials started per install: **2**, matching Pro's tenant count.
3. Existing Community tenants: **no automatic trial**, only the one-click opt-in.
4. Tenants that already had an email trial key: **may use the opt-in once** after their key ends (no
   backfill). The alternative is to backfill their tenants as used from Polar activation metadata.
5. Targets and stop rule: **as in "Measuring it"**.

Decided: 14 days plus one 14-day extension; the website email trial key is retired as in Phase 3.

## Follow-ups, not part of this plan

- **Retention for lapsed paid keys.** A customer who kept more than 30 days of history loses the older
  backups on the next backup after their plan ends (`backup/engine.ts:727-800`). Trials are not
  affected, because they are shorter than the Community limit. Fix separately.
- **Read-only access to locked tenants' backups.** It loosens the entitlement gate in
  `fetch-bridge.ts:62-94`, so it needs its own review.
- **MSP features in a trial.** The trial is Pro. MSP prospects still ask for a quote.
