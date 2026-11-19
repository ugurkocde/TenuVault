# Changes in Contoso \<Müller\> & Co, 5 Nov 2026 to 6 Nov 2026

- Tenant: Contoso \<Müller\> & Co (8c6f2b1e-4d3a-4f7b-9e21-6a5d0c3b7f14)
- From backup: backup-2026-11-05-020000 (5 Nov 2026, 02:00 UTC)
- To backup: backup-2026-11-06-020000 (6 Nov 2026, 02:00 UTC)
- Generated: 6 Nov 2026, 02:14 UTC after a scheduled backup
- Summary: 8 changed, 2 added, 1 deleted; 4 of 11 with matching audit events.

## Deleted (1)

### macOS - FileVault

- Type: Device Configuration
- Severity: warning
- ID: d-filevault
- Previous version in backup: backup-2026-11-05-020000
- Deleted by alex@contoso.example, 5 Nov 2026, 15:52 UTC \(Intune: Delete DeviceConfiguration\)

| Setting | Value |
| --- | --- |
| File vault enabled | true |
| File vault number of times user can ignore | 3 |
| File vault recovery key escrow location description | \[redacted\] |
| Assignments \(item 1\) | Excluded group g-2 |

## Changed (8)

### Compliance policy settings

- Type: Compliance policy settings
- Severity: critical
- ID: CompliancePolicySettings
- Previous version in backup: backup-2026-11-05-020000
- No matching audit event in this window

| Setting | Before | After |
| --- | --- | --- |
| Mark devices with no compliance policy assigned as | Compliant | Not compliant |
| Compliance status validity period \(days\) | 30 | Not set \(Intune uses 30\) |

### CA001 - Require MFA

- Type: Conditional Access policies
- Severity: critical
- ID: ca-1
- Previous version in backup: backup-2026-11-05-020000
- No matching audit event in this window

| Setting | Before | After |
| --- | --- | --- |
| State | enabled | enabledForReportingButNotEnforced |
| Exclude users: u-break-glass | Not set | u-break-glass |

### Windows 11 - Compliance

- Type: Compliance Policy
- Previously named: Win11 Compliance
- Severity: warning
- ID: c-win
- Previous version in backup: backup-2026-11-05-020000
- Updated by Graph Explorer, 5 Nov 2026, 11:05 UTC \(Intune: Patch DeviceCompliancePolicy\)
- Assigned by megan@contoso.example, 5 Nov 2026, 11:06 UTC \(Intune: Assign DeviceCompliancePolicy\)

| Setting | Before | After |
| --- | --- | --- |
| Display name | Win11 Compliance | Windows 11 - Compliance |
| Password minimum length | 12 | 8 |
| OS minimum version | 10.0.22000 | 10.0.22631 |
| Assignments \(item 2\) | Not set | Excluded group g-4 |

### Wi-Fi

- Type: Device Configuration
- Severity: warning
- ID: d-wifi
- Previous version in backup: backup-2026-11-05-020000
- No matching audit event in this window

| Setting | Before | After |
| --- | --- | --- |
| SSID | corp | corp-2 |
| Plain | 1 | 2 |
| Secret values | \[redacted\] | \[redacted\] |

### APP - Android

- Type: Android app protection policies
- Severity: info
- ID: m-android
- Previous version in backup: backup-2026-11-05-020000
- Updated by sam@contoso.example, 5 Nov 2026, 13:40 UTC \(Intune: Patch AndroidManagedAppProtection\)

| Setting | Before | After |
| --- | --- | --- |
| Allowed data storage locations: box | Not set | box |
| Apps: com.microsoft.teams | com.microsoft.teams | Not set |
| Apps: com.microsoft.emmx | Not set | com.microsoft.emmx |
| Assignments \(item 1\) | Not set | Excluded group bbbbbbbb-2222-4222-8222-222222222222 |

### Unread assignments

- Type: Configuration Policy
- Severity: info
- ID: p-unread
- Previous version in backup: backup-2026-11-05-020000
- No matching audit event in this window

| Setting | Before | After |
| --- | --- | --- |
| Platforms | windows10 | macOS |

### WIN - Defender

- Type: Configuration Policy
- Severity: info
- ID: p-defender
- Previous version in backup: backup-2026-11-05-020000
- Updated by megan@contoso.example, 5 Nov 2026, 09:14 UTC \(Intune: Patch DeviceManagementConfigurationPolicy\)

| Setting | Before | After |
| --- | --- | --- |
| Role scope tag IDs: 12 | Not set | 12 |
| Allow Cloud Protection | Allowed. Turns on Cloud Protection. | Not allowed. Turns off Cloud Protection. |
| Defender: Avgcpuloadfactor | 50 | 1.5 |
| Restrictions | Restrictions | Not set |
| Cloud Block Level | Not set | High |
| Assignments \(item 2\) | Not set | All users \(filter exclude f-9\) |

### APP - iOS

- Type: IOS app protection policies
- Severity: info
- ID: m-ios
- Previous version in backup: backup-2026-11-05-020000
- No matching audit event in this window

| Setting | Before | After |
| --- | --- | --- |
| PIN required | false | true |

## Added (2)

### \[Restored\] Kiosk

- Type: Configuration Policy
- Severity: info
- ID: p-copy
- Likely a copy made by a restore
- No matching audit event in this window

| Setting | Value |
| --- | --- |
| Platforms | windows10 |

### WIN - Edge \</td\>\<script\>alert\(1\)\</script\>

- Type: Configuration Policy
- Severity: info
- ID: p-edge
- No matching audit event in this window

| Setting | Value |
| --- | --- |
| Platforms | windows10 |
| Technologies | mdm |
| Edge: Passwordmanagerenabled | 0 |
| Wi-Fi: Key | \[redacted\] |
| Assignments \(item 1\) | Included group g-3 \(filter include f-1\) |

## Other activity (1)

Audit events in this window that match no item in the report, for example a change that was undone before the second backup.

| When | What | Object | Who |
| --- | --- | --- | --- |
| 5 Nov 2026, 16:20 UTC | Intune: Patch DeviceConfiguration | Kiosk \| settings | lidia\|\<x\>@contoso.example |
