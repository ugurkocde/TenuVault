# Intune Multi Admin Approval (MAA): Graph research and integration plan

Date: 2026-11-07
Graph version: beta (every MAA endpoint exists only in beta)
Lab: Ugur Koc Lab, app-only Lokka connection plus one delegated admin sign-in for the E2E run, no access policies configured
Status: implemented for restore (2026-11-09). The full round trip (request, approval by a second admin, completion) was verified live with two test admins (see the two-admin lab run).

## Decision

Revised on 2026-11-09 after the two-admin lab run (the first decision, "detect and explain only", is superseded):

- **Every writer** (restore, change sets, CIS remediation, baselines, OIB deployment, framework baseline creation) detects MAA and reports it clearly, never as a retryable failure, and reports partial writes accurately.
- **Restore** (same tenant, copies and replace in place) sends protected items to Intune as approval requests with the admin's justification, keeps a pending record in the encrypted desktop store, and lets the original requester complete them after approval, including the separate assignments round.
- **Approval stays in the Intune admin center.** TenuVault never approves or rejects; there is no approvals inbox.
- **Change sets and OIB do not submit requests** yet. Their operations are marked as blocked by MAA and are applied in the admin center.

Phase 2 below describes the original design; where the lab run contradicts it, the lab run wins.

## When MAA triggers, and why TenuVault cares

MAA intercepts a call only when all three are true:

1. The tenant has turned MAA on for that area. It is opt-in per area (an access policy for apps, compliance policies, scripts and so on). Tenants without an access policy see no change for any other resource type. The one exception is the access policies themselves: creating, changing or deleting one always needs approval, even in a tenant that has none yet (verified in the E2E run).
2. The call is a write: POST, PATCH, PUT or DELETE. GET is never intercepted.
3. The object type is in a protected area (see the table below). Legacy configuration profiles, administrative templates, update rings, enrollment and branding are not protected today.

So backups, drift, alerts, scores and the Backup Reader always work. Restore, promotion, CIS remediation, change sets and OIB deployment work for unprotected types. For protected types Intune refuses the write and nothing changes, so the tenant stays safe, but that item is not applied.

MAA never breaks a tenant. The problem is how TenuVault reports it today:

1. **Unclear failure at the worst moment.** A restore usually runs because something went wrong. The admin sees Microsoft's raw text ("Header 'x-msft-approval-justification' is required...") with no hint that MAA blocked it, that nothing changed, or what to do.
2. **A retry that cannot work.** The failure is marked retryable, so the admin retries and concludes TenuVault is broken.
3. **Misleading change-set results.** When the create goes through but `/assign` is intercepted, the report says "created, assignments failed". The policy exists without its assignments.
4. **Mixed runs.** In one restore the unprotected items apply and the protected ones are refused. Without a per-item reason the admin cannot tell what was restored.
5. **The tenants most likely to use MAA** (MSPs and larger organisations) are the ones TenuVault matters most to, and they hit this on their first restore.

The fix is therefore to say clearly, per item: "Multi Admin Approval protects this policy type in this tenant. Nothing was changed. Make this change in the Intune admin center." When an earlier step of the same item was already written, the message says exactly what was written and what was blocked instead (Phase 1, item 3). Run reports must stay accurate either way. For restore, TenuVault now also sends protected items for approval and completes them afterwards (see Decision).

## Summary

- A tenant with an MAA access policy intercepts every POST, PATCH, PUT and DELETE on a protected resource. Since Intune service release 2606 (week of 2026-06-22) this applies to app-only calls as well as delegated ones. GET is never affected, so backups, drift, alerts, scores and the Backup Reader keep working.
- Protected areas: apps, compliance policies, Settings Catalog configuration policies, Windows scripts, Intune RBAC, tenant configuration (device categories), device actions, and the access policies themselves. That covers most of what restore, promotion, CIS remediation, change sets and OIB deployment write.
- The Graph protocol is a two-pass request: send the write with a Base64 `x-msft-approval-justification` header, receive an approval code, wait for a second admin to approve, then resend the identical request with `x-msft-approval-code`.
- **Microsoft's own documents disagree on the status codes** (400, 403 or 412). TenuVault must detect MAA from the approval header and the error text, never from the status code alone. For a delegated admin the live run settled it: 400 without the justification header, 412 with it.
- Today TenuVault does not stall. It fails the write at once as "rejected" and shows Microsoft's raw text, such as "Header 'x-msft-approval-justification' is required to request approval". No approval request is created, so the admin cannot even approve it in the portal.
- A second admin can approve through Graph with a delegated token (`POST .../{id}/approve`), so an in-app approvals inbox would be possible. It is out of scope (see Decision).

