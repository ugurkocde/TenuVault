<#
.SYNOPSIS
    Renders the shared audit digest fixture as watcher HTML mail for tests.

.DESCRIPTION
    Dot sources resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1 with
    -LibraryOnly, maps every event in the fixture through
    ConvertFrom-TenuVaultAuditEvent, builds the digest envelope and writes the
    Get-TvEmailHtml output to stdout.
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

. $RunbookPath -LibraryOnly

$fixture = Get-Content $FixturePath -Raw | ConvertFrom-Json
$changes = @(
    $fixture.events | ForEach-Object { ConvertFrom-TenuVaultAuditEvent $_ } | Where-Object { $_ }
)
$digest = New-TenuVaultAuditDigest -TenantId $fixture.tenantId -TenantName $fixture.tenantName `
    -Changes $changes -IncludeActor ([bool]$fixture.includeActor)

Write-Output (Get-TvEmailHtml $digest)
