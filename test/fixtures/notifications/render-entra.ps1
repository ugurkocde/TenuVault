<#
.SYNOPSIS
    Parity check: renders the shared Entra audit fixture with the PowerShell watcher.

.DESCRIPTION
    Dot sources the watcher runbook with -LibraryOnly, maps every event of
    entra-audit.json with ConvertFrom-TenuVaultEntraAuditEvent, builds the
    Conditional Access digest and writes the canonical JSON of the digest and of
    its Teams card, one per line, for comparison with entra.ts and render.ts.
#>
[CmdletBinding()]
param(
    [string]$FixturePath,
    [string]$RunbookPath
)

$ErrorActionPreference = "Stop"

if (-not $FixturePath) { $FixturePath = Join-Path $PSScriptRoot "entra-audit.json" }
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
}

. $RunbookPath -LibraryOnly

$fixture = Get-Content $FixturePath -Raw | ConvertFrom-Json
$changes = @(
    $fixture.events | ForEach-Object { ConvertFrom-TenuVaultEntraAuditEvent $_ } | Where-Object { $_ }
)
$digest = New-TenuVaultAuditDigest -TenantId $fixture.tenantId -TenantName $fixture.tenantName `
    -Changes $changes -IncludeActor ([bool]$fixture.includeActor) -Service conditionalAccess

Write-Output (ConvertTo-TenuVaultCanonicalJson $digest)
Write-Output (ConvertTo-TenuVaultCanonicalJson (New-TvTeamsPayload $digest))
