# Licensing checks outside the app

Two checks of the buyer path that run against production rather than tests, and their records.
The plan behind them is
[`tasks/license-activation-reliability-2026-11-06.md`](../tasks/license-activation-reliability-2026-11-06.md)
(tasks 4 and 20).

## Licensing canary (every 30 minutes)

[`.github/workflows/license-canary.yml`](../.github/workflows/license-canary.yml) runs
[`scripts/license-canary.ts`](../scripts/license-canary.ts) on GitHub, outside Vercel. It uses
the app's own `LicenseService` with the pinned production verification key, so it checks what a
shipped app would see:

1. `GET /api/desktop-license/health` answers `ok` (production signer and configuration).
2. The canary key activates for a fixed canary tenant and installation, and the token verifies.
3. The cached token entitles the tenant offline.
4. A refresh succeeds.
5. An unknown key is refused as `not_found`.
6. The activation is released again, so the key never holds more than one tenant slot.

A failed run emails the failed steps and a link to the run to the licensing inbox
(ugur@ugurlabs.com), through the website's alerting (`/api/desktop-license/canary-alert`, with the
repository secret `LICENSING_CANARY_ALERT_SECRET`), at most once an hour. The run also fails, so
GitHub emails the maintainer too, which still arrives when the website itself is down. To check
delivery, run the workflow by hand with "Only send a test alert email". Because it does not depend on
the website's own 15 minute scheduled check, it also notices when that check has stopped.

- **Key:** the repository secret `LICENSING_CANARY_KEY`, a dedicated Pro key of the owner's own
  Polar customer that nothing else uses (Polar license key id starting `edbf2518`). Never use it
  for anything else. If it is ever revoked, issue another owner Pro key and replace the secret.
- **In the service's logs** its requests show as `appVersion=0.0.1-canary`.
- **Run it by hand:** Actions, "Licensing canary", Run workflow; or locally with
  `npx esbuild scripts/license-canary.ts --bundle --platform=node --format=esm --outfile=/tmp/canary.mjs`
  and `LICENSING_CANARY_KEY=<key> node /tmp/canary.mjs`.

## HTTPS inspection and block pages (every stable release)

[`scripts/license-mitm-check.ts`](../scripts/license-mitm-check.ts) runs licensing in real
Chromium (Electron) with the app's network stack and `LicenseService`, behind
[mitmproxy](https://mitmproxy.org) on `127.0.0.1:18081`:

```sh
npx esbuild scripts/license-mitm-check.ts --bundle --platform=node --format=cjs --external:electron --outfile=/tmp/mitm-check.cjs
uvx --from mitmproxy mitmdump -q --listen-host 127.0.0.1 -p 18081 --set confdir=/tmp/mitmconf &
run() { env -u ELECTRON_RUN_AS_NODE MODE=$1 CA_PEM=/tmp/mitmconf/mitmproxy-ca-cert.pem KEY=<canary key> CACHED_STATE="$2" xvfb-run -a node_modules/.bin/electron --no-sandbox /tmp/mitm-check.cjs; }
run trusted      # CA trusted: activate, refresh, release. Keep the printed STATE line.
run untrusted    # CA not trusted: certificate guidance
# restart mitmdump with -s scripts/license-mitm-block.py, then:
run blocked '<STATE from the trusted run>'
```

On Linux the trusted CA is handed to Chromium with `--ignore-certificate-errors-spki-list`, which
stands in for installing it in the Windows or macOS certificate store. Expected results:

| Mode | Expected |
|---|---|
| trusted | activated and entitled; refresh entitled and online; released |
| untrusted | "The licensing service could not be reached. Ask IT to check this device's trusted certificates and HTTPS inspection for www.tenuvault.com. (ERR_CERT_AUTHORITY_INVALID)" |
| blocked | cached tenant still entitled (offline); a new activation says "The licensing service returned an unexpected response. Check for a firewall block or network sign-in page and retry." |

### Record

| Date | App code | Result |
|---|---|---|
| 2026-11-07 | `main` at bf6de2b (after 0.4.2, before 0.4.3) | All three modes as expected. Electron 44.10.0, mitmproxy via `uvx`, production licensing service. |

## Web filters

Corporate web filters may block newly seen or uncategorized domains, whatever the certificates
are. Checked on 2026-11-07: `www.tenuvault.com`, `tenuvault.com` and `docs.tenuvault.com` resolve
normally through Cloudflare (1.1.1.1, 1.1.1.2 malware, 1.1.1.3 family), Quad9, OpenDNS
FamilyShield, CleanBrowsing family, AdGuard family and Google DNS, so none of these DNS filters
blocks them.

The categorization portals of the large proxy vendors (Fortinet FortiGuard, Cisco Talos, Palo
Alto Networks, Zscaler, Broadcom WebPulse, Forcepoint, Check Point) sit behind bot protection
and captchas, so lookups and requests there are done by hand. Ask for "Information Technology"
or "Computers and Internet" for `tenuvault.com` and `www.tenuvault.com`, and add the date and
result here.

## Tenant trials

The app reads `GET /api/desktop-license/health`, requiring both `tenantTrials.ok` and `tenantTrials.enabled` to select the tenant trial flow. A failed health check, disabled flag, unsupported action or update requirement keeps the existing email trial form available.

All trial actions POST to `/api/desktop-license/tenant`, with `idToken`, `installId`, `os`, `appVersion` and `action`. `start_trial` adds `source` (`auto` or `opt-in`). `refresh`, `extend_trial`, `end_trial` and `trial_contact` add the server's trial `activationId`. Contact submission adds an optional email; omitting it deletes the saved contact. No email is sent without the user's explicit submission.

The signed v2 token carries the tenant, installation, activation, plan, `trial` and `keyExp`. `source` and `canEnd` are plain response fields, not signed claims. `canEnd` only decides whether the app offers **Use Community instead**; the server enforces who may end the trial. Trial expiry is enforced offline at `keyExp`. A confirmed expired refresh drops coverage through the Community path. Network errors and 5xx, including `storage_unavailable`, preserve cached tokens. A failed automatic start retries at subsequent license checks for up to seventy-two hours from first connection. `used`, `licensed` and `install_limit` end automatic retries. `disabled`, `app_update_required` and unsupported actions keep the retry window open. Existing connected tenants never start automatically.

The server stores a keyed tenant hash for trial eligibility. The optional contact is stored only when submitted. See the shared contract fixture for exact action fields, refusal reasons and signed token examples.
