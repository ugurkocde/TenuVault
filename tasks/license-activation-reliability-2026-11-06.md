# License activation reliability (2026-11-06)

Goal: a customer who pays at Polar checkout, receives a key by email, and pastes it into the app
always becomes entitled for the tenant they are signed in to. Nightlies ship on every green push
to `main` and stable releases every 2 to 3 days, so every item below must be guarded by an
automated gate, not by care.

Sources: two independent read-only reviews of this repo and of the licensing service in
`tenuvault-website` (desktop d83eb5a, website 63a2037). Findings marked "verified" were
re-checked against the code after the reviews. Nothing in Polar, Vercel, or GitHub settings was
inspected live; those items are listed as unverified.

Implementation status (2026-11-06): first round merged as #288 (this plan, invariants, CODEOWNERS,
coverage floor), #289 (task 1 desktop gate), #290 (tasks 2 and 7, desktop halves), #291 (task 18),
#292 (tasks 3 desktop half and 12), and TenuVault-Website #87 (tasks 8 and 9 website half). Second
round: #294 (tasks 7 and 9, desktop), #295 (task 19), #296 (task 10, desktop), #300 (task 15, task
13 docs), #298 (tasks 11, 14, 16 soak, task 5 record), #299 (task 6, desktop), and
TenuVault-Website #88 (tasks 1, 2, 3 and 4, website), #89 (task 13), #90 (task 6, website) and #91
(task 10, website). Third round (2026-11-07): the licensing canary and the MITM record (tasks 4,
5 and 20), and the email ownership note on the Polar checkout (task 13). What remains needs the
owner in person: Polar's key email in an inbox (task 5), a backup of the signing key (task 14) and
the web-filter vendor portals (task 20), each noted below.

## Confirmed model (both reviews agree)

- The Polar checkout email has no effect on activation. The key is a bearer credential.
  Activation binds the key to (tenantId, installId) of whoever activates
  (desktop `src/main/license/service.ts:550`, website `src/lib/desktop-license/service.ts:342`).
  No email, UPN, or OID comparison exists anywhere in the activation, refresh, tenant, trial, or
  checkout paths.
- The Microsoft ID token is fully signature and freshness verified, but only its `tid` and `aud`
  are compared, and only to authorize sharing the license with the tenant's other admins. No
  particular person or admin role is required.
- Email identity matters only in Polar: key delivery, invoices, and customer portal access belong
  to the checkout email. "Buy Pro" from a trial creates the checkout for the trial's Polar
  customer, so Polar locks that email (website `src/lib/desktop-trial/checkout.ts:17`).
- Re-activating the same (installId, tenantId) reuses the existing Polar activation, so retries
  never burn slots (website `src/lib/desktop-license/service.ts:360`).
- Already in place and working: offline grace of 14 days, only a confirmed 403 with a known
  reason drops a cached token, a new token is verified before it replaces the cached one, and a
  15 minute Vercel cron checks licensing configuration and Polar access with alerts.

## P0: can break activation for every buyer, or for a buyer who just paid

- [x] **1. Prove the shipped app carries the production signing key.** (desktop + website,
  verified gap; done: release builds fail on the placeholder or any key whose fingerprint differs
  from the one pinned in `scripts/license-public-key.ts`, read back from the shipped 0.4.2 and
  nightly installers, and the website pins the same fingerprint: its production health check
  fails when the signer differs. That check answered `ok` after deploy, so the live signer is the
  key in the shipped apps. A server-signed golden token through the built verifier was not added:
  the two pinned fingerprints cover the same failure without a production-signed fixture) The build only checks the baked-in key is *an* Ed25519 key
  (`electron.vite.config.ts:43`), the placeholder only warns (line 56), and the release workflow
  only checks the secret is non-empty (`.github/workflows/release.yml:170`). A wrong but valid
  key (sandbox, preview, rotated) passes every gate and every entitlement then fails verification
  on every machine. Unit tests generate their own keypair, and the packaged smoke test only saves
  a key without a tenant, so no signature is ever checked against the built verifier.
  Pin the SHA-256 fingerprint of the production public key in this repo and fail release builds
  on mismatch or placeholder. Verify a real server-signed golden token (fixture tenant and
  install ID, useless elsewhere) through the *built* verifier in the release workflow, on the
  final rebuilt artifact of a stable promotion too. Mirror the fingerprint as a readiness check
  on the website so a signer change there is caught from the other side.
  Acceptance: an unrelated Ed25519 key and the placeholder both fail nightly and stable gates.
