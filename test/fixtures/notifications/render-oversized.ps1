<#
.SYNOPSIS
    Parity check: renders the Teams card for every envelope in a JSON file with the default
    layout, one canonical JSON line each, to compare how oversized cards are shortened.
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$EnvelopesPath, [string]$RunbookPath)

$ErrorActionPreference = "Stop"
if (-not $RunbookPath) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
    $RunbookPath = Join-Path $repoRoot "resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1"
}
. $RunbookPath -LibraryOnly

foreach ($envelope in @(Get-Content $EnvelopesPath -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    Write-Output (ConvertTo-TenuVaultCanonicalJson (New-TvTeamsPayload $envelope))
}
