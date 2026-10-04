# Release setup

Everything that has to exist outside this repository before the first public release, and where
each value goes. Nothing on this list is ever compiled into the app as a secret.

| Where | What |
|---|---|
| Polar dashboard | Products, license key benefits, checkout links, organization access token |
| Vercel, the tenuvault.com project, Settings > Environment Variables | Licensing service settings and signing key, checkout links for the /desktop page |
| GitHub, this repository, Settings > Secrets and variables > Actions | License public key, portal URL, signing secrets |

## How licensing works

Community covers one tenant without a purchase or Polar activation. The following token and
activation flow applies to Pro and MSP. Feature gates are defined in `src/shared/plans.ts`.

The app never talks to Polar. It calls the licensing service on tenuvault.com
(`/api/desktop-license/{activate,refresh,deactivate,tenant}`). The service checks the key with
Polar's authenticated license key API and answers with an entitlement token signed with Ed25519,
bound to one tenant and one installation, valid for 14 days. The app verifies the token with the
public key built into it, refreshes it every 6 hours and keeps working offline until it expires.
Each paid tenant is licensed on its own: one Polar activation per installation and tenant.

The private signing key lives only in Vercel. The matching public key is compiled into release
builds from a GitHub secret. Development and pull request builds carry an inert placeholder key, so
they cannot verify paid entitlements from production tokens; Community remains available.

## 1. Polar