- [x] **2. Fix the activation deadline mismatch.** (desktop + website, verified; done: the
  desktop waits `LICENSE_REQUEST_TIMEOUT_MS`, 45 seconds, and the service bounds all Polar calls
  of a request by `LICENSE_BUDGET_MS`, 35 seconds, answering a retryable 502 when it runs out;
  tested with every Polar call slow, and the retry reuses the activation) The desktop
  gives up after 20 seconds (`src/main/license/service.ts:428`). The server allows each Polar
  call 10 seconds (`polar.ts:81`) and the route 60 seconds (`activate/route.ts:7`), and
  activation makes several sequential calls (validate, read, allowance, key details, create,
  re-read). Slow-but-healthy Polar responses therefore abandon an activation that then completes
  on the server: the buyer sees a failure on their very first activation.
  Define one end-to-end budget both sides share: bound the whole server operation below the
  desktop deadline, and give the desktop a waiting state for the full budget instead of a
  failure. Acceptance: a delayed-dependency test where every Polar call is slow still activates
  within budget, and a retry reuses the completed activation.
- [x] **3. Never let trial misclassification hide the paid-key replacement flow.** (desktop +
  website, verified; done: the License page offers "Use a different key" for any active key,
  clipboard pickup no longer depends on the trial flag, production readiness requires
  `DESKTOP_TRIAL_PRODUCT_ID`, and a failed trial lookup alerts the operator instead of passing
  silently. Trial provenance is still read live from Polar rather than recorded: with the
  replacement flow independent of it, a misclassification now only affects trial wording) The website only sets `trial: true` when `DESKTOP_TRIAL_PRODUCT_ID` is
  configured and a Polar product lookup succeeds; on failure it silently omits the flag
  (`service.ts:223`, `http.ts:131`). The desktop then treats the trial key as an ordinary active
  key: the replacement field only shows for a recognized trial or an inactive key
  (`src/renderer/pages/LicensePage.tsx:483`) and the clipboard pickup excludes it too
  (`src/renderer/components/PurchaseKeyWatcher.tsx:17`). A customer who just paid has no way to
  enter the paid key short of deactivating the machine.
  Desktop: always offer safe key replacement whenever a key is saved, independent of trial
  classification (`replaceKey` already changes nothing on refusal). Website: derive trial
  provenance from a recorded source instead of a live lookup, or fail readiness when
  `DESKTOP_TRIAL_PRODUCT_ID` is missing in production.
  Acceptance: an active token without a trial claim can be replaced in place; a lookup outage
  cannot silently relabel a known trial key as paid.
- [x] **4. Extend the existing 15 minute cron into a real buyer canary.** (website + ops,
  verified gap; done: the scheduled check verifies the benefit ids and every request logs an
  outcome line by `appVersion`; and a GitHub workflow every 30 minutes runs the app's own
  `LicenseService` with the pinned production key against production with a dedicated canary
  key: activate, verify offline, refresh, refuse an unknown key, release
  (`docs/license-network-checks.md`). It runs outside Vercel, so it doubles as the heartbeat and
  `LICENSING_HEARTBEAT_URL` stays unset) Today's probe checks configuration presence and Polar access with a nonexistent
  key. It does not prove that a real key can activate, that activation writes are permitted, that
  the configured benefit IDs match the products on sale, or that a shipped desktop build accepts
  the signature. HTTP success alone is not enough: a wrong baked-in key yields successful server
  issuance followed by desktop rejection.
  Add an isolated canary: dedicated Polar (sandbox or flagged production) customer and key, fixed
  install ID, activate, refresh, verify the token signature with the production public key the
  same way the desktop does, deactivate. Alert on any failure, and add an external heartbeat so a
  stopped cron also alerts. Track activation outcomes per `appVersion` server-side (already sent
  by the client) so a bad nightly shows up before stable promotion.
  Acceptance: wrong signer, denied activation write, wrong benefit ID, and a stopped cron each
  produce an alert.