## Sources

Official (Microsoft Learn):

| Page | Updated | Used for |
| --- | --- | --- |
| [Use Multi Admin Approval in Intune](https://learn.microsoft.com/en-us/intune/fundamentals/role-based-access-control/multi-admin-approval) | 2026-07-31 | Protected areas, roles, lifecycle, expiry, lock, exclusions |
| [Use Multi Admin Approval with the Microsoft Graph API](https://learn.microsoft.com/en-us/intune/fundamentals/role-based-access-control/multi-admin-approval-graph-api) | 2026-08-06 | Headers, response sample, polling, resubmission |
| [What's new in Intune](https://learn.microsoft.com/en-us/intune/whats-new/) | rolling | 2606 enforcement on API calls ("return an HTTP 403 error") |
| [operationApprovalRequest resource (beta)](https://learn.microsoft.com/en-us/graph/api/resources/intune-rbac-operationapprovalrequest?view=graph-rest-beta) and its methods (list, get, approve, reject, cancelApproval, cancelMyRequest, retrieveRequestStatus, retrieveMyRequestById, retrieveMyRequests) | 2026-01 | Request model, permissions |
| [operationApprovalPolicy resource (beta)](https://learn.microsoft.com/en-us/graph/api/resources/intune-rbac-operationapprovalpolicy?view=graph-rest-beta), list, retrieveOperationsRequiringApproval, retrieveApprovableOperations | 2026-01 to 2026-03 | Policy model, preflight |
| [operationApprovalPolicyType enum (beta)](https://learn.microsoft.com/en-us/graph/api/resources/intune-rbac-operationapprovalpolicytype?view=graph-rest-beta) | 2026-01 | Policy type values |
| [Create a custom role in Intune](https://learn.microsoft.com/en-us/intune/fundamentals/role-based-access-control/create-custom-role) | 2026-08-24 | MAA role permissions |
| [Q&A: Multi Admin Approval error in Intune](https://learn.microsoft.com/en-us/answers/questions/1723343/multi-admin-approval-error-in-intune) | 2024-06 | App configuration assignment is protected under Apps |

Third party, used only where they report observed responses: [Patch My PC](https://patchmypc.com/blog/intune-multi-admin-approval-the-x-msft-approval-justification-error/) (2026-06-24), [Jannik Reinhard](https://jannikreinhard.com/intune-multi-admin-approval-graph-api/) (2026-07-30), [Recast Software](https://www.recastsoftware.com/resources/intune-multi-admin-approval-now-enforced-on-graph-api-calls/) (2026-07-22), [Big Hat Group](https://www.bighatgroup.com/blog/intune-maa-automation-graph-api-june-2026/) (2026-06-24).

The Microsoft Learn MCP connector was not authorized in this session; the same pages were read directly from learn.microsoft.com and its search API.

## How MAA works

- **Access policy** (`deviceManagement/operationApprovalPolicies`): one protected area (`policyType`, optional `policyPlatform`) and one or more approver security groups (`approverGroupIds`). Optional app exclusions (up to 50 per policy) apply to app-only calls only.
- **Everything on a protected resource is protected**: create, edit, delete and assign. Microsoft names "Edit, Create, Modify, Delete, Assign" and says "including but not limited to".
- **Access policies protect themselves.** Creating, changing or deleting one always needs a second admin.
- **Requester and approver are different people.** An admin can never approve their own request, Global Administrator included. Applications can never approve or reject.
- **The requester completes.** "The same account performs both steps: submitting the initial request and selecting Complete after approval." Over Graph, "Complete" is the resubmission with the approval code.
- **Lifecycle**: `needsApproval` to `approved` or `rejected`, or `cancelled` by the requester, then `completed`. A request not processed within 3 days becomes `expired` and must be resubmitted (Learn; the lab's request got an `expirationDateTime` 4 days out, so use the server value). Status stays visible for 30 days.
- **One pending request per object.** While a request is pending, nobody can submit another one for the same object (`entityLocked`).
- **No notifications.** Intune does not tell approvers that a request is waiting; the requester has to reach them.
- **Approver prerequisites**: member of the approver group (direct membership, security group, not nested), the resource's Read permission, the group assigned to an Intune role, and an Intune license unless the irreversible "Allow access to unlicensed admins" setting is on.
- **Exclusions do not help TenuVault.** TenuVault writes with the signed-in admin's delegated token, and exclusions only apply to app-only calls.

### Protected areas and the policyType values

| Area (Learn) | `policyType` | What it covers |
| --- | --- | --- |
| Apps | `app` | App deployments, including assignment. Not app protection policies. App configuration assignment was protected in 2024 (Q&A) |
| Compliance policies | `compliancePolicy` | Creating and managing compliance policies |
| Configuration policies | `configurationPolicy` | Policies "via the settings catalog" |
| Scripts | `script` | Scripts deployed to Windows. The enum text adds "PowerShell scripts or remediation scripts" |
| Role-based access control | `role` | Roles, role permissions, admin groups, member group assignments |
| Tenant Configuration | `tenantConfiguration` | Device categories (create, edit, delete) |
| Device actions | `deviceWipe`, `deviceRetire`, `deviceDelete` | Remote actions. TenuVault performs none |
| Access policies | `operationApprovalPolicy` | Always protected, not selectable |

The enum page still marks `compliancePolicy` and `configurationPolicy` "Not in use at this time". It is older than the Learn article, which lists both as supported. Treat the Learn article as current and the enum text as stale.

## The Graph protocol

### Pass 1: submit for approval

```http
POST https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts
Content-Type: application/json
x-msft-approval-justification: <Base64 of the justification text>

{ ...unchanged body... }
```

The justification is plain text, Base64-encoded, at most 1024 characters (the `requestJustification` limit; whether the limit applies before or after encoding is not documented, so cap the plain text at 700 characters to be safe).

### Response shapes (the sources disagree)

| Case | Learn Graph API page (2026-08-06) | Learn What's new (2606) | Third-party observations (2026-06 to 07) |
| --- | --- | --- | --- |
| No justification header | **400**, body says the header is required | **403** | **403** ("Bad Request 403"), message `Header 'x-msft-approval-justification' is required to request approval` |
| Justification header sent, request created | **412** Precondition Failed, outer code `BadRequest`, header `x-msft-approval-code` | not stated | **403**, error code `ApprovalRequired`, header `x-msft-approval-code` |

Microsoft's documented 412 body:

```json
HTTP/1.1 412 Precondition Failed
x-msft-approval-code: aabb1234-5678-9012-abcd-ef0123456789

{
  "error": {
    "code": "BadRequest",
    "message": "{\r\n  \"_version\": 3,\r\n  \"Message\": \"Approval Required. Request Approval using the request ID returned as part of the x-msft-approval-code response header. x-msft-approval-code: aabb1234-... - Operation ID (for customer support): ... - Activity ID: ... - Url: ...\",\r\n  \"CustomApiErrorPhrase\": \"\",\r\n  \"RetryAfter\": null,\r\n  \"ErrorSourceService\": \"\",\r\n  \"HttpHeaders\": \"{\\\"x-msft-approval-code\\\":\\\"aabb1234-...\\\"}\"\r\n}"
  }
}
```

The approval code appears three times: the response header, the inner `Message` text and the inner `HttpHeaders` JSON string. Every Intune error we read in the lab carries the same inner envelope (`_version`, `Message`, `HttpHeaders`), so parsing it is safe. Likely the status moved from 403 to 412 during rollout. Either way the code cannot rely on it.

**Detection rule** (status-independent):

1. Any 4xx response with an `x-msft-approval-code` header, or with an approval code in the inner `HttpHeaders` or in the `Message` text, is **pending approval**. The code must be a GUID.
2. Any 4xx response whose message mentions `x-msft-approval-justification`, or whose error code is `ApprovalRequired`, without a code, is **approval needed, not yet requested**. Nothing was written and nothing was created.
3. Everything else keeps today's handling.

### Wait for approval

Documented by Microsoft:

```http
GET /beta/deviceManagement/operationApprovalRequests?$filter=requestId eq '<code>'
```

**This filter does not work** (E2E run below): it returned an empty `value` for a real pending request. Use one of these instead, both verified with a real request (200) and an unknown code (404 `ResourceNotFound`):

- `GET /beta/deviceManagement/operationApprovalRequests/{code}`
- `GET /beta/deviceManagement/operationApprovalRequests/retrieveMyRequestById(id='{code}')`

Read `status`, `expirationDateTime`, `approvalJustification` (the approver's note, shown on rejection) and `approver`. If the list form is used, match `id` client-side.

### Pass 2: complete

Resend **the same method, URL and body**, with `x-msft-approval-code: <code>` in place of the justification header. Expected result: the normal success response (201 with the new ID for a create). Microsoft says to "save the original HTTP method, URL, and request body", so the body must be the one that was sent, not a rebuilt one.

Undocumented, to confirm on a real MAA tenant: whether another identity can complete, whether the code is single-use, and what an expired, rejected or reused code returns.

### Cancel

`POST /beta/deviceManagement/operationApprovalRequests/cancelMyRequest` with `{ "id": "<code>" }` returns 204. Permissions: DeviceManagementConfiguration.Read.All or DeviceManagementRBAC.Read.All.

### Approve or reject from another admin

`POST /beta/deviceManagement/operationApprovalRequests/{id}/approve` (or `/reject`) with `{ "justification": "...", "approvalSource": "adminConsole" }` returns 200. Delegated or application DeviceManagementConfiguration.Read.All or DeviceManagementRBAC.Read.All, but "applications can't approve or reject MAA requests", so only a delegated call by an approver-group member works. Approver eligibility is enforced by Intune, not by the permission.

## Read-side API surface (verified 2026-11-07)

| Call | Permission (least privileged) | Lab result |
| --- | --- | --- |
| `GET deviceManagement/operationApprovalPolicies` | DeviceManagementRBAC.Read.All | 200, `value: []` |
| `GET deviceManagement/operationApprovalPolicies/retrieveOperationsRequiringApproval` | DeviceManagementConfiguration.Read.All or DeviceManagementRBAC.Read.All | 200, `value: []` (collection of `{ policyType, policyPlatform }`) |
| `GET deviceManagement/operationApprovalPolicies/retrieveApprovableOperations` | same | 200, `value: []` |
| `GET deviceManagement/operationApprovalRequests` | DeviceManagementConfiguration.Read.All or DeviceManagementRBAC.Read.All | 200, `value: []` |
| `GET deviceManagement/operationApprovalRequests/retrieveMyRequests` | same | 200, `value: []` |
| `GET .../operationApprovalRequests/{unknown}` and `retrieveMyRequestById(id='{unknown}')` | same | 404 `ResourceNotFound`, Intune inner envelope with `"HttpHeaders": "{}"` |
| `POST .../operationApprovalRequests/retrieveRequestStatus` `{ entityId, entityType }` | same | 200, `{ requestId: "", requestExpirationDateTime: null, requestStatus: "unknown", entityLocked: false }` |

Notes:

- The names `getApprovableOperations` and `getOperationsRequiringApproval` do not exist (400). The functions are `retrieve...`.
- `retrieveRequestStatus` returns its fields at the top level. Microsoft's example wraps them in `value`. Accept both.
- `retrieveRequestStatus` accepted a made-up `entityType` with the same answer, so the valid `entityType` values cannot be learned from a tenant without requests. Do not rely on it until they are known.
- TenuVault already requests DeviceManagementConfiguration and DeviceManagementRBAC, so the preflight needs no new permission.

## E2E run (2026-11-09)

### Live probe

The only write MAA always intercepts in a tenant without policies is a change to an access policy, so the probe was a create of one (`policyType: tenantConfiguration`, a lab security group as approvers) through Lokka, without the justification header.

```http
POST /beta/deviceManagement/operationApprovalPolicies   (app-only token)
400 BadRequest
Message: "Application only authentication is not allowed for non-read operations on MAA access policies"
HttpHeaders: "{}"
```

Nothing was created: the policy and request lists were still empty afterwards. App-only tokens cannot create, change or delete access policies at all, before any approval step. TenuVault restores with a delegated token, so this does not block a restore of `MultiAdminApprovalPolicies` (which still needs a second admin), but the approval shape cannot be captured with an app-only connection in a tenant without policies.

The same create with a **delegated** token (Global Administrator, Microsoft Graph Command Line Tools, DeviceManagementRBAC.ReadWrite.All), still without the justification header:

```http
POST /beta/deviceManagement/operationApprovalPolicies   (delegated token)
400 BadRequest
Response headers: no x-msft-* header
Message: "Header 'x-msft-approval-justification' is required to request approval"
HttpHeaders: "{}"
```

Nothing was created and no approval request appeared. This settles two open points: for a delegated call without the header the status is **400** (as the Learn Graph API page says, not 403), and even the first access policy in a tenant without any needs approval.

The same create **with** `x-msft-approval-justification` (Base64 of "TenuVault E2E probe, cancel immediately"), then read back and cancelled:

| Call | Result |
| --- | --- |
| `POST operationApprovalPolicies` with the justification header | **412**, outer code `BadRequest`, response header `x-msft-approval-code: <guid>`. The same code is in the inner `HttpHeaders` and in the `Message` ("Approval Required. Request Approval using the request ID returned as part of the x-msft-approval-code response header. x-msft-approval-code: <guid>"). Matches the Learn Graph API page exactly |
| `GET operationApprovalRequests/{code}` | 200, the request. `id` equals the approval code |
| `GET operationApprovalRequests/retrieveMyRequestById(id='{code}')` | 200, same object |
| `GET operationApprovalRequests?$filter=requestId eq '{code}'` (Microsoft's documented polling call) | 200 with **`value: []`** and `@odata.count: 1`, identical for a made-up code. **The documented filter does not work.** Never poll with it |
| `GET operationApprovalRequests/retrieveMyRequests` | 200, lists the request |
| `POST operationApprovalRequests/cancelMyRequest` `{ id }` | 204 |
| `GET operationApprovalRequests/{code}` after cancel | 200, `status: cancelled`; `approver` now holds the user (and the client app) who cancelled |
| `GET operationApprovalPolicies` | still empty |

The request object carries undocumented fields beyond the Graph reference:

```json
{
  "id": "<approval code>",
  "requestDateTime": "2026-11-09T12:10:33.6048129Z",
  "expirationDateTime": "2026-11-13T12:10:33.6048129Z",
  "status": "needsApproval",
  "requestJustification": "TenuVault E2E probe, cancel immediately",
  "approver": null,
  "requiredOperationApprovalPolicyTypes": ["operationApprovalPolicy"],
  "payloadOperation": "Create",
  "payloadName": "TenuVault E2E MAA probe",
  "payloadType": "Microsoft.Management.Services.Api.OperationApprovalPolicy",
  "requiredApprovalRequestPolicies": "OperationApprovalPolicy",
  "payload": "<the request body exactly as sent, as a JSON string>",
  "entitySnapshot": "<the object as Intune would store it, as a JSON string>",
  "approvalSource": 0,
  "requestor": { "application": null, "device": null, "user": { "id": "<object id>", "displayName": "<upn>", "Upn": "<upn>" } }
}
```

What this changes:

- **Expiry is 4 days**, not the documented 3 (`expirationDateTime` minus `requestDateTime`). Show the server's `expirationDateTime`, never a computed one.
- **Intune keeps the body** (`payload`), but in its internal format (OData types rewritten to `microsoft.management.services.api.*`). Graph rejects it as a resend body (verified in the two-admin run), so TenuVault stores the exact serialized body itself. The flip side for the docs: anyone who can read approval requests sees the full body, script content included.
- `payloadOperation`, `payloadName` and `payloadType` give the approvals inbox readable rows without TenuVault storing anything.
- `requestor.user.id` lets TenuVault check that the signed-in admin is the requester before offering Complete or Withdraw.

### Replay through the current code

A throwaway vitest harness (deleted afterwards) answered TenuVault's real `graphCaller`, `Restorer` and change-set `writeOperation` with five shapes: the live 400 above, the documented 400 and the reported 403 for a missing justification header, the documented 412 and the reported 403 `ApprovalRequired` with an approval code. Each ran against a device category restore, a Settings Catalog restore, an access policy restore, a change-set create and a change-set create whose `/assign` alone was intercepted. 26 of 26 cases behaved as follows:

| Path | Result today |
| --- | --- |
| Restore (any type, any shape) | `success: false`, **`retryable: true`**, error is Microsoft's text, for example "Header 'x-msft-approval-justification' is required to request approval". The UI offers a retry that can only fail again |
| Change-set create, intercepted at once | `rejected` with the same text. Nothing written |
| Change-set create, intercepted on `/assign` | `unknown`: "The object was created but its reviewed assignments failed: ...". The policy exists in the tenant without its assignments |
| 403 variants | Same text as 400. No misleading permission hint is added for Intune types (that hint is only for opt-in services) |

Today only the "header missing" shapes can occur, because TenuVault never sends the justification header, so no approval request is ever created. Phase 1 must also set `retryable: false` on `approval-required`, so the retry button disappears.

## What happens in TenuVault today

All Intune writes go through `graphCaller` (`src/portal/lib/policies/graph-restore.ts:139`): restore, recovery, change sets (promotion, CIS remediation, custom baselines, standards, baseline upgrades) and OIB deployment.

- The caller returns `{ status, body }` only (`GraphCall`, `graph-restore.ts:87`); response headers are dropped, including `x-msft-approval-code`.
- Any 4xx except 408 is "rejected" and its journal entry is removed (`graph-restore.ts:155-156`). No retry.
- Change sets classify it the same way (`send`, `src/main/features/change-sets/graph.ts:145`) and show `graphMessage`, the inner `Message` before " - Operation ID".
- Result: the admin sees Microsoft's raw sentence about a header, the run continues with the next operation, and a promotion or CIS run ends partially applied. Unprotected operations land, protected ones are rejected.
- Multi-step writes can fail midway. Patch My PC saw a Win32 app create and its content upload succeed while the final PATCH that commits the content version was intercepted. A create followed by `/assign` can therefore leave an unassigned object that TenuVault reports as "unknown".
- `MultiAdminApprovalPolicies` (`src/shared/intune/registry.ts:1056`, `restore: "create"`) can never be restored by a plain POST, because access policy changes always need approval.
- Delegated calls were intercepted before 2606 too, so tenants with MAA on apps or scripts have hit this since they turned it on.

### TenuVault types per protected area

| `policyType` | TenuVault folders and paths | Confidence |
| --- | --- | --- |
| `configurationPolicy` | Settings Catalog `deviceManagement/configurationPolicies`, including endpoint security policies stored there | High for Settings Catalog. Endpoint security is unclear (the enum has a separate `endpointSecurityPolicy`, "not in use") |
| `compliancePolicy` | `deviceManagement/deviceCompliancePolicies`, `deviceManagement/compliancePolicies`, `scheduleActionsForRules`, possibly `deviceComplianceScripts` | High for the policies, unknown for the scripts |
| `app` | `deviceAppManagement/mobileApps` (create, update, `/assign`, categories, relationships), likely `mobileAppConfigurations` and `targetedManagedAppConfigurations` | High for apps, medium for app configuration. App protection policies are excluded |
| `script` | `deviceManagement/deviceManagementScripts`, likely `deviceHealthScripts` | High for PowerShell, medium for remediations. macOS shell and custom attribute scripts are probably not covered ("Windows") |
| `role` | `deviceManagement/roleDefinitions`, `deviceManagement/roleAssignments`; scope tags unclear | High for roles |
| `tenantConfiguration` | `deviceManagement/deviceCategories` | High |
| `operationApprovalPolicy` | `deviceManagement/operationApprovalPolicies` | Certain |

Legacy device configuration profiles (`deviceConfigurations`), administrative templates, update rings, enrollment and branding are not listed as protected today. Microsoft keeps adding areas, so the code must not hard-code this table. It is for preflight messages only; runtime detection is what matters.

## Integration design

### Phase 1: recognise, explain, warn

Small, ships independently, removes the "unclear failure" problem.

1. **Return headers from the Graph caller.** Extend `GraphCall`'s result with the approval code (parsed once in `graphCaller` from the header, the inner `HttpHeaders` or the message), not the whole header map.
2. **`approvalSignal(status, headers, body)`** in a shared module, implementing the detection rule above, with unit tests for the 400, 403 and 412 shapes and for a code found only in the body.
3. **New outcome `approval-required`** in restore results and change-set operations, distinct from `rejected` and `unknown`. Two cases, each with a link to the existing admin center target `TENANT_ADMIN("multiAdminApproval")` (`src/shared/intune/admin-links.ts:114`):
   - **No step was written** (the first write of the operation was intercepted): "Multi Admin Approval protects <type> in this tenant. Nothing was changed." The journal entry is removed as for any rejection.
   - **An earlier step succeeded** (for example the create went through and `/assign` or a settings step was intercepted): never say "Nothing was changed". Say what was written and what was blocked ("<name> was created, but its assignments need approval by a second admin. Add them in the Intune admin center."), keep the journal entry and the created object's ID so the object stays tracked and visible, and report the operation as partial, not as created.
4. **Preflight.** Before a restore, promotion, CIS remediation, change-set apply or OIB deployment, call `retrieveOperationsRequiringApproval` once per tenant and run (fallback: list `operationApprovalPolicies`), map the policy types to the operations in the run, and say up front which ones will need approval. A 403 or failure of the preflight must never block the run.
5. **Change-set engine.** An `approval-required` operation is terminal for this run. The engine continues with independent operations as today, and the change-set summary counts them separately so the admin knows the run is incomplete.
6. **Flag `MultiAdminApprovalPolicies` restore** as "requires approval by a second admin, make this change in the Intune admin center". Creating or changing access policies is always protected.
7. **Docs.** A docs-site page on MAA: what TenuVault reads (nothing changes), what it writes, what the admin sees, and why app exclusions do not apply.

### Phase 2: full approval round trip (original design)

Implemented for restore in a narrower form (no approvals inbox, no change-set submission). Kept for reference; see the two-admin lab run for verified behaviour.

1. **Ask for a justification.** When the preflight or a Phase 1 signal shows approval is needed, the confirm dialog gets a justification field, prefilled (for example "TenuVault restore of <policy name> from the backup of <date>"), editable, capped at 700 characters, required. TenuVault never creates an approval request on its own.
2. **Submit.** Send the write with `x-msft-approval-justification`. On the pending signal, store a **pending approval record**: tenant, signed-in user object ID, the operation's write key, method, path, the exact body sent (or its hash plus the frozen change-set content it came from), the code, `expirationDateTime`, the follow-up steps still to run, and the origin (restore, change set, OIB).
   - Bodies of restores of updates depend on the live object at the time (`buildUpdatePlan` reads `current`), so the body must be stored, not rebuilt.
   - Store bodies with the same protection as change-set content. Script bodies can contain secrets. Intune's `payload` cannot be resent (internal format), so the exact body string must be stored for every step.
3. **Track.** A "Waiting for approval" list per tenant (and on the change-set page) shows each request with its status, the approver's note and the time left. Poll `GET operationApprovalRequests/{code}` when the list is open (once a minute at most) and at app start; no background polling across tenants.
4. **Complete.** When the status is `approved`, the requester presses Complete. TenuVault checks that the signed-in user is the requester, takes a fresh pre-change backup (days may have passed), verifies the stored body hash, resends with `x-msft-approval-code`, then continues with the follow-up steps and the usual read-back.
5. **Follow-up steps can need their own approval.** A create may be approved and then its `/assign` (or a settings step) intercepted again. Each step gets its own pending record, chained to the first. The UI shows "step 2 of 3 waiting for approval".
6. **Terminal states.** `rejected`: show the approver's note, drop the record. `cancelled` or `expired`: drop the record and offer to submit again. `completed` without TenuVault's resend (should not happen, since only the requester completes): read back and reconcile. Unknown or new status values: keep waiting and say so.
7. **Withdraw.** "Withdraw request" calls `cancelMyRequest`.
8. **Drift safety.** While a request is pending, Intune locks the object against new requests, but a change made through an unprotected path or an excluded app can still happen. Before completing an update, compare the live object with the fingerprint taken at submit time, as change sets already do, and mark the operation stale instead of overwriting.
9. **Approvals inbox (MSP value).** A delegated "Approvals" view lists `needsApproval` requests in a connected tenant and lets a signed-in approver approve or reject with a note through `/approve` and `/reject`. A second engineer can clear a 40-policy CIS run in one sitting instead of forty portal clicks. TenuVault must refuse to show approve on requests where the signed-in user is the requester; Intune enforces it anyway.
10. **Licensing.** Phase 1 is for every plan (it is error handling). Decide whether the approvals inbox is Pro and MSP.

### Edge cases to design for

- Two TenuVault admins touching the same object: the second gets an "already pending" refusal. Its exact shape is undocumented; treat any 4xx that mentions a pending request as `approval-required` with the text shown.
- A token for another tenant (MSP) must never see or complete pending records of a different tenant.
- The pending record outlives the session, the app restart and the license state. Completing an approved request after a plan downgrade should follow the recovery rules used for rollback.
- Offline or throttled polling must not change any state.
- Delete operations: the object stays until completion, so read-back after completion, not after submit.

## Still unverified

Items 2, 4, 5 and 7 were settled by the two-admin lab run on 2026-11-09.

1. ~~The current status code with and without the justification header, for a delegated token.~~ Settled on 2026-11-09: 400 without, 412 with (see the E2E run).
2. ~~Whether `/assign` after an approved create or update needs its own approval~~: yes, always (Settings Catalog verified). Settings steps of other types are still unverified.
3. Which of `deviceHealthScripts`, `deviceComplianceScripts`, `mobileAppConfigurations`, endpoint security policies and scope tags are intercepted.
4. ~~Single use, requester-only completion, errors~~: the code is single use; only the requester can complete; a rejected, reused or not-yet-approved code and completion by another admin all return a generic 403. Expired was not observed.
5. ~~Byte for byte or semantic match~~: byte for byte. Reordered keys fail with a generic 403, and the request stays approved.
6. ~~Whether `$filter=requestId eq` filters or is ignored~~ (it returns nothing, settled on 2026-11-09), and the valid `entityType` values for `retrieveRequestStatus`.
7. ~~The "already pending" refusal~~: another admin gets 409 "An active Approval Request already exists for this entity"; the same requester gets 412 with the existing code. Creates are not locked.
8. Whether an approval recorded through `/approve` by a delegated approver behaves exactly like one made in the admin center.

Still open: whether Complete in the admin center works for a request submitted through Graph (the browser automation failed), item 3, item 8, and settings steps of types other than Settings Catalog.

## Two-admin lab run (2026-11-09)

Lab tenant, two test admins in an assigned security group with a temporary custom Intune role (Settings Catalog and compliance permissions plus all Multi Admin Approval permissions), signed in through the lab's TenuVault app registration (delegated). Requester A, approver B. Everything below was cleaned up afterwards (access policy, test policies, role, role assignment).

| Step | Result |
| --- | --- |
| A creates an access policy for `configurationPolicy`, with justification | 412, code in header and message |
| A approves own request | 403 "Request can not be approved by requestor" |
| A completes before approval | Generic 403 |
| B approves (`POST .../{code}/approve`) | 200, status `approved`; the request records the approving app (TenuVault) |
| B completes A's request | Generic 403 |
| A completes with the exact body and `x-msft-approval-code` | 200, policy created, status `completed` |
| A reuses the completed code | Generic 403 |
| Enforcement delay | About 2 minutes after completion; writes in between go through unapproved |
| Settings Catalog create with an empty `settings` list | 400 validation error before MAA interception |
| PUT (replace in place) with justification | 412, `payloadOperation: Update` |
| While pending: A sends PATCH or `/assign` on the same object | 412 with the existing code, no new request |
| While pending: B sends PATCH | 409 "An active Approval Request already exists for this entity" |
| A completes with a changed name, a different call, or reordered keys | Generic 403 each; request stays `approved` |
| A completes with the exact body | 204 |
| `/assign` after the completed PUT | 412, new code, `payloadOperation: Assign`; completed after approval with 200 |
| PATCH rejected by B, then completed by A | Generic 403, status `rejected` |
| Same create sent twice | Two separate requests (creates are not locked) |
| Complete a create with Intune's stored `payload` | 400 "Invalid OData type specified: microsoft.management.services.api..." |
| Complete a create with the exact body | 201, then `/assign` needed a second round (412, approve, 200) |
| `cancelMyRequest` with `{"requestId": ...}` | 500; with `{"id": ...}` 204 |
| Compliance policy and legacy device configuration create (not protected by this access policy) | 201, deleted normally |
| DELETE of a protected policy and of the access policy | 412, approve, complete 200 |
