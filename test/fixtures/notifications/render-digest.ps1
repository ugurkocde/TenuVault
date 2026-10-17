<#
.SYNOPSIS
    Parity check: renders the shared audit digest fixture with the PowerShell watcher.

.DESCRIPTION
    Dot sources resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1 with
    -LibraryOnly, maps every event in audit-digest.json through
    ConvertFrom-TenuVaultAuditEvent, builds the digest with New-TenuVaultAuditDigest
    and writes only the canonical JSON to stdout, so it can be diffed against the
    TypeScript canonicalJson output for the same fixture.
#>
[CmdletBinding()]
param(
    [string]$FixturePath,
    [string]$RunbookPath
)

$ErrorActionPreference = "Stop"

if (-not $FixturePath) { $FixturePath = Join-Path $PSScriptRoot "audit-digest.json" }
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
}
if (-not (Test-Path $RunbookPath)) { throw "Runbook not found: $RunbookPath" }
if (-not (Test-Path $FixturePath)) { throw "Fixture not found: $FixturePath" }

. $RunbookPath -LibraryOnly

$fixture = Get-Content $FixturePath -Raw | ConvertFrom-Json
$changes = @(
    $fixture.events | ForEach-Object { ConvertFrom-TenuVaultAuditEvent $_ } | Where-Object { $_ }
)
$digest = New-TenuVaultAuditDigest -TenantId $fixture.tenantId -TenantName $fixture.tenantName `
    -Changes $changes -IncludeActor ([bool]$fixture.includeActor)

Write-Output (ConvertTo-TenuVaultCanonicalJson $digest)
