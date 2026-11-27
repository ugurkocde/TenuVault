# #145 Dev to Prod settings promotion

## What it does

A deliberate, one-way, admin-started promotion of selected Settings Catalog policies from a
source (development) tenant into the selected destination (production) tenant. Route:
`POST /api/promotion`, screen: Changes, Dev to Prod.

1. Select: the source tenant and policies. Each policy creates a new destination policy unless
   the admin explicitly chooses an existing destination policy to update; a same name is a hint.
2. Plan: every tenant-specific reference of each policy (scope tags, reusable settings and, when
   assignments are included, groups and assignment filters) is resolved against the destination
   through confirmed mappings. Source GUIDs are never replayed; a same-name destination object is
   only a suggestion until the admin confirms the mapping. Blocked plans list their findings and
   create nothing; map the dependencies and plan again. A clean plan freezes one change set in the
   destination and records a hash of every destination object it relied on.
3. Review diff and approve: the preview of the destination, plus source edits made after
   planning (reported, never propagated). A changed mapped dependency blocks approval.
4. Apply: destination freshness re-check, mapped dependencies re-checked, production pre-change
   backup (fail closed), dependencies re-checked again, capture, journaled writes with read-back
   per policy.
5. Results: verified, failed or uncertain per policy; retry reconciles uncertain ones first.
6. Rollback: preview, create the rollback change set, then review, approve and apply it in the
   same screen. The rollback only writes to the destination, so it does not need the source
   tenant's license.

Assignments are excluded unless the admin opts in, in which case only confirmed, destination
resolved groups and filters are written. Exclusions stay exclusions and filter types (include or
exclude) are preserved. Nothing runs in the background; there is no continuous sync.

## Write engine

Promotion writes through the internal change-set engine (`src/main/features/change-sets`). It has
no route or screen of its own; promotion, baseline upgrades and standards call it directly.

- A change set freezes the operations (type, action, target object, proposed configuration,
  reviewed assignments), the source version, the target tenant and the resolved dependencies.
- Approval binds to the content hash (sha256 of the canonical operations, their frozen content and
  the resolved dependencies) and to a target fingerprint read at approval (sanitized live object
  per update or delete, same-name object IDs per create). Apply re-reads the target and refuses
  (status `stale`, approval cleared) when either changed.
- Backup and live-state capture first: before the first write the engine re-checks the target,
  runs a full backup through `/api/backup/start` and `/api/backup/status` (fail closed), re-checks
  again, then stores a sanitized capture of every affected object in an immutable content record.
  Nothing is written if any step fails.
- Per-operation read-back: each operation is written through the journaled Graph caller and read
  back. Outcomes: `verified` (read-back matches), `failed` (Graph rejected it, nothing written),
  `uncertain` (network loss, 5xx, follow-up step failure, read-back denied or different).
- Uncertain-write reconciliation: retry never repeats a verified operation. Uncertain operations
  are reconciled from live state first: a matching object is recorded as verified without a
  write; only an object that still holds the captured pre-change state is written again; anything
  else stops for a fresh review.
- Reviewed rollback: the rollback preview derives inverse operations from the capture (delete
  what was created, write back what was updated, recreate what was deleted without assignments)
  and states what cannot be reversed. The rollback is a new change set with its own review.
- There is no atomic tenant transaction and no guaranteed reversal.

## Plan boundary

- Community: unavailable (402).
- Pro: between any two connected tenants on Pro, a Pro trial or MSP, however each is licensed.
  The destination is the request tenant, the source is named in `targetTenants` so its license
  is checked, and `proPair` must be true (403 otherwise). No MSP bulk or portfolio endpoint is
  used or unlocked.
- MSP: the same promotion.
- Downgrade or expiry: stored promotions stay readable; planning, applying and rollback answer
  402.

## Limits

- Settings Catalog policies only; secret values block a policy.
- Up to 25 policies per promotion.
- Group memberships and device-side state are not read or captured; the device impact of
  promoted assignments is not estimated, and rollback cannot restore memberships.
- Values Intune masks are never stored. Objects holding them cannot be rolled back
  automatically (reported as blocked).
- A create whose response was lost is recognised only by a single new object with the same name
  and matching content. Several new objects stop for manual review.
- A retried write the journal still marks as uncertain is refused by the journal; reconcile it in
  Settings, Restore history, then retry.

## Manual verification

1. Pro license with a development and a production tenant. In development, create a Settings
   Catalog policy using a non-default scope tag and a reusable setting.
2. Select the production tenant, Changes, Dev to Prod. Choose the development tenant and the
   policy, Create a new policy, Plan: expect blocked mapping findings.
3. Map the scope tag and reusable setting, tick Confirmed, Plan again: `in-review`.
4. Review against the live tenant, approve. Create a policy with the same name in production,
   Apply: expect a refusal (stale). Delete that policy, plan again, approve.
5. Edit the mapped reusable setting in production, Review against the live tenant: expect a
   blocker that the objects the plan relied on changed. Plan again.
6. Apply with the confirmation: a production backup is created, the policy appears unassigned
   with the mapped scope tag and reusable setting.
7. Edit the development policy, Review against the live tenant: a note says later edits are not
   promoted.
8. Preview rollback, create the rollback change set, then review, approve and apply it under
   Rollback: the promoted policy is removed.
9. Disconnect the network during an apply of a two-policy promotion: the result shows
   `uncertain`; reconnect and Reconcile and retry: verified operations are not written again.
10. Try with a Community or unlicensed tenant as source: expect the plan refusal.
