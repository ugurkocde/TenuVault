# 0.6 decisions brief: sign-in methods, permission packs, equal weight

Decided by Ugur on 2026-11-23 in the "Download to trial funnel analysis" thread. For the thread that owns `release/0.6` (PR #371). Planning note only: nothing here is implemented yet. Read it before building layers 8 to 10 and the new layer 11.

## Why

Most downloaders never connect a tenant. Today the only path creates an app registration in the customer tenant, which needs Global, Cloud Application or Application Administrator. Most people who download TenuVault hold none of these roles. Trust is the other blocker: admins ask what gets created in their tenant and whether anything is reachable from outside.

## 1. Where to build

- The three sign-in methods are built as new layers on `release/0.6` (layer 11a to 11e below), not on main. They reuse 0.6's modules, permission manifest, token check, connection health and onboarding service choice.
- If 0.6 ships before layer 11 is done, layer 11 ships as 0.6.1.
- The 0.5.4 items on main also touch onboarding and must be merged carefully into `release/0.6`: MSP trial at 2+ tenants (cap 5), optional contact email on the Storage step (prefilled with the signed-in admin, sent only on an explicit tap), a pre-checked "Start TenuVault at sign-in" toggle when a schedule is saved, the automatic first backup after the Storage step, and the onboarding quick wins (error codes, consent preview, Check permissions / Repair).

## 2. Existing tenants are never touched

- Tenants connected before the new wizard keep their method, client ID, services and defaults exactly as they are. No migration and no method switch for them in 0.6 (opt-in switching is a later item).
- The new wizard applies to new installs and to every new tenant added on an existing install.
- Switching between methods is offered only for tenants connected through the new wizard. It is in place: sign in with the new method, check the tenant ID matches (refuse a mismatch), recompute coverage, then swap the stored method and client ID. Backups, history, schedules, settings and the license or trial stay (keyed by tenant ID).

## 3. Three sign-in methods

| | A. Start now | B. TenuVault app | C. Your own app registration |
|---|---|---|---|
| Client | Microsoft Graph Command Line Tools `14d82eec-204b-4c2f-b7e8-296a70dab67e`, scope `https://graph.microsoft.com/.default` | TenuVault multi-tenant public client `61eff188-672b-4be4-acac-2d254a6f9e05` | Customer's registration (today's in-app creation, the script, or pasted IDs) |
| Created in tenant | Nothing | One verified enterprise app "TenuVault" | One app registration |
| Who can set it up | Any admin | Application, Cloud Application or Global Administrator consents (in the app or via a link); anyone else sends a link or requests approval | Application Administrator or higher |
| Coverage | Whatever the tenant already granted to Graph Command Line Tools; usually partial and read-only | The packs chosen | The packs chosen |