- [ ] **5. Audit the production configuration nobody has verified.** (ops; mostly done: the
  live Polar benefits, products and portal settings, the Vercel variable names and the deployed
  service were checked on 6 November and recorded in `docs/release-setup.md`, whose token scopes
  were corrected. Vercel values are sensitive and cannot be read back, so the service now checks
  them itself. The licensing canary rehearses key to activation against production every 30
  minutes, and the owner's own test purchases show Polar issuing keys from checkout. Owner:
  confirm Polar's key email arrives, which needs the buyer's inbox) Checkout
  and licensing use separate configuration, so customers can pay while activation is broken:
  wrong benefit IDs reject genuine keys as `invalid_key`, a wrong Polar environment yields
  `not_found`, missing benefit or subscription read scopes break MSP quantity resolution.
  `docs/release-setup.md` asks only for license key read and write scopes and does not mention
  the read scopes the code needs; it also states its Polar table is a requirement, not evidence
  of the dashboard.
  Check in the live Polar dashboard: token scopes, Pro and MSP benefit IDs against Vercel env,
  MSP is per-unit pricing (quantity = tenants), activation limits (Pro at least 10, MSP
  unlimited), customer self-deactivation enabled, key email delivery, and portal access. Fix
  `docs/release-setup.md` where it disagrees with the code.
  Acceptance: an owner-observed end-to-end rehearsal, sandbox purchase to in-app activation,
  plus a written record of the production values checked.

## P1: breaks activation for a subset of buyers or tenants