Do this in the [sandbox](https://sandbox.polar.sh) first, test it against a Vercel preview
deployment, then repeat in production.

### License key benefits

Create one *License Keys* benefit per plan (Benefits > Create benefit > License Keys):

| Benefit | Activation limit | Prefix |
|---|---|---|
| TenuVault Pro | At least 10 | `TENU` |
| TenuVault MSP | Unlimited (Polar maximum) | `TENU` |

- **The activation limit is not the tenant limit.** The licensing service decides how many tenants
  a key covers (Pro: 2, MSP: the subscription quantity) and allows 5 installations per tenant. The
  Polar limit must be high enough for all paid tenants and their installations. This table is a setup requirement, not evidence of the current Polar dashboard setting.
- Allow customers to **deactivate activations themselves** in the customer portal.
- **No expiration.** Polar revokes the key when the subscription ends; the app stops at its next
  refresh, or when its cached token expires.

### Products

| Product | Pricing | Benefit |
|---|---|---|
| TenuVault Desktop Pro, monthly | Fixed | TenuVault Pro |
| TenuVault Desktop Pro, yearly | Fixed | TenuVault Pro |
| TenuVault Desktop MSP, monthly | Per unit, quantity = tenants, minimum 3 | TenuVault MSP |
| TenuVault Desktop MSP, yearly | Per unit, quantity = tenants, minimum 3 | TenuVault MSP |

**Money-back guarantee:** products have no trial. New subscriptions are charged at checkout, so the
first invoice shows the full amount, and the first payment is covered by a 30-day money-back
guarantee. To honor it, refund the order in Polar and also revoke the subscription immediately:
a refund alone leaves a subscription and its license key active, and the key is only revoked
once the subscription is revoked. The key is issued at checkout, so buyers
activate the app right away. Trials that started before October 4, 2026 continue under their
original terms, and their keys keep working.

### Checkout links and token

- Create a checkout link for each product (Products > Checkout Links). Set the success URL to
  `https://tenuvault.com/desktop#setup`.
- Create an organization access token (Settings > Developers) with license key read and write
  access. It goes into Vercel only.
- Note the organization ID (Settings > General) and the benefit IDs.

## 2. Vercel (tenuvault.com)

Server settings of the licensing service (secret, Production and Preview get different values:
preview uses the Polar sandbox and its own signing key):

| Name | Value |
|---|---|
| `POLAR_API_BASE` | `https://api.polar.sh` (preview: `https://sandbox-api.polar.sh`) |
| `POLAR_ORGANIZATION_ID` | The organization ID |
| `POLAR_ACCESS_TOKEN` | The organization access token |
| `DESKTOP_LICENSE_PRO_BENEFIT_ID` | Benefit ID of TenuVault Pro |
| `DESKTOP_LICENSE_MSP_BENEFIT_ID` | Benefit ID of TenuVault MSP |
| `DESKTOP_LICENSE_SIGNING_KEY` | Private key from `npm run license:keypair` (base64 of the PEM) |
| `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` | Store for organization license sharing |

Public settings of the /desktop page. Next.js bakes them into the page at build time, so
**redeploy** after changing them:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_POLAR_CHECKOUT_PRO_MONTHLY` | Checkout link |
| `NEXT_PUBLIC_POLAR_CHECKOUT_PRO_YEARLY` | Checkout link |
| `NEXT_PUBLIC_POLAR_CHECKOUT_MSP_MONTHLY` | Checkout link |
| `NEXT_PUBLIC_POLAR_CHECKOUT_MSP_YEARLY` | Checkout link |
| `NEXT_PUBLIC_POLAR_PORTAL_URL` | `https://polar.sh/<slug>/portal` |
| `NEXT_PUBLIC_DESKTOP_CONTACT_URL` | Enterprise contact, for example `mailto:sales@tenuvault.com` |
| `NEXT_PUBLIC_DESKTOP_RELEASED` | `true` once the first release is on GitHub; until then the download buttons say "coming soon" |

Buyers can pay before they can activate if `POLAR_ACCESS_TOKEN` is missing, so set it before the
checkout links go live.

## 3. GitHub (this repository)

Settings > Secrets and variables > Actions. Release tags (`v*`) fail when either is missing.

| Kind | Name | Value |
|---|---|---|
| Secret | `TENUVAULT_LICENSE_PUBLIC_KEY` | The public key printed by `npm run license:keypair`, matching the production `DESKTOP_LICENSE_SIGNING_KEY` |
| Variable | `TENUVAULT_LICENSE_PORTAL_URL` | `https://polar.sh/<slug>/portal` |

Release builds use `https://tenuvault.com` as the licensing service and
`https://tenuvault.com/desktop#pricing` as the checkout page. To test against a preview deployment,
start a development build with `TENUVAULT_LICENSE_API_BASE=<preview origin>` and
`TENUVAULT_LICENSE_PUBLIC_KEY=<preview public key>` set (`npm run dev` reads them at build time).
Rotating the key pair invalidates every issued token; apps get new ones at their next refresh once
the new public key ships.

Signing secrets: see sections 4 and 5.

## 4. macOS signing and notarization

You need an [Apple Developer Program](https://developer.apple.com/programs/) membership
($99/year). Without signing and notarization, macOS warns people away from the app, and
auto-update does not work.

1. **Developer ID Application certificate.** In Certificates, Identifiers & Profiles, create a
   *Developer ID Application* certificate. Install it, export it from Keychain Access as a `.p12`
   with its private key and a password, then run `base64 -i certificate.p12 | pbcopy`.
   - Secret `MAC_CSC_LINK`: the base64 text.
   - Secret `MAC_CSC_KEY_PASSWORD`: the export password.
2. **App Store Connect API key** for notarization. In App Store Connect, go to Users and Access >
   Integrations > App Store Connect API and create a key with the *Developer* role. Download the
   `.p8` file; it can only be downloaded once.
   - Secret `APPLE_API_KEY`: the full contents of the `.p8` file.
   - Secret `APPLE_API_KEY_ID`: the key id.
   - Secret `APPLE_API_ISSUER`: the issuer id shown above the list of keys.

A *Developer ID Installer* certificate is not needed: the app ships as DMG and ZIP, not `.pkg`.

## 5. Windows signing (Azure Trusted Signing)

1. In the Azure subscription that holds the Trusted Signing account, note the account name, the
   certificate profile name and the endpoint (for example `https://weu.codesigning.azure.net`).
2. Create an app registration for CI with a client secret, and give its service principal the
   *Trusted Signing Certificate Profile Signer* role on the certificate profile.
3. Secrets:
   - `AZURE_SIGNING_TENANT_ID`, `AZURE_SIGNING_CLIENT_ID`, `AZURE_SIGNING_CLIENT_SECRET`
   - `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
     `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
   - `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`: must match the certificate's subject CN, for example
     your name or company as validated by Microsoft.

## 6. First release

1. Set `version` in `package.json` (for example `1.0.0`) and merge to `main`.
2. Tag it: `git tag v1.0.0 && git push origin v1.0.0`.
3. CI builds, signs and smoke tests both platforms, then publishes the GitHub release with the
   update feed. Release tags fail if a signing secret is missing.
4. Before tagging, test licensing with a sandbox key in a development build against a preview
   deployment (see section 3). After the release, check production once: buy a plan (or use a
   100% discount code), install the release, activate the key and connect a tenant. The License page
   should list the tenant as active.

## Manual installer builds for demos

Run the **CI** workflow manually against the desired branch to build macOS and Windows installers without publishing a release. These installers embed the production license verification key and portal URL, using the same `TENUVAULT_LICENSE_PUBLIC_KEY` secret and `TENUVAULT_LICENSE_PORTAL_URL` variable as releases. A valid tenant license and Microsoft sign-in are still required. Pull request builds continue to use the placeholder verification key.

Download the platform artifact after the packaging and smoke-test jobs pass. macOS includes Apple Silicon (`arm64`) and Intel (`x64`) DMG/ZIP files. Signing and notarization still require the Apple credentials described above; manually built installers are unsigned when those credentials are absent.

## Entitlement verification record

Reviewed on 1 October 2026 against the licensing source at
[`181aaa4`](https://github.com/ugurkocde/TenuVault-Website/commit/181aaa443ec30fb786754ca76a3a6cdd54a126d9)
(first reviewed on 26 September 2026 at `44f1c72`). That source sets Pro to two tenants, five
installations per paid tenant, MSP to the purchased quantity with a minimum of three, and signed
tokens to 14 days.
The desktop refresh interval is six hours. Pro shares with other tenant admins by default; MSP
sharing is opt-in. Community feature and tenant limits are enforced locally by the desktop.

The production Polar benefits were read on 1 October 2026: the Pro key allows 10 activations (two
tenants with five installations each) and the MSP key has no practical cap (Polar's maximum). A lower
Polar activation cap would prevent customers from reaching the service's per-tenant allowance. The
production Vercel environment still requires an authenticated operator check. No production license
was activated or changed during this review.
