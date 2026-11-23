# Administrative Templates

The desktop backup registry includes Administrative Templates (`GroupPolicyConfigurations`)
in both the Everything and Everything except apps presets. Custom scopes can exclude them.
The backup browser uses this same registry to expose saved templates for recovery.

The reader uses Microsoft Graph **beta**:

1. List `deviceManagement/groupPolicyConfigurations`, following `@odata.nextLink`.
2. Read each policy with `$expand=assignments`, including any assignment continuation pages.
3. Read its `definitionValues` with `$expand=definition($select=id,displayName,classType,categoryPath,policyType)`.
4. Read each definition value's `presentationValues` with `$expand=presentation($select=id,label)`.

These reads use the existing configuration permission. Microsoft lists
`DeviceManagementConfiguration.Read.All` or `DeviceManagementConfiguration.ReadWrite.All`
for [listing templates](https://learn.microsoft.com/en-us/graph/api/intune-grouppolicy-grouppolicyconfiguration-list?view=graph-rest-beta).
The desktop setup already requests the latter for backup and recovery.

Definition and presentation collections follow continuation pages too. An empty presentation
collection is valid, for example for a disabled setting. A failed child read prevents saving
that policy as a complete snapshot. A denied policy list marks the backup incomplete and
prevents retention from removing older backups.

## Verification

Read-only Lokka MCP verification on September 27, 2026 used `graphApiVersion: "beta"`.
Two existing built-in templates were available. Policy listing returned a continuation link
with `$top=1`; following it returned the other template. The policy detail request returned
an assignments array, and the definition request returned `enabled`, `configurationType`,
the value ID and the expanded definition ID, display name, class and nullable category path.
Both templates had disabled settings and empty presentation collections; the exact presentation
request succeeded. A nonexistent policy returned HTTP 404 (`ResourceNotFound`).

The connected tenant used application authentication. This verifies the read endpoints and
response shapes, not delegated sign-in or the desktop app's permissions in every tenant.
No tenant writes were performed. Restore creation, replacement, populated presentations,
assignment paging, child paging and permission-denied behavior are covered by local tests
where applicable, not claimed as live-verified by this session. Imported ADMX dependencies
were not present in the live sample.

The existing restore planner rebuilds definition and presentation bindings from the saved
IDs. Cross-tenant recovery still depends on the definitions being available in the target.
This desktop coverage does not update the hosted product's Azure Automation runbook.