Rules:
- Method A is read-only: no restore, drift revert, deploy or Copy to Tenants, even if Graph Command Line Tools holds write scopes. Never ask anyone to grant more scopes to Graph Command Line Tools (that widens every admin's PowerShell in the tenant). Upgrades from A always lead to B or C.
- Method A only uses grants that already exist. In a tenant where Graph Command Line Tools has no grant for Microsoft Graph, the `.default` sign-in shows a Microsoft consent prompt. TenuVault tells the admin before the browser opens that a consent prompt means method A is not available in this tenant and to cancel it. If the prompt appears, the sign-in is declined, or the token carries none of the service scopes, the result is "Start now is not available in this tenant" with the routes to method B or C. TenuVault never asks anyone to approve that prompt.
- Method A cannot reach non-Graph resources (Defender for Endpoint API, Exchange Online).
- Every Microsoft refusal gets a next step: 65001, 65004, 90094, 90095, 50105, 53000/53001/53003, 50076/50079, 700016/500011, 7000218, 50020/90072, Graph 403 (role) and "Intune not licensed".

## 4. The TenuVault app (one app, permission packs)

- One app, display name "TenuVault", appId `61eff188-672b-4be4-acac-2d254a6f9e05`, object ID `c11c4022-4bcc-42c9-aa6f-af71e74ed54d`, in the UgurLabs production tenant `96c21bc2-67e5-41aa-9334-e0fc104874b2`. AzureADMultipleOrgs, public client (`http://localhost`), web redirect `https://www.tenuvault.com/connect/consented` (page still to build), no secrets or certificates ever, app instance property lock on. Publisher domain must become tenuvault.com (already verified in the tenant); publisher verification with Ugur's Partner ID is pending.
- Permissions come in packs, consented only when needed through `/adminconsent?client_id=…&scope=<pack scopes>`:
  - Basics (always): `openid`, `profile`, `offline_access`, `User.Read`, `Organization.Read.All`.
  - For each service: a backup pack (read) and a restore pack (read and write), derived from the 0.6 permission manifest. Pick the smallest covering set where the manifest offers alternatives (for example `Policy.Read.All` and `Directory.Read.All` instead of one scope per area).
  - Azure storage: ASM and Azure Storage `user_impersonation`, only when Azure storage is chosen.
  - Privileged Entra restore: `Application.ReadWrite.All`, `RoleManagement.ReadWrite.Directory` and related. Never part of the normal Entra restore pack (section 6).
  - Conditional Access write and audit-log read are also asked only when those features are turned on.
- The app currently still lists the full Intune set statically. After the spike confirms dynamic `/adminconsent` works for scopes outside the static list (as Application Administrator and Cloud Application Administrator, also for other resources), the static list is cut to the basics. If the spike fails, fall back to one app per service using 0.6's `ConnectionId` placeholder.
- Permission IDs must always be resolved by GET from the resource service principal, never typed from memory.
- Ugur kept the Lokka connector's current app-only rights in that tenant. So audit alerts on this app object (update application, redirect URI change, add owner, credentials added) and a written compromise runbook are a hard gate before 0.6 stable, together with a kill switch `connectMethods.tenuvaultApp` in the license server health endpoint (`connectMethods.graphCli` for method A).

## 5. Licensing per method

- Trials accept any GUID audience today (tid checked, ID token at most 15 minutes old), so all three methods start and refresh trials. Confirm for method A in the spike.
- The shared organization license currently requires `aud` to equal the key holder's registration. Change the mapping to a set of allowed client IDs per tenant: the own registration and the TenuVault app; Graph Command Line Tools only if the key holder turns it on (it is open to anyone in the tenant who can sign in to it).

## 6. Tier-0 safeguards for Entra restore (app registrations and roles)

- Request the privileged pack just in time, when a restore of that type starts.
- After the restore, always remove the permissions this operation added, also when the restore fails or is cancelled. Track exactly which scopes were added for this operation and remove only those; permissions that existed before stay. Cleanup is not optional. If the signed-in admin cannot remove them (it needs an Application Administrator or higher), the restore result says so prominently, offers "Send to my admin" with the exact permissions to remove, and the tenant page keeps a warning until a later check finds them gone.
- Multi-admin approval is on by default for these restore types.
- Recycle bin first, within 30 days, which restores the original object: `directory/deletedItems` for applications, service principals, groups and users, and `roleManagement/directory/deletedItems/roleDefinitions` for deleted custom role definitions. Role assignments have no recycle bin, so they are always re-created and their targets checked first. Re-creating from backup is the last resort and is labeled clearly: a re-created app registration gets a new appId and object ID, so consents, Conditional Access references and federated credentials point to the old one, and secrets and certificates cannot be restored.
- Never available through method A.
- Lab cases for each of these before stable.

## 7. Defender scope

- 0.6 keeps its Graph-based Defender backup.
- Next: Defender for Endpoint indicators through the documented Defender for Endpoint API (resource `WindowsDefenderATP`, `fc780465-2017-40d4-a0c5-307022471b92`), as its own pack; detect tenants without Defender for Endpoint and show "not available in this tenant". Planned for 0.6.x or 0.7, not blocking 0.6.
- Exchange Online (Defender for Office 365 policies) is deferred. No undocumented REST calls.

## 8. Equal weight for Intune, Entra ID and Defender

- Same weight and priority in the app and docs. Intune is not first.
- Order everywhere is alphabetical: Defender, Entra ID, Intune.
- New tenants: nothing preselected, at least one service required. This replaces 0.6's `DEFAULT_ONBOARDING_CHOICE` (Intune with restore) for new tenants only. Existing tenants keep their current services.
- Conditional Access is shown under Entra ID in the interface; the internal `conditionalAccess` module ID can stay for compatibility.
- Same card, toggle, coverage line and sidebar treatment for each. Neutral product wording ("backs up and restores Defender, Entra ID and Intune configuration"), never "Intune backup plus …".

## 9. The "Let's sign in" wizard (layer 11d)

1. Title "Let's sign in". Subtitle: "Choose how TenuVault signs in to your tenant. You can change this later for new tenants." Three cards in this order:
   - Start now: "Sign in with Microsoft Graph Command Line Tools. Nothing is created in your tenant. TenuVault uses what your tenant already allows this Microsoft app, and shows exactly what it can back up."
   - TenuVault app, labeled "Recommended for full backup": "One verified TenuVault app in your tenant. No secrets, nothing reachable from outside. An administrator approves it once, or you send them a link."
   - Your own app registration: "For organizations that require their own app. TenuVault creates it with one sign-in, or you use the script or an existing registration."
   - Each card has a "What this creates in your tenant" line and the roles it needs.
2. Services step: Defender, Entra ID and Intune as three identical toggles, each with "Back up" and "Also restore". With method A it shows what the sign-in already covers. With B and C the consent asks only for the chosen packs.
3. Results: coverage per service ("Defender 6 of 9 · Entra ID 18 of 40 · Intune 7 of 12"), what is missing and why ("permission not granted" vs "your role can't do this"), upgrade buttons to B or C, "Send to my admin" prefilled with the missing pack.
4. Storage (with the optional contact email), then the first backup starts automatically.

## 10. Layer plan on release/0.6

- 11a: connection record per tenant and in-place switching (new-wizard tenants only).
- 11b: method B: in-app consent per pack, send link, request approval (90095), waiting for approval state with "Check again".
- 11c: method A.
- 11d: the wizard above.
- 11e: "X of Z" per service on results and tenant page; compare and drift treat an unread type as unknown, never as deleted (verify against layer 4).
- Layers 9a to 9c: section 6 safeguards.
- Layer 10: equal-weight wording pass, alphabetical order, CA under Entra ID, and the docs below.
- Every layer ships with its docs in `docs-site/src/content/docs/`: `getting-started/connect-tenant.mdx`, `app-registration.md`, `first-launch.md`, `requirements.md`, `index.md`, `multiple-admins.md`, `security/index.md`, `security/permissions.md` (per pack), `security/data-flows.md` (what the license server receives: hashed tenant ID and an ID token, never access tokens or data), `backups/coverage.md`, `backups/compare.md`, `drift.md`, `restore/` pages, `tenants.md`, `troubleshooting.md` (error code table). Each service gets parallel pages with the same structure.

## 11. Tests

Lab tenants: defaults with Graph Command Line Tools never used (expected: method A shows the consent warning, then "not available in this tenant" with the routes to B and C, and no grant is created); Graph Command Line Tools pre-consented with Read only and with ReadWrite; user consent off with and without the admin consent workflow; Conditional Access (compliant device, Graph Command Line Tools blocked, assignment required, 1 hour sign-in frequency); Graph Command Line Tools service principal disabled; Intune not licensed; Defender for Endpoint not licensed; an MSP pair. Accounts: Intune Administrator, Global Reader, a custom Intune role, Security Administrator, Conditional Access Administrator, Application Administrator, Cloud Application Administrator, Privileged Role Administrator, Global Administrator, guest. Matrix: method × tenant × role × service, expected coverage and message for each, on Windows and macOS, plus the privileged restore safeguards and a new tenant added on an install with old-style tenants.
