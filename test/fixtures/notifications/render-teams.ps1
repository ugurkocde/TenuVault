<#
.SYNOPSIS
    Parity check: renders the Teams Workflows card for the shared audit digest fixture.

.DESCRIPTION
    Dot sources the watcher runbook with -LibraryOnly, builds the digest of
    audit-digest.json like render-digest.ps1 does, and writes the canonical JSON of
    New-TvTeamsPayload to stdout, so it can be compared with teamsWorkflowsPayload in
    render.ts for the same envelope.
#>
[CmdletBinding()]
param(
    [string]$FixturePath,
    [string]$RunbookPath,
    [string]$Severity
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
# Lets the test cover every severity with the same items.
if ($Severity) { $digest.severity = $Severity }

Write-Output (ConvertTo-TenuVaultCanonicalJson (New-TvTeamsPayload $digest))