- [x] **6. Stop `replaceKey` from changing tenant sharing before it commits.** (desktop +
  website, verified; done: replacement activations are staged with `shareWithTenant: false`,
  keep the previous choice and publish it after the save, and a trial key can no longer take a
  tenant's mapping from another key) Replacement activates the new key first (`service.ts:803`), and that already
  applies the server sharing default and overwrites the tenant mapping
  (website `service.ts:505`, `tenant-store.ts:59`). A failed swap rolls back activations but not
  the mapping, an explicit opt-out is not carried forward, and another machine still holding the
  old trial key can overwrite the paid mapping on its next refresh, after which organization
  clients carrying the old `licenseKeyId` are refused (website `tenant.ts:107`).
  Stage replacement activations without publishing sharing, then commit the mapping explicitly
  with the previous choice; make the store refuse stale-key overwrites.
  Acceptance: a failed replacement leaves mappings untouched, a successful one preserves an
  opt-out, and an old trial key refresh cannot reclaim a tenant.
- [x] **7. Make key replacement crash-safe.** (desktop, verified; done: damaged stored state
  cannot throw, and the new key is saved with a `pendingRelease` record before anything is
  released; releases are retried after refreshes and before deactivation)
  `replaceKey` releases the old
  activations before persisting the new state (`service.ts:839`). A crash or failed write in
  between restarts with the old key whose activations are gone. Separately, `load()` validates
  only the outer activations object, so a malformed entry reaches `decodeToken`, whose `split`
  runs outside its try/catch (`service.ts:199`, `:293`).
  Persist a recoverable replacement record before releasing anything, validate stored activation
  entries on load, and move the split inside the guard.
  Acceptance: injected crashes and write failures at each boundary recover after restart with at
  least one usable credential.
- [x] **8. Paginate Polar benefit grants.** (website, verified; done: grants are walked page
  by page in TenuVault-Website) MSP tenant quantity is resolved
  from `GET /benefits/:id/grants?limit=100` with no pagination (`polar.ts:190`). A customer
  whose matching grant lands past item 100 gets `tenant_quantity_unknown` and cannot activate.
  Follow pages until the grant is found or the list is exhausted. Product and trial key lookups
  share the pattern.
  Acceptance: a fixture with the grant on page 2 resolves and activates.
- [x] **9. Make rate limiting recoverable for legitimate batches.** (website + desktop,
  verified; done: 429 carries `Retry-After`, and the desktop waits and retries up to twice for
  waits up to 20 seconds, otherwise says when to retry. The 20 per minute allowance is unchanged)
  The licensing routes allow 20 requests per IP per minute (`http.ts:136`). Several admins
  behind one corporate NAT, or an MSP activating many tenants, can exceed it. The desktop treats
  429 as generic unavailability, does not retry, and can leave a key partly activated
  (`service.ts:473`, `:738`).
  Return `Retry-After`, review the allowance, and add bounded desktop retries that name the
  affected tenants.
  Acceptance: a throttled multi-tenant activation completes without re-entering the key.
- [x] **10. Share one executable contract between the two repos.** (both, verified gap; done:
  `test/fixtures/license-contract.json` here and `contract/desktop-license-contract.json` in the
  website, byte-identical, with tokens from the service's own signer, each tested by its side.
  The website's CI fails when the copies differ, on every push and daily, so drift from either
  side fails there; this repository's CI cannot read the private website repository, so it does
  not fail on its own. That fits the client-first rule: changes start here) Token
  versions, refusal reason strings, and response shapes currently match, and the website gates
  v2 tokens on `appVersion` (website `service.ts:204`), but no test runs the other side's code. A
  payload or reason change can pass both suites and break fresh activation everywhere.
  Check golden fixtures into both repos: activate, refresh, deactivate, and tenant requests and
  responses, and signed tokens (v1, v2, trial, renewing with null `keyExp`) issued by the real
  server code, byte-identical copies in each repo so CI on either side fails on drift. Rules:
  new token versions ship in the client one stable before the server emits them, reasons are
  add-only, client first.
  Acceptance: changing a fixture in one repo fails the other repo's CI until updated.
- [x] **11. Freeze released on-disk license state as fixtures.** (desktop, verified gap; done:
  `test/fixtures/license/v0.4.2`, written by the released 0.4.2 code itself, loaded offline by
  `test/license-upgrade.test.ts`. The OS encryption layer cannot be reproduced in CI. The reverse
  direction is only partly met: an older app keeps a newer state entitled, but it drops a
  `pendingRelease` record when it saves, after which those replaced-key activations can only be
  released in the customer portal) Tests
  cover legacy cleanup, restarts over the same store, and v1/v2 tokens, but nothing loads bytes
  written by a previous release. A store format, `userData` path, or macOS signing identity
  change would lose the key and burn an installation slot on upgrade.
  Capture the serialized `license.state`, `license.installId`, and secure store format from the
  current stable, assert new code loads it as entitled offline, and never delete old fixtures.
  Pin the literal state keys in a test.
  Acceptance: every supported upgrade path keeps installation identity and entitlement; the
  reverse (newer state, older app) either works or reports an explicit compatibility error
  without destroying the state.
- [x] **12. Close the first-purchase clipboard gap.** (desktop, verified; done with task 3's
  desktop half: pickup inside the checkout window now includes the License page) After opening checkout
  with no saved key, the purchase watcher excludes the License page
  (`PurchaseKeyWatcher.tsx:24`), and that page's own watcher only arms after a trial request
  (`LicensePage.tsx:323`). A first-time buyer returning there gets no pickup and must paste
  manually.
  Arm the same single pickup on the License page within the 6 hour checkout window.
  Acceptance: one copied paid key triggers exactly one activation attempt on return.
- [x] **13. Tell buyers which email does what.** (website + docs, from the email analysis; done
  on the pricing and support pages, the trial and first getting-started emails, and the docs
  site, and in the descriptions of the six products sold through Polar checkout, where it shows
  next to the email field. Polar's own key email cannot carry it) The
  key binds to the tenant signed in to the app, whoever enters it, while billing, invoices, key
  retrieval, and the Polar portal belong to the checkout email. A buyer who pays with a finance
  or personal mailbox and loses that email currently has no way to recover the key (the app only
  shows the last four characters).
  Add one line at checkout and in the purchase and trial emails: the key can be activated by a
  different admin; use an address here that should own billing and keep the key. Note the same
  in the licensing docs, with the support recovery path starting at the checkout inbox.
  Acceptance: the copy is live in checkout, both emails, and docs-site licensing pages.

## P2: preventive, do before the situation exists

- [x] **14. Support overlapping signing keys before any rotation.** (both, verified; done: the app
  trusts a key ring, `ROTATION_LICENSE_PUBLIC_KEYS`, and `docs/release-setup.md` has the rotation
  runbook. Owner: keep an offline backup of the production private key and test restoring it. On
  2026-11-07 no copy existed on the maintainer machine and Vercel keeps the value write-only, so
  losing the Vercel variable would force a rotation by that runbook) The desktop
  trusts exactly one public key and the website signs with one private key. Rotating either side
  first blocks fresh activation on the entire installed base that has not updated; cached tokens
  only soften this for existing tenants. The rotation note in `docs/release-setup.md:113` does
  not cover the ordering problem.
  Accept a small key ring in the desktop (current plus next), ship it, then switch the signer,
  then retire the old key after the longest issued token (14 days) plus the oldest supported app
  version. Keep an offline backup of the private key and test restoring it.
  Acceptance: fixtures signed by old and new keys both verify during the overlap, and a written
  rotation runbook exists with the order above.
- [x] **15. Diagnose clock and persistence failures in user terms.** (desktop, verified; done:
  a fast clock and a wrong signer have distinct messages, and the reset runbook is in the
  troubleshooting docs. Session-only licensing turned out not to reach buyers: packaged builds
  refuse to start without OS encryption) A clock
  more than 14 days fast rejects a freshly issued token with the same message as a signing-key
  mismatch (`service.ts:183`). Without OS encryption the license is session-only and the buyer
  learns this only after a restart (`src/main/index.ts:191`). An app-state reset silently
  changes the installation ID and orphans Polar slots.
  Distinguish signature failure from clock rejection in the error text, surface session-only
  licensing before activation completes, and document install-slot release after a reset in the
  support runbook.
  Acceptance: fast-clock and no-encryption test cases produce actionable, distinct messages.
- [x] **16. Give the license path release armour.** (process; done: `CODEOWNERS`, the coverage
  floor, the invariants in `RELEASING.md`, and a release gate that holds licensing changes on
  nightly for 24 hours before any stable release, tags included. A ruleset requiring code-owner
  approval was left off on purpose: with one maintainer it would block every license change) Add
  `CODEOWNERS` (none exists)
  requiring maintainer review for `src/main/license/`, `src/main/storage/secure-store.ts`, the
  key injection in `electron.vite.config.ts`, and both workflow files. Add a per-file coverage
  floor for `src/main/license/**` (today one 84% directory floor covers all of `src/main`).
  Write the licensing invariants into `RELEASING.md`: reason strings, token versions, state keys,
  the `www` host, no redirects on license requests, and the client-first rule. Enforce a minimum
  nightly soak (24 hours suggested) for licensing changes before stable promotion, including tag
  releases, which can currently bypass the promoted-nightly path.
  Acceptance: a licensing change cannot merge unreviewed, ship same-day to stable, or drop
  license coverage silently.
- [x] **17. Dogfood the buyer path on every release.** (ops; done as far as code goes: the
  promotion check is named in `RELEASING.md`; keeping maintainer machines on nightly with a real
  key is an ongoing habit) Keep the maintainers' own machines
  on the nightly channel with a real Pro key against a real tenant, and add one manual check to
  the stable promotion: the promoted nightly still shows Pro active and can refresh. This is the
  cheapest catch for failures that only appear with production keys, config, and proxies.
  Acceptance: the check is a named step in the stable promotion routine in `RELEASING.md`.

## Addendum: corporate proxies and SSL inspection (2026-11-06)

Verified state: all main process traffic rides Chromium networking (`net.fetch` via
`chromiumFetch` in `src/main/index.ts:158`). Licensing uses it directly; Graph, Azure, and token
traffic use it through the replaced `globalThis.fetch` (`src/main/index.ts:262`). That means the
system proxy including PAC files and the operating system's trusted root store apply, so an
inspection CA trusted by Windows or macOS works exactly as it does for Edge. There is no
certificate pinning. Intermediary block pages (HTML at 200, 401, 403, 407, or 502) are treated
as "service unreachable" and never revoke a cached entitlement (`test/license.test.ts:524`), and
failures are reported with the Chromium cause code and targeted guidance
(`src/main/api/network-error.ts:31`). This was fixed after real failures in #4 and #12 and is
documented in the network requirements. Two gaps remain:

- [x] **18. Make MSAL's proxy and CA inheritance explicit.** (desktop, verified fragility;
  done: both MSAL applications take an explicit network module on the bridged Chromium fetch,
  and the trial and trial-checkout calls pass `chromiumFetch` explicitly)
  Microsoft token calls currently inherit Chromium networking only because msal-node v7 calls
  the bare global `fetch` (`node_modules/@azure/msal-node/dist/network/HttpClient.mjs:103`) and
  the app replaces `globalThis.fetch` during bootstrap. An msal-node upgrade that switches to
  its own HTTP stack would silently lose the system proxy and OS certificate store for token
  traffic alone, behind SSL inspection first. The trial and trial-checkout calls default to the
  global fetch the same way (`src/main/license/trial.ts:10`, `buy-url.ts:33`).
  Pass an explicit MSAL network module backed by `chromiumFetch` to both MSAL applications
  (`src/main/auth/msal.ts:352`, `backup-reader.ts:364`), pass `chromiumFetch` explicitly to the
  trial and checkout helpers as `LicenseService` already receives, and pin the behavior with a
  test that fails if MSAL bypasses the injected fetch.
  Acceptance: token, trial, and checkout requests provably go through `net.fetch` regardless of
  msal-node internals or bootstrap order.
- [x] **19. Handle proxies that require authentication.** (desktop, verified gap; done: the
  app's fetch is `net.fetch` rebuilt on `net.request` with a proxy login listener, since
  `net.fetch` cancels every challenge; one prompt per proxy, remembered in the encrypted store,
  wrong credentials asked again at most three times. Verified behind a local authenticating
  proxy: licensing and Microsoft requests with real Chromium, and the built app's prompt, retry
  and remembered credentials; not with a real Microsoft sign-in and backup) There is no
  Electron `login` event handler, so a proxy that challenges for credentials gets none and the
  request fails. Transparent proxies and PAC setups without auth are unaffected. The same
  applies to egress that demands a client certificate, which has no selection handler either.
  Add a `login` handler that prompts for proxy credentials once and keeps them in the encrypted
  store (never for non-proxy challenges), and name proxy authentication explicitly in the error
  guidance and network requirements in the meantime.
  Acceptance: behind an authenticated test proxy, sign-in, licensing, and a backup all succeed
  after one credential prompt, and the credentials survive a restart.
- [ ] **20. Keep tenuvault.com allowlist-friendly and prove the MITM path periodically.** (ops;
  partly done: `scripts/license-mitm-check.ts` runs licensing in real Chromium behind mitmproxy,
  with the first record on 2026-11-07, and no major filtering DNS resolver blocks the domain.
  Owner: the vendor categorization portals need captchas)
  Web filters often block uncategorized or newly seen domains regardless of certificates, and
  nothing in the app can override that; the current mitigations are the published destination
  list, the 14 day offline grace, and Community working with tenuvault.com fully blocked.
  Submit tenuvault.com for correct categorization with the major web-filter vendors, and run a
  scheduled (at least per stable release) manual or CI check of activation behind a real MITM
  proxy (for example mitmproxy) with the inspection CA installed only in the OS store, plus a
  blocked-host run to confirm the guidance shown is the proxy or certificate one.
  Acceptance: categorization confirmed with the major vendors, and a dated record of the MITM
  activation check exists for the current stable.

## Explicitly not recommended

- Binding activation to the checkout email, a UPN, or an OID. Card holder and Intune admin are
  routinely different people; the bearer key plus tenant and installation limits is the right
  model. Item 13 handles the support cost instead.
- Lengthening the offline token beyond 14 days to mask server outages. It weakens revocation for
  a problem items 2 and 4 solve properly.
